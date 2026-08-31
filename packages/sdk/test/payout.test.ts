import {describe, expect, it} from "vitest";
import {
  estimatePayout,
  formatMultiplier,
  isRefundShaped,
  multiplierX18,
  rewardPool,
  settledPayout,
  burnFee,
  userRoundStatus,
} from "../src/payout.js";
import {formatChangeBps, changeBps, formatEth, formatWethPerPons, ponsUsdX18} from "../src/price.js";
import {Outcome, Phase, Position, RoundStatus} from "../src/types.js";
import type {BetInfo, Round} from "../src/types.js";

const eth = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

function round(over: Partial<Round> = {}): Round {
  return {
    epoch: 1n,
    startTimestamp: 0n,
    lockTimestamp: 0n,
    closeTimestamp: 0n,
    lockPrice: 0n,
    closePrice: 0n,
    totalAmount: 0n,
    bullAmount: 0n,
    bearAmount: 0n,
    rewardBaseAmount: 0n,
    rewardAmount: 0n,
    status: RoundStatus.Settled,
    ...over,
  };
}

describe("payout maths mirrors the contract", () => {
  it("reproduces the brief's worked example exactly", () => {
    const bull = eth("3"), bear = eth("7");
    expect(burnFee(bull + bear, 300)).toBe(eth("0.3"));
    expect(rewardPool(bull, bear, 300)).toBe(eth("9.7"));
    // A 1 ETH bull stake out of a 3 ETH bull pool collects a third of 9.7.
    const bet: BetInfo = {position: Position.Bull, amount: eth("1"), claimed: false};
    const r = round({rewardBaseAmount: bull, rewardAmount: eth("9.7")});
    expect(settledPayout(r, bet, Outcome.Bull)).toBe((eth("1") * eth("9.7")) / bull);
  });

  it("matches the launch tokenomics: 90% to winners, 10% to the burn", () => {
    const bull = eth("3"), bear = eth("7");
    expect(burnFee(bull + bear, 1000)).toBe(eth("1"));
    expect(rewardPool(bull, bear, 1000)).toBe(eth("9"));
  });

  it("offers no multiplier when a side is empty, because such a round refunds", () => {
    expect(multiplierX18(eth("3"), 0n, 300)).toBeNull();
    expect(multiplierX18(0n, eth("3"), 300)).toBeNull();
    expect(rewardPool(eth("3"), 0n, 300)).toBe(0n);
    expect(formatMultiplier(null)).toBe("—");
  });

  it("estimates a payout that includes the caller's own stake in the pool", () => {
    // Entering 1 ETH on a side already holding 3, against 7 on the other.
    const {payout} = estimatePayout(eth("1"), eth("3"), eth("7"), 300);
    const pool = rewardPool(eth("4"), eth("7"), 300);
    expect(payout).toBe((eth("1") * pool) / eth("4"));
    expect(payout).toBeLessThan(eth("11"));
  });

  it("never pays a loser", () => {
    const r = round({rewardBaseAmount: eth("3"), rewardAmount: eth("9.7")});
    const bear: BetInfo = {position: Position.Bear, amount: eth("7"), claimed: false};
    expect(settledPayout(r, bear, Outcome.Bull)).toBe(0n);
  });

  it("treats ties and no-contests as refunds", () => {
    expect(isRefundShaped(round(), Outcome.Tie)).toBe(true);
    expect(isRefundShaped(round(), Outcome.NoContest)).toBe(true);
    expect(isRefundShaped(round(), Outcome.Bull)).toBe(false);
    expect(isRefundShaped(round({status: RoundStatus.Cancelled}), Outcome.Undecided)).toBe(true);
  });

  it("labels a user's entry by what they still need to do", () => {
    const r = round({rewardBaseAmount: eth("3"), rewardAmount: eth("9.7")});
    const winner: BetInfo = {position: Position.Bull, amount: eth("1"), claimed: false};
    expect(userRoundStatus(r, winner, Outcome.Bull, Phase.Settled)).toBe("CLAIMABLE");
    expect(userRoundStatus(r, {...winner, claimed: true}, Outcome.Bull, Phase.Settled)).toBe("CLAIMED");
    const loser: BetInfo = {position: Position.Bear, amount: eth("1"), claimed: false};
    expect(userRoundStatus(r, loser, Outcome.Bull, Phase.Settled)).toBe("LOST");
    const open = round({status: RoundStatus.Locked});
    expect(userRoundStatus(open, winner, Outcome.Undecided, Phase.Live)).toBe("LIVE");
    expect(userRoundStatus(open, winner, Outcome.Undecided, Phase.Cancellable)).toBe("REFUNDABLE");
  });
});

describe("price formatting", () => {
  it("keeps significant digits for a very small price", () => {
    // The live PONS price: 0.000216 WETH. A naive 4dp format would show "0.0002".
    expect(formatWethPerPons(216_141_336_604_821n)).toBe("0.0002161");
    expect(formatWethPerPons(1_400_000_000_000n)).toBe("0.000001400");
  });

  it("computes and renders a change exactly", () => {
    expect(changeBps(1_000n, 1_193n)).toBe(1_930n);
    expect(formatChangeBps(193n)).toBe("+1.93%");
    expect(formatChangeBps(-193n)).toBe("-1.93%");
  });

  it("formats ETH without floats", () => {
    expect(formatEth(eth("1.2345"), 4)).toBe("1.2345");
    expect(formatEth(0n)).toBe("0.0000");
  });

  it("returns no USD figure when there is no ETH/USD source", () => {
    expect(ponsUsdX18(216_141_336_604_821n, null)).toBeNull();
    // 0.00021614 WETH at $4,000/ETH is about $0.8646 per PONS.
    const usd = ponsUsdX18(216_141_336_604_821n, 400_000_000_000n);
    expect(usd).not.toBeNull();
    expect(formatWethPerPons(usd!)).toBe("0.8645");
  });
});

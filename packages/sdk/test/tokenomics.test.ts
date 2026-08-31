import {describe, expect, it} from "vitest";
import {Outcome, deriveOutcome, describeOutcome, splitBurnAllocation} from "../src/index.js";

const round = (o: Partial<Parameters<typeof deriveOutcome>[0]> = {}) => ({
  totalAmount: 10n,
  bullAmount: 3n,
  bearAmount: 7n,
  lockPrice: 100n,
  closePrice: 100n,
  ...o,
});

describe("outcome derivation mirrors the contract", () => {
  it("reads a contested round from the prices", () => {
    expect(deriveOutcome(round({closePrice: 101n}))).toBe(Outcome.Bull);
    expect(deriveOutcome(round({closePrice: 99n}))).toBe(Outcome.Bear);
  });

  it("calls an unmoved price a tie", () => {
    expect(deriveOutcome(round())).toBe(Outcome.Tie);
  });

  it("distinguishes the two one-sided cases, which resolve oppositely", () => {
    // Everyone backed DOWN and the price rose: nobody won, so the pot is burned.
    expect(deriveOutcome(round({bullAmount: 0n, bearAmount: 10n, closePrice: 101n}))).toBe(Outcome.AllLost);
    // Everyone backed UP and the price rose: right, but nothing was won. Refund.
    expect(deriveOutcome(round({bullAmount: 10n, bearAmount: 0n, closePrice: 101n}))).toBe(Outcome.NoContest);
  });

  it("treats an empty round as a no-contest, not a burn", () => {
    expect(deriveOutcome(round({totalAmount: 0n, bullAmount: 0n, bearAmount: 0n, closePrice: 101n}))).toBe(
      Outcome.NoContest
    );
  });
});

describe("labels", () => {
  it("agrees whether given the enum value or the indexer's string", () => {
    expect(describeOutcome(Outcome.AllLost).label).toBe(describeOutcome("ALL_LOST").label);
    expect(describeOutcome(Outcome.AllLost).burnedWholePot).toBe(true);
    expect(describeOutcome(Outcome.NoContest).refunded).toBe(true);
    expect(describeOutcome(null).label).toBe("—");
  });
});

describe("burn split", () => {
  it("matches the contract, remainder included", () => {
    expect(splitBurnAllocation(1000n, 5000)).toEqual({pons: 500n, project: 500n});
    // An odd wei goes to the first target rather than becoming unspendable.
    expect(splitBurnAllocation(3n, 5000)).toEqual({pons: 1n, project: 2n});
  });
});

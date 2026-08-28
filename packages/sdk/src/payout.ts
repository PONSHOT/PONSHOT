import {Outcome, Phase, Position, RoundStatus} from "./types.js";
import type {BetInfo, OutcomeValue, PhaseValue, Round, UserRoundStatus} from "./types.js";

export const BPS_DENOMINATOR = 10_000n;

/**
 * Reproduces the contract's settlement arithmetic exactly, in BigInt.
 *
 * Everything here is integer maths with the same flooring the contract uses, because
 * these numbers are shown to users next to real money. A float would round differently
 * from Solidity and the UI would quietly disagree with the chain by a few wei — which is
 * exactly the kind of discrepancy that destroys trust in a payout screen.
 *
 * These are still *estimates* while a round is open: anybody may enter before it locks
 * and change the pools. Only a settled round's figures are final.
 */

/** Fee the contract will book on a round with both sides staked. */
export function burnFee(totalAmount: bigint, feeBps: number | bigint): bigint {
  return (totalAmount * BigInt(feeBps)) / BPS_DENOMINATOR;
}

/**
 * Pool distributable to the winning side.
 *
 * Returns 0 for a round that cannot pay out — one where a side attracted no stake.
 * Either nobody took the other side, in which case the contract refunds in full rather
 * than raking a bettor's own money (`NoContest`), or every entry was on the losing side,
 * in which case the whole pot funds the buyback and burn (`AllLost`). Neither pays a
 * winner, so a UI showing a multiplier here would promise winnings that cannot exist.
 */
export function rewardPool(bullAmount: bigint, bearAmount: bigint, feeBps: number | bigint): bigint {
  if (bullAmount === 0n || bearAmount === 0n) return 0n;
  const total = bullAmount + bearAmount;
  return total - burnFee(total, feeBps);
}

/**
 * Payout multiplier for one side, scaled by 1e18 so it stays exact.
 *
 * Returns null when no multiplier is meaningful yet: an empty side has no denominator,
 * and an empty opposing side means the round would refund rather than pay.
 */
export function multiplierX18(side: bigint, other: bigint, feeBps: number | bigint): bigint | null {
  if (side === 0n || other === 0n) return null;
  return (rewardPool(side, other, feeBps) * 10n ** 18n) / side;
}

/** Human-readable multiplier, e.g. 2.14. Formatting only — never used for a payout. */
export function formatMultiplier(x18: bigint | null, decimals = 2): string {
  if (x18 === null) return "—";
  const scale = 10n ** BigInt(decimals);
  const scaled = (x18 * scale) / 10n ** 18n;
  return `${scaled / scale}.${(scaled % scale).toString().padStart(decimals, "0")}`;
}

/** What `stake` would collect if this side won, with the pools as they now stand. */
export function estimatePayout(
  stake: bigint,
  side: bigint,
  other: bigint,
  feeBps: number | bigint
): {payout: bigint; multiplierX18: bigint | null} {
  const newSide = side + stake;
  const pool = rewardPool(newSide, other, feeBps);
  if (pool === 0n || newSide === 0n) return {payout: stake, multiplierX18: null};
  return {payout: (stake * pool) / newSide, multiplierX18: (pool * 10n ** 18n) / newSide};
}

/** Settled-round payout. Matches `PonsPrediction._entitlement` including its flooring. */
export function settledPayout(round: Round, bet: BetInfo, outcome: OutcomeValue): bigint {
  if (round.rewardBaseAmount === 0n) return 0n;
  const won =
    (outcome === Outcome.Bull && bet.position === Position.Bull) ||
    (outcome === Outcome.Bear && bet.position === Position.Bear);
  if (!won) return 0n;
  return (bet.amount * round.rewardAmount) / round.rewardBaseAmount;
}

/** True when the round resolves to "everyone takes their stake back". */
export function isRefundShaped(round: Round, outcome: OutcomeValue): boolean {
  if (round.status === RoundStatus.Cancelled) return true;
  return round.status === RoundStatus.Settled && (outcome === Outcome.Tie || outcome === Outcome.NoContest);
}

/**
 * The label a user's own entry should carry.
 *
 * Deliberately distinguishes CLAIMABLE from WON and REFUNDABLE from REFUNDED, because
 * the difference is whether the user still has to do something.
 */
export function userRoundStatus(
  round: Round,
  bet: BetInfo,
  outcome: OutcomeValue,
  phase: PhaseValue
): UserRoundStatus {
  if (bet.amount === 0n) return "PENDING";
  if (round.status === RoundStatus.Cancelled) return bet.claimed ? "REFUNDED" : "REFUNDABLE";
  if (phase === Phase.Cancellable) return "REFUNDABLE";
  if (round.status !== RoundStatus.Settled) return "LIVE";
  if (isRefundShaped(round, outcome)) return bet.claimed ? "REFUNDED" : "REFUNDABLE";
  const payout = settledPayout(round, bet, outcome);
  if (payout === 0n) return "LOST";
  return bet.claimed ? "CLAIMED" : "CLAIMABLE";
}

import {Outcome, type OutcomeValue} from "./types.js";

/**
 * How a settled round resolved, in the words a user should see.
 *
 * Lives in the SDK rather than in each app because the API renders outcomes as strings
 * and the web app reads them as enum values off the chain. Two independent label tables
 * is how "No contest — refunded" ends up next to "Lost" for the same round.
 */
export type OutcomeDescription = {
  /** Short label for a badge. */
  label: string;
  /** One line explaining what happened to the money. */
  detail: string;
  /** True when every entrant gets their stake back. */
  refunded: boolean;
  /** True when the whole pot funded the buyback and burn. */
  burnedWholePot: boolean;
};

const BY_NAME: Record<string, OutcomeDescription> = {
  BULL: {label: "UP", detail: "Up entries shared the pot.", refunded: false, burnedWholePot: false},
  BEAR: {label: "DOWN", detail: "Down entries shared the pot.", refunded: false, burnedWholePot: false},
  TIE: {
    label: "Tie — refunded",
    detail: "The price did not move, so every entry was returned in full.",
    refunded: true,
    burnedWholePot: false,
  },
  NO_CONTEST: {
    label: "No contest — refunded",
    detail: "Nobody took the other side, so nothing was won and every entry was returned in full.",
    refunded: true,
    burnedWholePot: false,
  },
  ALL_LOST: {
    label: "No winners — pot burned",
    detail: "Every entry was on the losing side, so the whole pot bought and burned tokens.",
    refunded: false,
    burnedWholePot: true,
  },
  CANCELLED: {
    label: "Cancelled — refunded",
    detail: "The round could not be priced within tolerance, so every entry was returned in full.",
    refunded: true,
    burnedWholePot: false,
  },
};

const BY_VALUE: Record<number, string> = {
  [Outcome.Bull]: "BULL",
  [Outcome.Bear]: "BEAR",
  [Outcome.Tie]: "TIE",
  [Outcome.NoContest]: "NO_CONTEST",
  [Outcome.AllLost]: "ALL_LOST",
};

const UNDECIDED: OutcomeDescription = {
  label: "—",
  detail: "Not settled yet.",
  refunded: false,
  burnedWholePot: false,
};

/** Accepts either the on-chain enum value or the indexer's string form. */
export function describeOutcome(outcome: OutcomeValue | string | null | undefined): OutcomeDescription {
  if (outcome === null || outcome === undefined) return UNDECIDED;
  const name = typeof outcome === "string" ? outcome : BY_VALUE[outcome];
  return BY_NAME[name ?? ""] ?? UNDECIDED;
}

/**
 * Splits a burn allocation between the two buyback targets.
 *
 * Mirrors `PonsBuybackBurner.receive()`, remainder included: an odd wei goes to the first
 * target rather than becoming unspendable dust, so a UI that recomputed the split naively
 * would be off by a wei against the chain.
 */
export function splitBurnAllocation(amount: bigint, sharePonsBps: number | bigint): {pons: bigint; project: bigint} {
  const pons = (amount * BigInt(sharePonsBps)) / 10_000n;
  return {pons, project: amount - pons};
}

/**
 * Derives a settled round's outcome from the round alone.
 *
 * Mirrors `PonsPrediction._trySettle`. It exists because `getVisibleRounds` returns
 * `Round` without `RoundTerms`, and a UI that guessed from `rewardBaseAmount === 0` would
 * label a round where every entry lost as "refunded" — the opposite of what happened to
 * the money. Deriving it here keeps that logic in one tested place instead of inline in
 * a component.
 *
 * Only meaningful for a settled round; callers should check status first.
 */
export function deriveOutcome(round: {
  totalAmount: bigint;
  bullAmount: bigint;
  bearAmount: bigint;
  lockPrice: bigint;
  closePrice: bigint;
}): OutcomeValue {
  if (round.totalAmount === 0n) return Outcome.NoContest;
  if (round.closePrice === round.lockPrice) return Outcome.Tie;
  const bullWins = round.closePrice > round.lockPrice;
  const winning = bullWins ? round.bullAmount : round.bearAmount;
  const losing = bullWins ? round.bearAmount : round.bullAmount;
  if (winning === 0n) return Outcome.AllLost;
  if (losing === 0n) return Outcome.NoContest;
  return bullWins ? Outcome.Bull : Outcome.Bear;
}

import type {Address, Hex} from "viem";

/** Mirrors `IPonsPredictionTypes.Position`. */
export const Position = {Bull: 0, Bear: 1} as const;
export type PositionValue = (typeof Position)[keyof typeof Position];

/** Mirrors `IPonsPredictionTypes.RoundStatus` — the *stored* status. */
export const RoundStatus = {Pending: 0, Open: 1, Locked: 2, Settled: 3, Cancelled: 4} as const;
export type RoundStatusValue = (typeof RoundStatus)[keyof typeof RoundStatus];

/** Mirrors `IPonsPredictionTypes.Outcome`. */
export const Outcome = {Undecided: 0, Bull: 1, Bear: 2, Tie: 3, NoContest: 4} as const;
export type OutcomeValue = (typeof Outcome)[keyof typeof Outcome];

/**
 * Mirrors `IPonsPredictionTypes.Phase` — the *derived* phase, which is what a UI should
 * render. It distinguishes states the stored status deliberately does not, in particular
 * "entries are closed but no price is available yet" (`AwaitingLock`).
 */
export const Phase = {
  Pending: 0,
  Open: 1,
  AwaitingLock: 2,
  Live: 3,
  AwaitingSettle: 4,
  Settled: 5,
  Cancelled: 6,
  Cancellable: 7,
} as const;
export type PhaseValue = (typeof Phase)[keyof typeof Phase];

export const PHASE_LABEL: Record<PhaseValue, string> = {
  [Phase.Pending]: "Not started",
  [Phase.Open]: "Taking entries",
  [Phase.AwaitingLock]: "Awaiting lock price",
  [Phase.Live]: "Live",
  [Phase.AwaitingSettle]: "Awaiting close price",
  [Phase.Settled]: "Settled",
  [Phase.Cancelled]: "Cancelled",
  [Phase.Cancellable]: "Stuck — refundable",
};

export interface Round {
  epoch: bigint;
  startTimestamp: bigint;
  lockTimestamp: bigint;
  closeTimestamp: bigint;
  lockPrice: bigint;
  closePrice: bigint;
  totalAmount: bigint;
  bullAmount: bigint;
  bearAmount: bigint;
  rewardBaseAmount: bigint;
  rewardAmount: bigint;
  status: number;
}

export interface RoundTerms {
  oracle: Address;
  twapWindow: number;
  treasuryFeeBps: number;
  oracleVersion: bigint;
  lockTick: number;
  closeTick: number;
  lockedAt: bigint;
  settledAt: bigint;
  outcome: number;
}

export interface BetInfo {
  position: number;
  amount: bigint;
  claimed: boolean;
}

/** How a user's entry in one round should be presented. */
export type UserRoundStatus =
  | "LIVE"
  | "PENDING"
  | "WON"
  | "LOST"
  | "CLAIMABLE"
  | "CLAIMED"
  | "REFUNDED"
  | "REFUNDABLE"
  | "CANCELLED";

export interface TxRef {
  hash: Hex;
  explorerUrl: string;
}

"use client";

import {useQuery} from "@tanstack/react-query";
import {API_BASE} from "./deployment";

/**
 * Read-model access.
 *
 * The API serves history and aggregates — things that would be slow or impossible to
 * assemble from chain reads in a browser. Anything a user is about to transact against
 * is read from the chain instead, so a lagging indexer can never put a stale number in
 * front of a signature.
 */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {headers: {accept: "application/json"}});
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {error?: string};
    throw new Error(body.error ?? `request failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface ApiRound {
  epoch: string;
  startTimestamp: number;
  lockTimestamp: number;
  closeTimestamp: number;
  lockPrice: string | null;
  closePrice: string | null;
  lockedAt: number | null;
  settledAt: number | null;
  totalAmount: string;
  bullAmount: string;
  bearAmount: string;
  rewardAmount: string;
  burnFee: string;
  status: string;
  outcome: string | null;
  cancelReason: string | null;
}

export function useHistory(limit = 50) {
  return useQuery({
    queryKey: ["history", limit],
    queryFn: () => get<{rounds: ApiRound[]}>(`/prediction/history?limit=${limit}`),
    refetchInterval: 20_000,
    retry: 1,
  });
}

export interface ApiStats extends Record<string, unknown> {
  total_rounds: string;
  settled_rounds: string;
  cancelled_rounds: string;
  total_predictions: string;
  unique_wallets: string;
  total_volume: string;
  bull_volume: string;
  bear_volume: string;
  total_paid_to_winners: string;
  total_refunded: string;
  burn_fees_accrued: string;
  bull_wins: string;
  bear_wins: string;
  ties: string;
  no_contests: string;
  all_lost_rounds: string;
  all_lost_burned: string;
  current_round_volume: string;
  oracle_settlement_lag: Array<{kind: string; samples: string; avg_lag_seconds: string; max_lag_seconds: string}>;
}

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => get<ApiStats>("/prediction/stats"),
    refetchInterval: 30_000,
    retry: 1,
  });
}

export interface BurnTarget {
  name: string;
  index: number;
  token: string;
  pool: string;
  shareBps: number;
  configured: boolean;
  allocated: string;
  burns: number;
  ethSpent: string;
  tokensBurned: string;
  lastBurnAt: string | null;
}

export interface BurnStats {
  configured: boolean;
  note?: string;
  burner?: string;
  pendingInMarket?: string;
  targets?: BurnTarget[];
}

export function useBurn() {
  return useQuery({
    queryKey: ["burn"],
    queryFn: () => get<BurnStats>("/burn"),
    refetchInterval: 30_000,
    retry: 1,
  });
}

export interface OracleHealth {
  description: string;
  defaultTwapWindow: number;
  poolLiquidity: string;
  observations: {
    index: number;
    cardinality: number;
    cardinalityNext: number;
    oldest: number;
    newest: number;
    historySpanSeconds: number;
    secondsSinceLastObservation: number;
  };
}

export function useOracleHealth() {
  return useQuery({
    queryKey: ["oracle-health"],
    queryFn: () => get<OracleHealth>("/oracle/pons"),
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useApiHealth() {
  return useQuery({
    queryKey: ["api-health"],
    queryFn: () => get<{ok: boolean; headBlock: number | null; indexedBlock: number; indexerLagBlocks: number | null}>("/health"),
    refetchInterval: 15_000,
    retry: 1,
  });
}

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  samples: number;
}

/** Candles refresh on the chart's own cadence: a 1m chart gains a bar every minute. */
export function useCandles(interval: string, limit = 120) {
  return useQuery({
    queryKey: ["candles", interval, limit],
    queryFn: () => get<{candles: Candle[]; intervalSeconds: number}>(`/price/candles?interval=${interval}&limit=${limit}`),
    refetchInterval: 5_000,
    retry: 1,
  });
}

export interface LeaderboardEntry {
  rank: number;
  account: string;
  roundsPlayed: number;
  roundsWon: number;
  roundsDecided: number;
  accuracyBps: number | null;
  staked: string;
  collected: string;
  netProfit: string;
  biggestWin: string;
}

export function useLeaderboard(window: string = "all", limit = 25) {
  return useQuery({
    queryKey: ["leaderboard", window, limit],
    queryFn: () => get<{entries: LeaderboardEntry[]; window: string}>(`/leaderboard?window=${window}&limit=${limit}`),
    refetchInterval: 20_000,
    retry: 1,
  });
}

export interface Trade {
  epoch: string;
  account: string;
  position: "BULL" | "BEAR";
  amount: string;
  tx_hash: string;
  block_time: string | null;
  lock_price: string | null;
  status: string;
  outcome: string | null;
}

export function useTrades(limit = 30) {
  return useQuery({
    queryKey: ["trades", limit],
    queryFn: () => get<{trades: Trade[]}>(`/prediction/trades?limit=${limit}`),
    refetchInterval: 6_000,
    retry: 1,
  });
}

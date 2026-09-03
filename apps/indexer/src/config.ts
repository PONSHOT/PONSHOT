import {readFileSync} from "node:fs";
import {ROBINHOOD_CHAIN_ID, robinhood} from "@pons/config";
import type {Address} from "viem";

export interface IndexerConfig {
  chainId: number;
  rpcUrls: string[];
  databaseUrl: string;
  prediction: Address;
  oracle: Address;
  pons: Address;
  weth: Address;
  pool: Address;
  startBlock: bigint;
  /** How many blocks to leave unindexed, as reorg protection. */
  confirmations: bigint;
  /** Log-range width per request. */
  batchSize: bigint;
  pollIntervalMs: number;
  healthPort: number;
}

const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

export function loadConfig(): IndexerConfig {
  const chainId = num("CHAIN_ID", ROBINHOOD_CHAIN_ID);
  const path = process.env.DEPLOYMENTS_PATH ?? `${process.cwd()}/../../deployments/${chainId}.json`;
  let d: Record<string, string | number>;
  try {
    d = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`no deployment for chain ${chainId} at ${path}`, {cause: err});
  }

  return {
    chainId,
    rpcUrls: (process.env.RPC_URLS ?? robinhood.rpcUrls.default.http.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://pons:pons@127.0.0.1:5432/pons",
    prediction: d.PonsPrediction as Address,
    oracle: d.PonsOracleAdapter as Address,
    pons: d.PONS as Address,
    weth: d.WETH as Address,
    pool: d.PONSWETHPool as Address,
    startBlock: BigInt(process.env.START_BLOCK ?? d.deployedAtBlock ?? 0),
    // Robinhood Chain makes a block roughly every 100ms, so 32 blocks is a few seconds.
    // Cheap insurance against reading a log that a short reorg then removes.
    confirmations: BigInt(num("CONFIRMATIONS", 32)),
    // Kept modest because a 100ms chain produces blocks fast and public RPCs cap
    // `eth_getLogs` ranges; the indexer catches up by iterating, not by asking for more.
    batchSize: BigInt(num("BATCH_SIZE", 5_000)),
    pollIntervalMs: num("POLL_INTERVAL_MS", 2_000),
    healthPort: num("HEALTH_PORT", 8788),
  };
}

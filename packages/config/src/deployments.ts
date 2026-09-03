import type {Address} from "viem";
import {ROBINHOOD_CHAIN_ID} from "./robinhood.js";

export interface Deployment {
  readonly chainId: number;
  readonly PonsPrediction: Address;
  readonly PonsOracleAdapter: Address;
  readonly PONS: Address;
  readonly WETH: Address;
  readonly PONSWETHPool: Address;
  readonly deployedAtBlock?: number;
  readonly deployedAt?: string;
}

/**
 * Loaded from `deployments/<chainId>.json`, which the Foundry deploy script writes.
 * Addresses are never hand-copied into app code; if a chain has no deployment file,
 * callers get `undefined` and are expected to say so rather than fall back silently.
 */
export function loadDeployment(chainId: number, files: Record<string, Deployment>): Deployment | undefined {
  return files[String(chainId)];
}

export const DEFAULT_CHAIN_ID = ROBINHOOD_CHAIN_ID;

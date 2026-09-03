import type {Address} from "viem";

/**
 * Where the app gets its addresses.
 *
 * Read from build-time environment, which the deploy pipeline fills from
 * `deployments/<chainId>.json`. Nothing is hard-coded per environment, and a missing
 * deployment is surfaced to the user rather than silently falling back to a stale
 * address — pointing a UI at the wrong market is worse than showing an error.
 */
export interface Deployment {
  chainId: number;
  prediction: Address;
  oracle: Address;
  pons: Address;
  weth: Address;
  pool: Address;
}

export function getDeployment(): Deployment | null {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "");
  const prediction = process.env.NEXT_PUBLIC_PREDICTION_ADDRESS as Address | undefined;
  const oracle = process.env.NEXT_PUBLIC_ORACLE_ADDRESS as Address | undefined;
  if (!chainId || !prediction || !oracle) return null;
  return {
    chainId,
    prediction,
    oracle,
    pons: (process.env.NEXT_PUBLIC_PONS_ADDRESS ?? "0x") as Address,
    weth: (process.env.NEXT_PUBLIC_WETH_ADDRESS ?? "0x") as Address,
    pool: (process.env.NEXT_PUBLIC_POOL_ADDRESS ?? "0x") as Address,
  };
}

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8789";

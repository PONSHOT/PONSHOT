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
  /** Present once buyback-and-burn is deployed. */
  burner: Address | null;
  /**
   * A market this one replaced.
   *
   * Claims are pull-based and permanent, so a retired market keeps owing its users
   * indefinitely. Keeping the address here is what lets the app still offer them a claim
   * button; dropping it is how that money becomes unreachable in practice even though
   * the contract would still pay.
   */
  legacyPrediction: Address | null;
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
    burner: (process.env.NEXT_PUBLIC_BURNER_ADDRESS as Address | undefined) ?? null,
    legacyPrediction: (process.env.NEXT_PUBLIC_LEGACY_PREDICTION_ADDRESS as Address | undefined) ?? null,
  };
}

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8789";

import type {Address} from "viem";

import addresses from "../addresses.json" with {type: "json"};

/** A token as it actually exists on chain, decimals included. */
export interface TokenInfo {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The PONS market, exactly as verified on chain 4663 on 2026-09-03.
 *
 * The two facts here most likely to be assumed wrongly, and therefore stated
 * explicitly and asserted in tests:
 *
 *  - `token0` is **WETH**, `token1` is **PONS**. PONS is *not* token0.
 *  - Because PONS is token1, the quoted PONS/WETH price *decreases* as the tick rises.
 */
export const PONS: TokenInfo = {
  address: addresses.PONS as Address,
  symbol: "PONS",
  decimals: 18,
};

export const WETH: TokenInfo = {
  address: addresses.WETH as Address,
  symbol: "WETH",
  decimals: 18,
};

export interface PoolInfo {
  readonly address: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly token0: Address;
  readonly token1: Address;
  readonly ponsIsToken0: boolean;
}

/** The settlement pool: Uniswap V3 1%, the deepest PONS/WETH market and the one PONS's own `liquidityPool()` names. */
export const PONS_WETH_POOL: PoolInfo = {
  address: addresses.PONS_WETH_POOL_10000 as Address,
  fee: addresses.poolFee,
  tickSpacing: addresses.poolTickSpacing,
  token0: WETH.address,
  token1: PONS.address,
  ponsIsToken0: addresses.ponsIsToken0,
};

/**
 * The other live PONS/WETH pool (0.3%). Not a price source — it is recorded because
 * it matters to the manipulation model: liquidity is split across two venues, and an
 * attacker who moves only the settlement pool faces arbitrage from this one.
 * Its observation buffer is far smaller (1,400 vs 20,000), so it is also a poorer oracle.
 */
export const PONS_WETH_POOL_3000: PoolInfo = {
  address: addresses.PONS_WETH_POOL_3000 as Address,
  fee: 3_000,
  tickSpacing: 60,
  token0: WETH.address,
  token1: PONS.address,
  ponsIsToken0: false,
};

export const UNISWAP_V3_FACTORY = addresses.UNISWAP_V3_FACTORY as Address;
export const UNISWAP_V3_POSITION_MANAGER = addresses.UNISWAP_V3_POSITION_MANAGER as Address;

/** Canonical Uniswap V3 pool init-code hash. The live pool's address reproduces from it, which is how we know the pool is stock v3-core. */
export const UNISWAP_V3_POOL_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54" as const;

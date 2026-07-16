import {readFileSync} from "node:fs";
import {ROBINHOOD_CHAIN_ID, robinhood} from "@pons/config";
import type {Address, Hex} from "viem";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env var ${name} is not a number: ${v}`);
  return n;
}

export interface KeeperConfig {
  chainId: number;
  rpcUrls: string[];
  privateKey: Hex;
  prediction: Address;
  oracle: Address;
  /** Zero when the deployment has no burner; the keeper then skips buyback work. */
  burner: Address;
  /**
   * Minimum allocation before the keeper executes a buyback.
   *
   * A buyback of a few thousand wei costs more gas than it burns. The floor is not a
   * safety property — anyone may call `buyAndBurn` at any size — only a decision about
   * when it is worth the keeper's gas.
   */
  minBuybackWei: bigint;
  /** How often to look for work. Rounds are minutes long, so this need not be aggressive. */
  pollIntervalMs: number;
  /** Blocks to wait before treating a transaction as final. */
  confirmations: number;
  /** How long to wait for a transaction before replacing it with a higher fee. */
  txTimeoutMs: number;
  /** Multiplier applied when replacing a stuck transaction, in percent. */
  replacementBumpPercent: number;
  maxAttempts: number;
  /** Refuse to send when the operator's balance drops below this, so it fails loudly. */
  minBalanceWei: bigint;
  statePath: string;
  redisUrl?: string;
  lockKey: string;
  lockTtlMs: number;
  healthPort: number;
  dryRun: boolean;
}

/** Resolves the deployed addresses from `deployments/<chainId>.json` rather than env, so
 *  the keeper cannot be pointed at an address nothing else in the system knows about. */
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function addressesFor(chainId: number): {prediction: Address; oracle: Address; burner: Address} {
  const explicitPrediction = process.env.PREDICTION_ADDRESS as Address | undefined;
  const explicitOracle = process.env.ORACLE_ADDRESS as Address | undefined;
  const explicitBurner = (process.env.BURNER_ADDRESS as Address | undefined) ?? ZERO;
  if (explicitPrediction && explicitOracle) {
    return {prediction: explicitPrediction, oracle: explicitOracle, burner: explicitBurner};
  }

  const path = process.env.DEPLOYMENTS_PATH ?? `${process.cwd()}/../../deployments/${chainId}.json`;
  try {
    const d = JSON.parse(readFileSync(path, "utf8"));
    return {
      prediction: d.PonsPrediction as Address,
      oracle: d.PonsOracleAdapter as Address,
      burner: (d.PonsBuybackBurner as Address) ?? ZERO,
    };
  } catch (err) {
    throw new Error(
      `no deployment found for chain ${chainId} at ${path}; set PREDICTION_ADDRESS and ORACLE_ADDRESS explicitly`,
      {cause: err}
    );
  }
}

/**
 * Well-known development keys.
 *
 * Anvil and Hardhat ship the same handful of funded accounts, their keys are printed on
 * every start and are public knowledge. They appear legitimately throughout this repo's
 * local tooling, which is exactly the risk: a copied command or a stale `.env` is all it
 * takes for one to reach a real network, where anyone watching can drain and impersonate
 * it instantly. Refusing outright is the only reliable stop.
 */
const WELL_KNOWN_DEV_KEYS = new Set(
  [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  ].map((k) => k.toLowerCase())
);

/** Chain ids that are unambiguously local development networks. */
const LOCAL_CHAIN_IDS = new Set([31337, 1337]);

export function loadConfig(): KeeperConfig {
  const chainId = num("CHAIN_ID", ROBINHOOD_CHAIN_ID);
  const rpcUrls = (process.env.RPC_URLS ?? robinhood.rpcUrls.default.http.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (rpcUrls.length === 0) throw new Error("no RPC URLs configured");

  const {prediction, oracle, burner} = addressesFor(chainId);

  const privateKey = required("KEEPER_PRIVATE_KEY");
  if (WELL_KNOWN_DEV_KEYS.has(privateKey.toLowerCase()) && !LOCAL_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `refusing to start: KEEPER_PRIVATE_KEY is a well-known development key and chain ${chainId} is not a ` +
        "local devnet. Its private key is public, so anyone could drain the operator and impersonate the keeper. " +
        "Generate a dedicated key for this deployment."
    );
  }

  return {
    chainId,
    rpcUrls,
    privateKey: privateKey as Hex,
    prediction,
    oracle,
    burner,
    minBuybackWei: BigInt(process.env.MIN_BUYBACK_WEI ?? "1000000000000000"), // 0.001 ETH
    pollIntervalMs: num("POLL_INTERVAL_MS", 5_000),
    // Robinhood Chain produces a block roughly every 100ms, so a handful of blocks is
    // still sub-second. Waiting for more costs nothing and removes reorg anxiety.
    confirmations: num("CONFIRMATIONS", 12),
    txTimeoutMs: num("TX_TIMEOUT_MS", 30_000),
    replacementBumpPercent: num("REPLACEMENT_BUMP_PERCENT", 25),
    maxAttempts: num("MAX_ATTEMPTS", 5),
    minBalanceWei: BigInt(process.env.MIN_BALANCE_WEI ?? "10000000000000000"), // 0.01 ETH
    statePath: process.env.STATE_PATH ?? `${process.cwd()}/.keeper-state.json`,
    redisUrl: process.env.REDIS_URL,
    lockKey: process.env.LOCK_KEY ?? `pons-keeper:${chainId}:${prediction.toLowerCase()}`,
    lockTtlMs: num("LOCK_TTL_MS", 30_000),
    healthPort: num("HEALTH_PORT", 8787),
    dryRun: process.env.DRY_RUN === "true",
  };
}

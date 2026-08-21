import {PonsBuybackBurnerAbi, PonsPredictionAbi, UniswapV3PonsOracleAbi} from "./abis/index.js";
import type {BetInfo, Round, RoundTerms} from "./types.js";
import type {Address, PublicClient, WalletClient} from "viem";

/**
 * Thin read/write layer over viem.
 *
 * Reads are batched into multicalls where the contract allows it, because the UI polls
 * these on every tick and a chain with ~10 blocks per second punishes chatty clients.
 */
export interface MarketRefs {
  prediction: Address;
  oracle: Address;
}

/** Reads for the buyback-and-burn contract. Separate because it is separately deployed. */
export function burnerReads(burner: Address) {
  const b = {address: burner, abi: PonsBuybackBurnerAbi} as const;
  return {
    target: (index: number) => ({...b, functionName: "target", args: [index]}) as const,
    allocated: (index: number) => ({...b, functionName: "allocated", args: [BigInt(index)]}) as const,
    totalSpent: (index: number) => ({...b, functionName: "totalSpent", args: [BigInt(index)]}) as const,
    totalBurned: (index: number) => ({...b, functionName: "totalBurned", args: [BigInt(index)]}) as const,
  };
}

export function marketReads(refs: MarketRefs) {
  const p = {address: refs.prediction, abi: PonsPredictionAbi} as const;
  const o = {address: refs.oracle, abi: UniswapV3PonsOracleAbi} as const;
  return {
    round: (epoch: bigint) => ({...p, functionName: "getRound", args: [epoch]}) as const,
    terms: (epoch: bigint) => ({...p, functionName: "getRoundTerms", args: [epoch]}) as const,
    bet: (epoch: bigint, account: Address) => ({...p, functionName: "getBet", args: [epoch, account]}) as const,
    phase: (epoch: bigint) => ({...p, functionName: "phaseOf", args: [epoch]}) as const,
    currentEpoch: () => ({...p, functionName: "currentEpoch"}) as const,
    visibleRounds: () => ({...p, functionName: "getVisibleRounds"}) as const,
    claimable: (epoch: bigint, account: Address) =>
      ({...p, functionName: "claimable", args: [epoch, account]}) as const,
    refundable: (epoch: bigint, account: Address) =>
      ({...p, functionName: "refundable", args: [epoch, account]}) as const,
    pendingWork: () => ({...p, functionName: "pendingWork"}) as const,
    solvency: () => ({...p, functionName: "solvency"}) as const,
    burnAllocated: () => ({...p, functionName: "burnAllocated"}) as const,
    totalLiabilities: () => ({...p, functionName: "totalLiabilities"}) as const,
    minimumBet: () => ({...p, functionName: "minimumBet"}) as const,
    maximumBet: () => ({...p, functionName: "maximumBet"}) as const,
    maximumRoundPool: () => ({...p, functionName: "maximumRoundPool"}) as const,
    burnFeeBps: () => ({...p, functionName: "burnFeeBps"}) as const,
    interval: () => ({...p, functionName: "interval"}) as const,
    bufferSeconds: () => ({...p, functionName: "bufferSeconds"}) as const,
    paused: () => ({...p, functionName: "paused"}) as const,
    userEpochs: (account: Address, offset: bigint, limit: bigint) =>
      ({...p, functionName: "getUserEpochs", args: [account, offset, limit]}) as const,
    oracleSpot: () => ({...o, functionName: "getSpotPrice"}) as const,
    oracleTwap: () => ({...o, functionName: "getPrice"}) as const,
    oracleObservations: () => ({...o, functionName: "observationState"}) as const,
    oraclePoolLiquidity: () => ({...o, functionName: "poolLiquidity"}) as const,
    oracleCanQuote: (instant: bigint, window: number) =>
      ({...o, functionName: "canQuote", args: [instant, window]}) as const,
  };
}

/** The three-card view the main screen renders, fetched in one multicall. */
export async function fetchVisibleRounds(
  client: PublicClient,
  refs: MarketRefs
): Promise<{previous: Round; live: Round; next: Round}> {
  const [previous, live, next] = (await client.readContract({
    address: refs.prediction,
    abi: PonsPredictionAbi,
    functionName: "getVisibleRounds",
  })) as unknown as [Round, Round, Round];
  return {previous, live, next};
}

export async function fetchRoundBundle(
  client: PublicClient,
  refs: MarketRefs,
  epoch: bigint,
  account?: Address
): Promise<{round: Round; terms: RoundTerms; phase: number; bet?: BetInfo}> {
  const r = marketReads(refs);
  const calls: unknown[] = [r.round(epoch), r.terms(epoch), r.phase(epoch)];
  if (account) calls.push(r.bet(epoch, account));
  const results = (await client.multicall({
    contracts: calls as never,
    allowFailure: false,
  })) as unknown as [Round, RoundTerms, number, BetInfo?];
  return {round: results[0], terms: results[1], phase: results[2], bet: results[3]};
}

export interface EnterArgs {
  refs: MarketRefs;
  epoch: bigint;
  bull: boolean;
  value: bigint;
  account: Address;
}

/** Places an entry. Callers are expected to wait for a receipt before claiming success. */
export async function enterRound(wallet: WalletClient, args: EnterArgs) {
  return wallet.writeContract({
    address: args.refs.prediction,
    abi: PonsPredictionAbi,
    functionName: args.bull ? "betBull" : "betBear",
    args: [args.epoch],
    value: args.value,
    account: args.account,
    chain: wallet.chain ?? null,
  });
}

export async function claimEpochs(wallet: WalletClient, refs: MarketRefs, epochs: bigint[], account: Address) {
  return wallet.writeContract({
    address: refs.prediction,
    abi: PonsPredictionAbi,
    functionName: "claim",
    args: [epochs],
    account,
    chain: wallet.chain ?? null,
  });
}

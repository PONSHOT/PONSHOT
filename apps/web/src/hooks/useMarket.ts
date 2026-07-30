"use client";

import {PonsPredictionAbi, UniswapV3PonsOracleAbi, MarketAbiWithLegacy} from "@pons/sdk";
import type {BetInfo, Round, RoundTerms} from "@pons/sdk";
import {useQuery} from "@tanstack/react-query";
import {useAccount, useReadContract, useReadContracts} from "wagmi";
import {getDeployment} from "@/lib/deployment";

/**
 * Chain reads for the market.
 *
 * Everything a user acts on is read from the chain, not from the API. The API is a
 * convenience for history and aggregates; a stale round or pool figure would put a
 * misleading multiplier in front of someone about to stake real money.
 *
 * Poll intervals are deliberately modest despite ~100ms blocks: rounds are minutes long,
 * so a one-second refresh would multiply RPC load for no visible benefit.
 */
export function useDeployment() {
  return getDeployment();
}

const REFRESH_MS = 4_000;

export function useVisibleRounds() {
  const d = getDeployment();
  return useReadContract({
    address: d?.prediction,
    abi: PonsPredictionAbi,
    functionName: "getVisibleRounds",
    query: {enabled: Boolean(d), refetchInterval: REFRESH_MS},
  });
}

/** Market-wide parameters, fetched together because the modal needs all of them at once. */
export function useMarketParams() {
  const d = getDeployment();
  // The legacy fragments are included so this works against a market deployed before the
  // fee was renamed. A multicall entry for a function the contract does not have fails on
  // its own; the rest of the batch still returns, which is why both names can be asked
  // for and whichever answers is used.
  const base = {address: d?.prediction, abi: MarketAbiWithLegacy} as const;
  const result = useReadContracts({
    contracts: [
      {...base, functionName: "currentEpoch"},
      {...base, functionName: "burnFeeBps"},
      {...base, functionName: "treasuryFeeBps"},
      {...base, functionName: "minimumBet"},
      {...base, functionName: "maximumBet"},
      {...base, functionName: "maximumRoundPool"},
      {...base, functionName: "paused"},
      {...base, functionName: "interval"},
      {...base, functionName: "bufferSeconds"},
    ],
    query: {enabled: Boolean(d), refetchInterval: 15_000},
  });

  const [epoch, fee, legacyFee, min, max, pool, paused, interval, buffer] = result.data ?? [];
  return {
    ...result,
    params: {
      currentEpoch: epoch?.result as bigint | undefined,
      burnFeeBps: Number(fee?.result ?? legacyFee?.result ?? 0),
      minimumBet: (min?.result as bigint | undefined) ?? 0n,
      maximumBet: (max?.result as bigint | undefined) ?? 0n,
      maximumRoundPool: (pool?.result as bigint | undefined) ?? 0n,
      paused: Boolean(paused?.result),
      interval: Number(interval?.result ?? 0),
      bufferSeconds: Number(buffer?.result ?? 0),
    },
  };
}

/**
 * Both PONS prices.
 *
 * Fetched and surfaced together on purpose: the UI must always be able to show which
 * number settles rounds next to the one that merely moves fastest.
 */
export function usePonsPrice() {
  const d = getDeployment();
  const result = useReadContracts({
    contracts: [
      {address: d?.oracle, abi: UniswapV3PonsOracleAbi, functionName: "getSpotPrice"},
      {address: d?.oracle, abi: UniswapV3PonsOracleAbi, functionName: "getPrice"},
      // Read rather than assumed: the window is configurable, and a header that claims
      // "60s TWAP" while the contract settles on 300s would be actively misleading about
      // the one number that decides rounds.
      {address: d?.oracle, abi: UniswapV3PonsOracleAbi, functionName: "defaultTwapWindow"},
    ],
    query: {enabled: Boolean(d), refetchInterval: REFRESH_MS},
  });
  const [spot, twap, window] = result.data ?? [];
  const spotTuple = spot?.result as readonly [bigint, number] | undefined;
  const twapTuple = twap?.result as readonly [bigint, bigint] | undefined;
  return {
    ...result,
    spot: spotTuple?.[0],
    spotTick: spotTuple?.[1],
    twap: twapTuple?.[0],
    twapAsOf: twapTuple?.[1],
    twapWindowSeconds: window?.result === undefined ? undefined : Number(window.result),
  };
}

export function useRoundPhase(epoch: bigint | undefined) {
  const d = getDeployment();
  return useReadContract({
    address: d?.prediction,
    abi: PonsPredictionAbi,
    functionName: "phaseOf",
    args: epoch !== undefined ? [epoch] : undefined,
    query: {enabled: Boolean(d) && epoch !== undefined && epoch > 0n, refetchInterval: REFRESH_MS},
  });
}

export function useUserBet(epoch: bigint | undefined) {
  const d = getDeployment();
  const {address} = useAccount();
  return useReadContract({
    address: d?.prediction,
    abi: PonsPredictionAbi,
    functionName: "getBet",
    args: epoch !== undefined && address ? [epoch, address] : undefined,
    query: {enabled: Boolean(d && address) && epoch !== undefined && epoch > 0n, refetchInterval: REFRESH_MS},
  });
}

export interface UserPredictionRow {
  epoch: bigint;
  round: Round;
  terms: RoundTerms;
  bet: BetInfo;
  phase: number;
  claimable: bigint;
  refundable: bigint;
}

/**
 * The wallet's own history.
 *
 * The epoch list comes from the contract's paginated index; the per-round detail is then
 * read in one multicall. Entitlements come from the chain rather than being recomputed
 * here, so what the page shows is exactly what a claim would pay.
 */
export function useUserPredictions(limit = 25) {
  const d = getDeployment();
  const {address} = useAccount();

  return useQuery({
    queryKey: ["user-predictions", d?.prediction, address, limit],
    enabled: Boolean(d && address),
    refetchInterval: 10_000,
    queryFn: async (): Promise<UserPredictionRow[]> => {
      const {readContract, multicall} = await import("wagmi/actions");
      const {wagmiConfig} = await import("@/lib/wagmi");
      if (!d || !address) return [];

      // `getUserEpochs` returns (page, total). Destructuring only the first element
      // yields the *page*, not the count — an easy mistake that produced a plausible
      // number for small histories and silently truncated large ones.
      const [, total] = (await readContract(wagmiConfig, {
        address: d.prediction,
        abi: PonsPredictionAbi,
        functionName: "getUserEpochs",
        args: [address, 0n, 1n],
      })) as unknown as [bigint[], bigint];

      const count = Number(total);
      if (count === 0) return [];
      const offset = BigInt(Math.max(0, count - limit));
      const [epochs] = (await readContract(wagmiConfig, {
        address: d.prediction,
        abi: PonsPredictionAbi,
        functionName: "getUserEpochs",
        args: [address, offset, BigInt(limit)],
      })) as unknown as [bigint[], bigint];

      const ordered = [...epochs].reverse();
      const results = await multicall(wagmiConfig, {
        allowFailure: false,
        contracts: ordered.flatMap((epoch) => [
          {address: d.prediction, abi: PonsPredictionAbi, functionName: "getRound", args: [epoch]},
          {address: d.prediction, abi: PonsPredictionAbi, functionName: "getRoundTerms", args: [epoch]},
          {address: d.prediction, abi: PonsPredictionAbi, functionName: "getBet", args: [epoch, address]},
          {address: d.prediction, abi: PonsPredictionAbi, functionName: "phaseOf", args: [epoch]},
          {address: d.prediction, abi: PonsPredictionAbi, functionName: "claimable", args: [epoch, address]},
          {address: d.prediction, abi: PonsPredictionAbi, functionName: "refundable", args: [epoch, address]},
        ]) as never,
      });

      return ordered.map((epoch, i) => ({
        epoch,
        round: results[i * 6] as unknown as Round,
        terms: results[i * 6 + 1] as unknown as RoundTerms,
        bet: results[i * 6 + 2] as unknown as BetInfo,
        phase: Number(results[i * 6 + 3]),
        claimable: results[i * 6 + 4] as unknown as bigint,
        refundable: results[i * 6 + 5] as unknown as bigint,
      }));
    },
  });
}

/**
 * Unclaimed balances on a market this deployment replaced.
 *
 * Reads only the four functions a claim needs — `getUserEpochs`, `claimable`,
 * `refundable`, `claim` — which are unchanged between market versions. The tokenomics
 * rename touched the fee functions only, so the current ABI is safe against the older
 * contract for exactly these calls; anything richer (outcomes, terms) should not be read
 * across versions without checking the shape first.
 *
 * Returns an empty list when there is no legacy market or nothing is owed, so the UI can
 * render nothing at all rather than an empty panel that invites questions.
 */
export function useLegacyClaimable(limit = 50) {
  const d = getDeployment();
  const {address} = useAccount();
  const legacy = d?.legacyPrediction ?? null;

  return useQuery({
    queryKey: ["legacy-claimable", legacy, address, limit],
    enabled: Boolean(legacy && address),
    refetchInterval: 30_000,
    queryFn: async (): Promise<{epoch: bigint; claimable: bigint; refundable: bigint}[]> => {
      const {readContract, multicall} = await import("wagmi/actions");
      const {wagmiConfig} = await import("@/lib/wagmi");
      if (!legacy || !address) return [];

      const [, total] = (await readContract(wagmiConfig, {
        address: legacy,
        abi: PonsPredictionAbi,
        functionName: "getUserEpochs",
        args: [address, 0n, 1n],
      })) as unknown as [bigint[], bigint];

      const count = Number(total);
      if (count === 0) return [];
      const offset = BigInt(Math.max(0, count - limit));
      const [epochs] = (await readContract(wagmiConfig, {
        address: legacy,
        abi: PonsPredictionAbi,
        functionName: "getUserEpochs",
        args: [address, offset, BigInt(limit)],
      })) as unknown as [bigint[], bigint];

      const results = await multicall(wagmiConfig, {
        allowFailure: false,
        contracts: epochs.flatMap((epoch) => [
          {address: legacy, abi: PonsPredictionAbi, functionName: "claimable", args: [epoch, address]},
          {address: legacy, abi: PonsPredictionAbi, functionName: "refundable", args: [epoch, address]},
        ]) as never,
      });

      return epochs
        .map((epoch, i) => ({
          epoch,
          claimable: results[i * 2] as bigint,
          refundable: results[i * 2 + 1] as bigint,
        }))
        .filter((r) => r.claimable > 0n || r.refundable > 0n);
    },
  });
}

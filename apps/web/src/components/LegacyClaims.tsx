"use client";

import {PonsPredictionAbi, formatEth} from "@pons/sdk";
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {useLegacyClaimable} from "@/hooks/useMarket";
import {getDeployment} from "@/lib/deployment";
import {explorerTxUrl} from "@/lib/wagmi";

/**
 * Unclaimed balances on the market this deployment replaced.
 *
 * A retired market is not a closed one. Claims are pull-based and the old contract keeps
 * owing its users forever, so the only thing a migration can actually break is the user's
 * ability to *find* the money. This panel is that path.
 *
 * It renders nothing when there is no legacy market or nothing is owed — an empty
 * "legacy" panel would raise a question where there is no answer to give.
 */
export function LegacyClaims() {
  const d = getDeployment();
  const {isConnected} = useAccount();
  const {data: rows, refetch} = useLegacyClaimable();
  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, data: receipt} = useWaitForTransactionReceipt({hash});

  const legacy = d?.legacyPrediction;
  if (!legacy || !isConnected || !rows || rows.length === 0) return null;

  const total = rows.reduce((a, r) => a + r.claimable + r.refundable, 0n);

  return (
    <section className="card mb-4 border-gold-500/25 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-white">You have funds in the previous market</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-mute-500">
            These are from rounds you entered before the contract was replaced. The old contract still owes them and
            always will — this button collects from it directly. Nothing expires.
          </p>
        </div>
        <button
          className="btn-up py-2 text-xs"
          disabled={isPending || confirming}
          onClick={() =>
            writeContract(
              {
                address: legacy,
                abi: PonsPredictionAbi,
                functionName: "claim",
                args: [rows.map((r) => r.epoch)],
              },
              {onSettled: () => void refetch()}
            )
          }
        >
          {isPending || confirming ? "Claiming…" : `Collect ${formatEth(total)} ETH`}
        </button>
      </div>

      <p className="num mt-2 text-[11px] text-mute-600">
        {rows.length} round{rows.length === 1 ? "" : "s"} · {legacy}
      </p>

      {receipt?.status === "success" && (
        <p className="mt-2 text-xs text-up-400">
          Collected.{" "}
          {hash && explorerTxUrl(hash) && (
            <a className="underline" href={explorerTxUrl(hash)!} rel="noreferrer" target="_blank">
              View transaction
            </a>
          )}
        </p>
      )}
      {error && <p className="mt-2 break-words text-[11px] text-down-400">{error.message}</p>}
    </section>
  );
}

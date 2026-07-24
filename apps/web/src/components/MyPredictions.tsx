"use client";

import {PonsPredictionAbi, formatEth, formatWethPerPons, userRoundStatus} from "@pons/sdk";
import type {UserRoundStatus} from "@pons/sdk";
import {useMemo} from "react";
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {useUserPredictions} from "@/hooks/useMarket";
import {getDeployment} from "@/lib/deployment";
import {explorerTxUrl} from "@/lib/wagmi";

const TONE: Record<UserRoundStatus, string> = {
  LIVE: "bg-up-500/12 text-up-400",
  PENDING: "bg-base-700 text-mute-400",
  WON: "bg-up-500/15 text-up-400",
  LOST: "bg-base-700 text-mute-500",
  CLAIMABLE: "bg-up-500/20 text-up-300",
  CLAIMED: "bg-base-700 text-mute-400",
  REFUNDED: "bg-base-700 text-mute-400",
  REFUNDABLE: "bg-gold-500/15 text-gold-400",
  CANCELLED: "bg-down-500/12 text-down-400",
};

export function MyPredictions() {
  const {isConnected} = useAccount();
  const d = getDeployment();
  const {data: rows, isLoading, error: loadError, refetch} = useUserPredictions(40);
  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, data: receipt} = useWaitForTransactionReceipt({hash});

  const collectable = useMemo(() => (rows ?? []).filter((r) => r.claimable > 0n || r.refundable > 0n), [rows]);
  const total = collectable.reduce((a, r) => a + r.claimable + r.refundable, 0n);

  if (!isConnected) {
    return <div className="card p-10 text-center text-sm text-mute-500">Connect a wallet to see your positions.</div>;
  }

  const claim = (epochs: bigint[]) => {
    if (!d || epochs.length === 0) return;
    writeContract(
      {address: d.prediction, abi: PonsPredictionAbi, functionName: "claim", args: [epochs]},
      {onSettled: () => void refetch()}
    );
  };

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-base-800 px-4 py-3">
        <h2 className="text-sm font-bold text-white">My positions</h2>
        {collectable.length > 0 && (
          <button className="btn-up py-2 text-xs" disabled={isPending || confirming}
                  onClick={() => claim(collectable.map((r) => r.epoch))}>
            {isPending || confirming ? "Claiming…" : `Claim all · ${formatEth(total)} ETH`}
          </button>
        )}
      </header>

      {receipt?.status === "success" && (
        <p className="border-b border-base-800 px-4 py-2 text-xs text-up-400">
          Claim confirmed.{" "}
          {hash && explorerTxUrl(hash) && (
            <a className="underline" href={explorerTxUrl(hash)!} target="_blank" rel="noreferrer">View ↗</a>
          )}
        </p>
      )}
      {receipt?.status === "reverted" && (
        <p className="border-b border-base-800 px-4 py-2 text-xs text-down-400">
          The claim reverted; nothing was collected.
        </p>
      )}
      {error && <p className="border-b border-base-800 px-4 py-2 text-[11px] text-down-400">{error.message.split("\n")[0]}</p>}

      {isLoading ? (
        <p className="py-12 text-center text-sm text-mute-500">Loading…</p>
      ) : loadError ? (
        /*
          A failed read must never render as "you have no positions". They look identical
          to a user and the difference is everything: one means nothing is at stake, the
          other means their money is on chain and the page cannot see it.
        */
        <div className="py-10 text-center">
          <p className="text-sm text-down-400">Could not read your positions from the chain.</p>
          <p className="mx-auto mt-2 max-w-md text-[11px] leading-relaxed text-mute-500">
            Your entries and any winnings are unaffected — they live in the contract, not in this page.
            You can always claim directly against{" "}
            <code className="text-mute-300">{d?.prediction}</code>.
          </p>
          <p className="mt-2 break-words text-[11px] text-mute-600">{loadError.message.split("\n")[0]}</p>
          <button className="btn-ghost mt-4" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      ) : (rows ?? []).length === 0 ? (
        <p className="py-12 text-center text-sm text-mute-500">You have not entered a round yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="label border-b border-base-800">
              <tr>
                <th className="px-4 py-2.5">Round</th>
                <th className="px-2 py-2.5">Side</th>
                <th className="px-2 py-2.5 text-right">Stake</th>
                <th className="px-2 py-2.5 text-right">Lock</th>
                <th className="px-2 py-2.5 text-right">Close</th>
                <th className="px-2 py-2.5 text-right">Payout</th>
                <th className="px-2 py-2.5">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => {
                const status = userRoundStatus(r.round, r.bet, r.terms.outcome as 0, r.phase as 0);
                const owed = r.claimable + r.refundable;
                return (
                  <tr key={r.epoch.toString()} className="border-b border-base-800/70 hover:bg-base-850/40">
                    <td className="num px-4 py-3 text-mute-400">#{r.epoch.toString()}</td>
                    <td className={`px-2 py-3 font-bold ${r.bet.position === 0 ? "text-up-400" : "text-down-400"}`}>
                      {r.bet.position === 0 ? "UP" : "DOWN"}
                    </td>
                    <td className="num px-2 py-3 text-right text-white">{formatEth(r.bet.amount)}</td>
                    <td className="num px-2 py-3 text-right text-mute-400">
                      {r.round.lockPrice > 0n ? formatWethPerPons(r.round.lockPrice, 5) : "—"}
                    </td>
                    <td className="num px-2 py-3 text-right text-mute-400">
                      {r.round.closePrice > 0n ? formatWethPerPons(r.round.closePrice, 5) : "—"}
                    </td>
                    <td className={`num px-2 py-3 text-right font-semibold ${owed > 0n ? "text-up-400" : "text-mute-500"}`}>
                      {owed > 0n ? formatEth(owed) : status === "CLAIMED" ? "collected" : "—"}
                    </td>
                    <td className="px-2 py-3">
                      <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${TONE[status]}`}>{status}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {owed > 0n && (
                        <button className="chip" disabled={isPending || confirming} onClick={() => claim([r.epoch])}>
                          Claim
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

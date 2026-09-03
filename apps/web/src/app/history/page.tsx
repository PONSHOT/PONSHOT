"use client";

import {changeBps, formatChangeBps, formatEth, formatWethPerPons} from "@pons/sdk";
import {useMemo} from "react";
import {PonsChart} from "@/components/PonsChart";
import type {ChartPoint, RoundMarker} from "@/components/PonsChart";
import {useHistory} from "@/lib/api";

export default function HistoryPage() {
  const {data, isLoading, error} = useHistory(80);
  // Memoised so the identity is stable: a fresh `[]` on every render would invalidate
  // the chart's memo each time and rebuild the whole series for nothing.
  const rounds = useMemo(() => data?.rounds ?? [], [data]);

  // Built from the prices the contract actually recorded, so what is plotted *is* the
  // settlement history rather than a second price feed that might disagree with it.
  const {points, markers} = useMemo(() => {
    const settled = [...rounds].filter((r) => r.lockPrice && r.closePrice).reverse();
    const pts: ChartPoint[] = [];
    const marks: RoundMarker[] = [];
    for (const r of settled) {
      pts.push({t: r.lockTimestamp, price: BigInt(r.lockPrice!)});
      pts.push({t: r.closeTimestamp, price: BigInt(r.closePrice!)});
      marks.push({
        epoch: r.epoch,
        lockTimestamp: r.lockTimestamp,
        closeTimestamp: r.closeTimestamp,
        lockPrice: BigInt(r.lockPrice!),
        closePrice: BigInt(r.closePrice!),
      });
    }
    return {points: pts, markers: marks};
  }, [rounds]);

  return (
    <>
      <h1 className="mb-1 text-2xl font-bold text-white">Round history</h1>
      <p className="mb-6 text-sm text-mute-500">
        Every settled and cancelled round, taken from contract events. Nothing here is estimated.
      </p>

      {error && (
        <div className="card mb-6 p-4 text-sm text-down-400">
          Could not reach the read API ({error.message}). Round data remains available on chain.
        </div>
      )}

      {points.length >= 2 && (
        <div className="mb-6">
          <PonsChart points={points} markers={markers} />
        </div>
      )}

      <div className="card overflow-x-auto p-5">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-mute-500">Loading…</p>
        ) : rounds.length === 0 ? (
          <p className="py-6 text-center text-sm text-mute-500">No completed rounds yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="label border-b border-base-700">
              <tr>
                <th className="py-2 pr-3">Round</th>
                <th className="py-2 pr-3">Locked at</th>
                <th className="py-2 pr-3">Lock price</th>
                <th className="py-2 pr-3">Close price</th>
                <th className="py-2 pr-3">Move</th>
                <th className="py-2 pr-3">Result</th>
                <th className="py-2 pr-3">Pool</th>
                <th className="py-2 pr-3">UP / DOWN</th>
                <th className="py-2 pr-3">Paid out</th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => {
                const lock = r.lockPrice ? BigInt(r.lockPrice) : 0n;
                const close = r.closePrice ? BigInt(r.closePrice) : 0n;
                const move = lock > 0n && close > 0n ? changeBps(lock, close) : null;
                return (
                  <tr key={r.epoch} className="border-b border-base-800/60">
                    <td className="num py-2.5 pr-3">#{r.epoch}</td>
                    <td className="py-2.5 pr-3 text-mute-500">{new Date(r.lockTimestamp * 1000).toLocaleString()}</td>
                    <td className="num py-2.5 pr-3">{lock > 0n ? formatWethPerPons(lock) : "—"}</td>
                    <td className="num py-2.5 pr-3">{close > 0n ? formatWethPerPons(close) : "—"}</td>
                    <td
                      className={`num py-2.5 pr-3 ${
                        move && move > 0n ? "text-up-400" : move && move < 0n ? "text-down-400" : "text-mute-500"
                      }`}
                    >
                      {move === null ? "—" : formatChangeBps(move)}
                    </td>
                    <td className="py-2.5 pr-3">
                      <OutcomeBadge value={r.outcome} status={r.status} reason={r.cancelReason} />
                    </td>
                    <td className="num py-2.5 pr-3">{formatEth(BigInt(r.totalAmount))}</td>
                    <td className="num py-2.5 pr-3 text-mute-500">
                      {formatEth(BigInt(r.bullAmount), 3)} / {formatEth(BigInt(r.bearAmount), 3)}
                    </td>
                    <td className="num py-2.5 pr-3">{formatEth(BigInt(r.rewardAmount))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function OutcomeBadge({value, status, reason}: {value: string | null; status: string; reason: string | null}) {
  if (status === "CANCELLED") {
    return (
      <span className="rounded bg-down-500/15 px-2 py-0.5 text-[11px] text-down-400" title={reason ?? undefined}>
        Cancelled — refunded
      </span>
    );
  }
  const map: Record<string, [string, string]> = {
    BULL: ["UP", "bg-up-500/15 text-up-400"],
    BEAR: ["DOWN", "bg-down-500/15 text-down-400"],
    TIE: ["Tie — refunded", "bg-base-700 text-mute-400"],
    NO_CONTEST: ["No contest — refunded", "bg-base-700 text-mute-400"],
  };
  const [label, tone] = map[value ?? ""] ?? ["—", "bg-base-700 text-mute-500"];
  return <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>;
}

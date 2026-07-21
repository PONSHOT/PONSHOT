"use client";

import {useState} from "react";
import {useAccount} from "wagmi";
import {AccountAvatar} from "@/components/Brand";
import {bpsToPercent, compactEth, displayName, formatEth, shortAddress} from "@/lib/format";
import {useLeaderboard} from "@/lib/api";

const WINDOWS = ["24h", "7d", "30d", "all"] as const;

/**
 * Leaderboard.
 *
 * Ranked on *realised* profit: what a wallet has actually collected, less everything it
 * has staked. A wallet sitting on an unclaimed win therefore shows negative until it
 * claims. That is the honest reading — the money is not theirs until they take it — and
 * counting it early would let an abandoned position inflate a ranking indefinitely.
 */
export default function LeaderboardPage() {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>("all");
  const {data, isLoading, error} = useLeaderboard(window, 50);
  const {address} = useAccount();

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Leaderboard</h1>
          <p className="mt-1 text-xs text-mute-500">
            Ranked on realised profit — collected minus staked, from indexed contract events.
          </p>
        </div>
        <div className="flex gap-1.5">
          {WINDOWS.map((w) => (
            <button key={w} className={`chip ${window === w ? "chip-on" : ""}`} onClick={() => setWindow(w)}>
              {w.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="card p-8 text-center text-sm text-down-400">
          Leaderboard unavailable ({error.message}). The market itself is unaffected.
        </div>
      ) : isLoading ? (
        <div className="card p-12 text-center text-sm text-mute-500">Loading…</div>
      ) : (data?.entries ?? []).length === 0 ? (
        <div className="card p-12 text-center text-sm text-mute-500">
          No predictions in this window yet.
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="label border-b border-base-800">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-2 py-3">Wallet</th>
                <th className="px-2 py-3 text-right">Rounds</th>
                <th className="px-2 py-3 text-right">Won</th>
                <th className="px-2 py-3 text-right">Accuracy</th>
                <th className="px-2 py-3 text-right">Staked</th>
                <th className="px-2 py-3 text-right">Biggest win</th>
                <th className="px-4 py-3 text-right">Net profit</th>
              </tr>
            </thead>
            <tbody>
              {(data?.entries ?? []).map((r) => {
                const profit = BigInt(r.netProfit);
                const isYou = address?.toLowerCase() === r.account;
                return (
                  <tr
                    key={r.account}
                    className={`border-b border-base-800/70 ${isYou ? "bg-up-500/6" : "hover:bg-base-850/40"}`}
                  >
                    <td className="num px-4 py-3 text-mute-500">
                      {r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank}
                    </td>
                    <td className="px-2 py-3">
                      <span className="flex items-center gap-2">
                        <AccountAvatar address={r.account} size={24} />
                        <span>
                          <span className="num block text-mute-200">{displayName(r.account)}</span>
                          <span className="num block text-[10px] text-mute-600">{shortAddress(r.account)}</span>
                        </span>
                        {isYou && (
                          <span className="rounded bg-up-500/20 px-1.5 py-0.5 text-[9px] font-bold text-up-300">
                            YOU
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="num px-2 py-3 text-right text-mute-400">{r.roundsPlayed}</td>
                    <td className="num px-2 py-3 text-right text-mute-400">{r.roundsWon}</td>
                    <td className="num px-2 py-3 text-right text-mute-300">{bpsToPercent(r.accuracyBps)}</td>
                    <td className="num px-2 py-3 text-right text-mute-400">{compactEth(BigInt(r.staked))}</td>
                    <td className="num px-2 py-3 text-right text-mute-400">{formatEth(BigInt(r.biggestWin))}</td>
                    <td className={`num px-4 py-3 text-right font-bold ${profit >= 0n ? "text-up-400" : "text-down-400"}`}>
                      {profit >= 0n ? "+" : "−"}{compactEth(profit < 0n ? -profit : profit)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-mute-600">
        Accuracy counts only rounds that produced a winner — ties and no-contest rounds were never a call anyone
        could get right or wrong, so they are excluded rather than scored as losses.
      </p>
    </>
  );
}

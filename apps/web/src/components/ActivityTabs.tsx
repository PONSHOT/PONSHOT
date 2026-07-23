"use client";

import {useState} from "react";
import {AccountAvatar} from "./Brand";
import {bpsToPercent, compactEth, displayName, formatEth, formatWethPerPons, timeAgo} from "@/lib/format";
import {useLeaderboard, useTrades} from "@/lib/api";

type Tab = "predictors" | "trades" | "pool";

/**
 * The lower activity panel.
 *
 * Every figure here is indexed from contract events. Where a number cannot be derived
 * honestly it is shown as a dash rather than filled in — an invented statistic on a page
 * about money is worse than a gap.
 */
export function ActivityTabs({bullAmount, bearAmount}: {bullAmount?: bigint; bearAmount?: bigint}) {
  const [tab, setTab] = useState<Tab>("predictors");

  return (
    <section className="card mt-4 overflow-hidden">
      <div className="flex border-b border-base-800">
        <TabButton on={tab === "predictors"} onClick={() => setTab("predictors")}>🏆 Top predictors</TabButton>
        <TabButton on={tab === "trades"} onClick={() => setTab("trades")}>Recent entries</TabButton>
        <TabButton on={tab === "pool"} onClick={() => setTab("pool")}>Pool split</TabButton>
      </div>
      <div className="p-4">
        {tab === "predictors" && <Predictors />}
        {tab === "trades" && <Trades />}
        {tab === "pool" && <PoolSplit bullAmount={bullAmount ?? 0n} bearAmount={bearAmount ?? 0n} />}
      </div>
    </section>
  );
}

function TabButton({on, onClick, children}: {on: boolean; onClick: () => void; children: React.ReactNode}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-3 text-xs font-semibold transition-colors ${
        on ? "text-up-400" : "text-mute-500 hover:text-mute-300"
      }`}
    >
      {children}
      {on && <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-up-500" />}
    </button>
  );
}

function Predictors() {
  const {data, isLoading, error} = useLeaderboard("all", 6);
  if (error) return <Empty>Leaderboard unavailable — the indexer may be catching up.</Empty>;
  if (isLoading) return <Empty>Loading…</Empty>;
  const rows = data?.entries ?? [];
  if (rows.length === 0) return <Empty>No predictions yet. Be the first.</Empty>;

  return (
    <table className="w-full text-left text-xs">
      <thead className="label">
        <tr>
          <th className="pb-2 pr-2">#</th>
          <th className="pb-2 pr-2">Wallet</th>
          <th className="pb-2 pr-2 text-right">Accuracy</th>
          <th className="pb-2 text-right">Net profit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const profit = BigInt(r.netProfit);
          return (
            <tr key={r.account} className="border-t border-base-800">
              <td className="num py-2.5 pr-2 text-mute-500">{r.rank}</td>
              <td className="py-2.5 pr-2">
                <span className="flex items-center gap-2">
                  <AccountAvatar address={r.account} size={22} />
                  <span className="num text-mute-200">{displayName(r.account)}</span>
                  {r.rank === 1 && (
                    <span className="rounded bg-gold-500/15 px-1.5 py-0.5 text-[9px] font-bold text-gold-400">
                      TOP
                    </span>
                  )}
                </span>
              </td>
              <td className="num py-2.5 pr-2 text-right text-mute-300">{bpsToPercent(r.accuracyBps)}</td>
              <td className={`num py-2.5 text-right font-semibold ${profit >= 0n ? "text-up-400" : "text-down-400"}`}>
                {profit >= 0n ? "+" : "-"}{compactEth(profit < 0n ? -profit : profit)} ETH
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Trades() {
  const {data, isLoading, error} = useTrades(12);
  if (error) return <Empty>Feed unavailable — the indexer may be catching up.</Empty>;
  if (isLoading) return <Empty>Loading…</Empty>;
  const rows = data?.trades ?? [];
  if (rows.length === 0) return <Empty>No entries yet.</Empty>;

  return (
    <ul className="space-y-1.5">
      {rows.map((t, i) => {
        const up = t.position === "BULL";
        return (
          <li key={`${t.tx_hash}-${i}`} className="flex items-center gap-3 rounded-lg bg-base-850/60 px-3 py-2 text-xs">
            <span className={`font-bold ${up ? "text-up-400" : "text-down-400"}`}>
              {up ? "UP ↗" : "DOWN ↓"}
            </span>
            <span className="num font-semibold text-white">{formatEth(BigInt(t.amount))} ETH</span>
            <span className="num text-mute-500">
              {t.lock_price ? `@ ${formatWethPerPons(BigInt(t.lock_price), 5)}` : "· round open"}
            </span>
            <span className="num ml-auto text-mute-600">#{t.epoch}</span>
            <span className="text-mute-600">{timeAgo(t.block_time)}</span>
            <AccountAvatar address={t.account} size={20} />
          </li>
        );
      })}
    </ul>
  );
}

function PoolSplit({bullAmount, bearAmount}: {bullAmount: bigint; bearAmount: bigint}) {
  const total = bullAmount + bearAmount;
  if (total === 0n) return <Empty>No stakes in the open round yet.</Empty>;
  const bullPct = Number((bullAmount * 10_000n) / total) / 100;

  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-base-800">
        <div className="bg-up-500 transition-all" style={{width: `${bullPct}%`}} />
        <div className="bg-down-500 transition-all" style={{width: `${100 - bullPct}%`}} />
      </div>
      <div className="mt-3 flex justify-between text-xs">
        <span className="text-up-400">
          UP <span className="num font-semibold">{formatEth(bullAmount)} ETH</span> ({bullPct.toFixed(1)}%)
        </span>
        <span className="text-down-400">
          DOWN <span className="num font-semibold">{formatEth(bearAmount)} ETH</span> ({(100 - bullPct).toFixed(1)}%)
        </span>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-mute-600">
        Parimutuel: the winning side shares the whole pool less the protocol fee, in proportion to stake. The split
        above moves as people enter, so every multiplier on this page is an estimate until the round locks.
      </p>
    </div>
  );
}

function Empty({children}: {children: React.ReactNode}) {
  return <p className="py-8 text-center text-xs text-mute-600">{children}</p>;
}

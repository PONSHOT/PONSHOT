"use client";

import {formatEth} from "@pons/sdk";
import {useStats} from "@/lib/api";

/**
 * Protocol statistics.
 *
 * Every number is a SQL aggregate over indexed contract events. Nothing is modelled,
 * annualised or projected — where a figure cannot be derived from an event, it is not
 * shown at all rather than approximated.
 */
export default function StatsPage() {
  const {data, isLoading, error} = useStats();

  if (error) {
    return (
      <div className="card p-6 text-sm text-down-400">
        Could not reach the read API ({error.message}). Statistics come from the indexer; the market itself is
        unaffected.
      </div>
    );
  }
  if (isLoading || !data) return <div className="card p-8 text-center text-sm text-mute-500">Loading…</div>;

  const wei = (v: string) => BigInt(v || "0");
  const bull = wei(data.bull_volume);
  const bear = wei(data.bear_volume);
  const total = bull + bear;
  const bullPct = total > 0n ? Number((bull * 10_000n) / total) / 100 : 50;

  return (
    <>
      <h1 className="mb-1 text-2xl font-bold text-white">Statistics</h1>
      <p className="mb-6 text-sm text-mute-500">
        Derived entirely from on-chain events indexed from the PonsPrediction contract.
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total volume" value={`${formatEth(total)} ETH`} />
        <Stat label="Paid to winners" value={`${formatEth(wei(data.total_paid_to_winners))} ETH`} />
        <Stat label="Refunded" value={`${formatEth(wei(data.total_refunded))} ETH`} />
        <Stat label="Treasury fees accrued" value={`${formatEth(wei(data.treasury_fees_accrued))} ETH`} />
        <Stat label="Rounds" value={data.total_rounds} sub={`${data.settled_rounds} settled · ${data.cancelled_rounds} cancelled`} />
        <Stat label="Predictions" value={data.total_predictions} />
        <Stat label="Unique wallets" value={data.unique_wallets} />
        <Stat label="Current round volume" value={`${formatEth(wei(data.current_round_volume))} ETH`} />
      </div>

      <section className="card mb-6 p-5">
        <h2 className="mb-3 text-sm font-semibold text-white">UP / DOWN distribution by volume</h2>
        <div className="flex h-3 overflow-hidden rounded bg-base-700">
          <div className="bg-up-500" style={{width: `${bullPct}%`}} />
          <div className="bg-down-500" style={{width: `${100 - bullPct}%`}} />
        </div>
        <div className="mt-2 flex justify-between text-xs">
          <span className="text-up-400">UP {formatEth(bull)} ETH ({bullPct.toFixed(1)}%)</span>
          <span className="text-down-400">DOWN {formatEth(bear)} ETH ({(100 - bullPct).toFixed(1)}%)</span>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-white">Outcomes</h2>
          <dl className="space-y-2 text-sm">
            <Line label="UP won" value={data.bull_wins} />
            <Line label="DOWN won" value={data.bear_wins} />
            <Line label="Ties (refunded)" value={data.ties} />
            <Line label="No contest (refunded)" value={data.no_contests} />
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-mute-500">
            A round is a <em>no contest</em> when one side attracted no stake. Nothing was won, so every entry is
            refunded in full and no fee is charged.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-white">Oracle settlement lag</h2>
          <p className="mb-3 text-[11px] leading-relaxed text-mute-500">
            How long after a round&apos;s scheduled instant its price actually became obtainable. The pool records an
            observation only when a swap moves the tick, so a quiet market lengthens this. The price itself does not
            change while we wait — only when it can be read.
          </p>
          <table className="w-full text-left text-sm">
            <thead className="label border-b border-base-700">
              <tr>
                <th className="py-1.5">Boundary</th>
                <th className="py-1.5">Samples</th>
                <th className="py-1.5">Average</th>
                <th className="py-1.5">Worst</th>
              </tr>
            </thead>
            <tbody>
              {(data.oracle_settlement_lag ?? []).map((row) => (
                <tr key={row.kind} className="border-b border-base-800/60">
                  <td className="py-2">{row.kind === "LOCK" ? "Lock" : "Close"}</td>
                  <td className="num py-2">{row.samples}</td>
                  <td className="num py-2">{row.avg_lag_seconds}s</td>
                  <td className="num py-2">{row.max_lag_seconds}s</td>
                </tr>
              ))}
              {(data.oracle_settlement_lag ?? []).length === 0 && (
                <tr>
                  <td className="py-3 text-mute-500" colSpan={4}>No settled rounds yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

function Stat({label, value, sub}: {label: string; value: string; sub?: string}) {
  return (
    <div className="card p-4">
      <div className="label">{label}</div>
      <div className="num mt-1 text-xl text-white">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-mute-500">{sub}</div>}
    </div>
  );
}

function Line({label, value}: {label: string; value: string}) {
  return (
    <div className="flex justify-between">
      <dt className="text-mute-500">{label}</dt>
      <dd className="num text-white">{value}</dd>
    </div>
  );
}

"use client";

import {formatEth} from "@pons/sdk";
import {useBurn} from "@/lib/api";

/**
 * Buyback and burn.
 *
 * Burned totals are sums over indexed `BoughtAndBurned` events, not a running counter
 * anybody maintains, so every figure here corresponds to a transaction that happened and
 * can be checked against the token's own balances. Where a target is not configured yet,
 * that is shown rather than hidden — its share accrues instead of being redirected.
 */
export function BurnPanel() {
  const {data, isLoading, error} = useBurn();

  if (error) {
    return (
      <section className="card p-5 text-sm text-down-400">
        Could not load burn statistics ({error.message}). The market and its buybacks are unaffected.
      </section>
    );
  }
  if (isLoading || !data) return <section className="card p-5 text-sm text-mute-500">Loading burn data…</section>;

  if (!data.configured) {
    return (
      <section className="card p-5">
        <h2 className="mb-1 text-sm font-semibold text-white">Buyback and burn</h2>
        <p className="text-xs text-mute-500">{data.note}</p>
      </section>
    );
  }

  const pending = BigInt(data.pendingInMarket ?? "0");

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-white">Buyback and burn</h2>
        <span className="text-[11px] text-mute-500">
          10% of every contested pot · 100% when no one wins
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(data.targets ?? []).map((t) => (
          <div key={t.index} className="rounded-lg border border-base-700 bg-base-850 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold text-burn-400">{t.name}</span>
              <span className="num text-[11px] text-mute-500">{t.shareBps / 100}% of the burn</span>
            </div>

            {t.configured ? (
              <>
                <div className="num mt-2 text-xl font-bold text-white">{formatEth(BigInt(t.tokensBurned))}</div>
                <div className="text-[11px] text-mute-500">tokens burned across {t.burns} buybacks</div>
                <dl className="mt-3 space-y-1 text-[11px]">
                  <Row label="ETH spent" value={`${formatEth(BigInt(t.ethSpent))} ETH`} />
                  <Row label="Waiting to be spent" value={`${formatEth(BigInt(t.allocated))} ETH`} />
                  <Row
                    label="Last buyback"
                    value={t.lastBurnAt ? new Date(t.lastBurnAt).toLocaleString() : "none yet"}
                  />
                </dl>
              </>
            ) : (
              <>
                <div className="num mt-2 text-xl font-bold text-mute-400">
                  {formatEth(BigInt(t.allocated))} ETH
                </div>
                <div className="text-[11px] text-mute-500">
                  accruing — no token configured yet. This share is held, not redirected to the other target.
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {pending > 0n && (
        <p className="mt-3 text-[11px] text-mute-500">
          <span className="num text-mute-300">{formatEth(pending)} ETH</span> booked by settled rounds and not yet
          pushed to the burner. Anyone can push it; no permission is required.
        </p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-mute-500">
        Bought tokens go to <span className="num">0x…dEaD</span>, which no key controls. Buybacks run in a separate
        transaction from settlement on purpose: the PONS leg trades in the same pools the settlement oracle reads, and
        a swap inside settlement would move the price the next round settles against.
      </p>
    </section>
  );
}

function Row({label, value}: {label: string; value: string}) {
  return (
    <div className="flex justify-between">
      <dt className="text-mute-500">{label}</dt>
      <dd className="num text-mute-300">{value}</dd>
    </div>
  );
}

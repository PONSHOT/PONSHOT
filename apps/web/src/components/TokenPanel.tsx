"use client";

import {changeBps, formatChangeBps, formatUsd, ponsUsdX18} from "@pons/sdk";
import {LogoMark, TokenAvatar} from "./Brand";
import {formatEth, formatWethPerPons} from "@/lib/format";
import {useCountdown} from "@/hooks/useCountdown";

export const INTERVALS = ["1m", "5m", "15m", "1h"] as const;
export type ChartInterval = (typeof INTERVALS)[number];

interface Props {
  spot?: bigint;
  twap?: bigint;
  /** Reference the change is measured against — the live round's lock price. */
  reference?: bigint;
  twapWindowSeconds?: number;
  roundEndsAt?: bigint;
  epoch?: bigint;
  volume24h?: bigint;
  ethUsdX8?: bigint | null;
  interval: ChartInterval;
  onInterval: (i: ChartInterval) => void;
}

/**
 * The market header: price, round countdown, chart interval.
 *
 * The headline price is *spot*, because that is the number that moves and that a trader
 * recognises. The settlement TWAP sits directly beneath it and is labelled as the figure
 * that decides rounds. Showing only one would be misleading in opposite directions — spot
 * alone implies it settles rounds, the TWAP alone looks stuck next to any chart.
 */
export function TokenPanel({
  spot, twap, reference, twapWindowSeconds, roundEndsAt, epoch, volume24h, ethUsdX8, interval, onInterval,
}: Props) {
  const {text: countdown, seconds} = useCountdown(roundEndsAt);
  const delta = reference && reference > 0n && spot ? changeBps(reference, spot) : null;
  const rising = delta === null ? true : delta >= 0n;
  const usd = spot === undefined ? null : ponsUsdX18(spot, ethUsdX8);
  const urgent = seconds > 0 && seconds <= 15;

  return (
    <section className="card mb-4 overflow-hidden">
      <div className="grid gap-px bg-base-800 md:grid-cols-[1.15fr_0.9fr_0.8fr]">
        {/* price */}
        <div className="bg-base-900 p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <TokenAvatar size={38} />
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-base font-bold text-white">$PONS</span>
                <span className="text-mute-600" aria-hidden="true">☆</span>
              </div>
              <div className="text-[11px] text-mute-500">PONS / WETH · Uniswap V3 1%</div>
            </div>
          </div>

          <div className="flex items-baseline gap-3">
            <span className="num text-[27px] font-bold leading-none text-white">
              {usd !== null ? formatUsd(usd, 5) : spot !== undefined ? formatWethPerPons(spot, 5) : "—"}
            </span>
            {delta !== null && (
              <span className={`num text-sm font-semibold ${rising ? "text-up-400" : "text-down-400"}`}>
                {formatChangeBps(delta)}
              </span>
            )}
          </div>

          <div className="mt-2 space-y-0.5 text-[11px] text-mute-500">
            {usd !== null && spot !== undefined && <div className="num">{formatWethPerPons(spot, 5)} WETH</div>}
            <div>
              Settles on{" "}
              <span className="num text-mute-300">
                {twap !== undefined ? formatWethPerPons(twap, 5) : "—"} WETH
              </span>{" "}
              ({twapWindowSeconds ? `${twapWindowSeconds}s` : ""} TWAP)
            </div>
            {volume24h !== undefined && (
              <div className="num">24h volume {formatEth(volume24h, 3)} ETH staked</div>
            )}
          </div>
        </div>

        {/* countdown */}
        <div className="flex flex-col items-center justify-center bg-base-900 p-5">
          <div className="label mb-1">Round {epoch ? `#${epoch}` : ""} ends in</div>
          <div
            className={`num text-[42px] font-bold leading-none tabular-nums ${
              urgent ? "animate-pulse-ring text-down-400" : "text-up-400"
            }`}
          >
            {countdown}
          </div>
          <div className="mt-3 flex gap-1.5">
            {INTERVALS.map((i) => (
              <button
                key={i}
                onClick={() => onInterval(i)}
                className={`chip ${interval === i ? "chip-on" : ""}`}
                aria-pressed={interval === i}
              >
                {i}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-mute-600">chart interval</p>
        </div>

        {/* mark */}
        <div className="relative hidden items-center justify-center overflow-hidden bg-base-900 md:flex">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_60%_50%,rgba(155,232,28,0.18),transparent_65%)]" />
          <div className="absolute -right-6 -top-8 h-40 w-40 rounded-full bg-up-500/12 blur-2xl" />
          <LogoMark size={104} className="relative animate-pulse-ring drop-shadow-[0_0_30px_rgba(155,232,28,0.4)]" />
        </div>
      </div>
    </section>
  );
}

"use client";

import {useMemo, useState} from "react";
import {changeBps, formatChangeBps} from "@pons/sdk";
import {formatWethPerPons} from "@/lib/format";

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  samples: number;
}

interface Props {
  candles: Candle[];
  interval: string;
  /** Drawn as a horizontal marker: the price the live round locked at. */
  lockPrice?: bigint;
  loading?: boolean;
  height?: number;
}

const PAD_RIGHT = 74; // room for the price axis
const PAD_BOTTOM = 26; // room for the time axis

/**
 * Candlestick chart.
 *
 * Inline SVG rather than a charting library: the shape is simple, it keeps the bundle
 * small, and it avoids shipping a second opinion about how prices should be scaled.
 *
 * Prices arrive as uint256 wei strings. They are converted to numbers *only* for pixel
 * positions — every figure rendered as text comes from the original integer, so the
 * readout never disagrees with the chain by a rounding step.
 */
export function CandleChart({candles, interval, lockPrice, loading, height = 300}: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (candles.length === 0) return null;
    const lows = candles.map((c) => Number(c.l));
    const highs = candles.map((c) => Number(c.h));
    let lo = Math.min(...lows);
    let hi = Math.max(...highs);
    if (lockPrice !== undefined && lockPrice > 0n) {
      lo = Math.min(lo, Number(lockPrice));
      hi = Math.max(hi, Number(lockPrice));
    }
    // A perfectly flat series has zero range and would divide by zero.
    const span = hi - lo || Math.max(1, hi * 0.002);
    const padded = {lo: lo - span * 0.12, hi: hi + span * 0.12};
    const y = (v: number) => ((padded.hi - v) / (padded.hi - padded.lo)) * (height - PAD_BOTTOM);
    const slot = 100 / candles.length;
    return {y, slot, ...padded};
  }, [candles, height, lockPrice]);

  if (loading) {
    return (
      <div className="card flex items-center justify-center" style={{height}}>
        <span className="text-sm text-mute-500">Loading price history…</span>
      </div>
    );
  }
  if (!geo || candles.length < 2) {
    return (
      <div className="card flex flex-col items-center justify-center gap-1" style={{height}}>
        <span className="text-sm text-mute-400">Not enough price history yet</span>
        <span className="text-[11px] text-mute-600">candles build as the indexer samples the oracle</span>
      </div>
    );
  }

  const last = candles[candles.length - 1]!;
  const first = candles[0]!;
  const delta = changeBps(BigInt(first.o), BigInt(last.c));
  const rising = delta >= 0n;
  const shown = hover !== null ? candles[hover]! : last;

  // Five evenly spaced gridlines, labelled with real prices from the padded range.
  const gridlines = Array.from({length: 5}, (_, i) => {
    const v = geo.hi - ((geo.hi - geo.lo) * i) / 4;
    return {v, y: geo.y(v)};
  });

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-base-800 px-4 py-3">
        <span className="text-sm font-semibold text-white">
          $PONS / WETH <span className="text-mute-500">· {interval}</span>
        </span>
        <span className={`num text-sm font-semibold ${rising ? "text-up-400" : "text-down-400"}`}>
          {formatWethPerPons(BigInt(shown.c), 5)}
        </span>
        <span className={`num text-xs ${rising ? "text-up-400" : "text-down-400"}`}>
          {formatChangeBps(delta)}
        </span>
        <span className="ml-auto flex gap-3 text-[10px] text-mute-500">
          <span>O <span className="num text-mute-300">{formatWethPerPons(BigInt(shown.o), 5)}</span></span>
          <span>H <span className="num text-mute-300">{formatWethPerPons(BigInt(shown.h), 5)}</span></span>
          <span>L <span className="num text-mute-300">{formatWethPerPons(BigInt(shown.l), 5)}</span></span>
          <span>C <span className="num text-mute-300">{formatWethPerPons(BigInt(shown.c), 5)}</span></span>
        </span>
      </div>

      <div className="relative" style={{height}}>
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          className="absolute inset-0"
          style={{paddingRight: PAD_RIGHT}}
          role="img"
          aria-label={`PONS price candlesticks at ${interval} intervals`}
          onMouseLeave={() => setHover(null)}
        >
          {gridlines.map((g, i) => (
            <line key={i} x1="0" y1={g.y} x2="100" y2={g.y} stroke="#171b1f" strokeWidth="1"
                  vectorEffect="non-scaling-stroke" />
          ))}

          {lockPrice !== undefined && lockPrice > 0n && (
            <line x1="0" y1={geo.y(Number(lockPrice))} x2="100" y2={geo.y(Number(lockPrice))}
                  stroke="#f0b429" strokeWidth="1" strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke" opacity="0.8" />
          )}

          {candles.map((c, i) => {
            const x = i * geo.slot + geo.slot / 2;
            const o = Number(c.o);
            const cl = Number(c.c);
            const up = cl >= o;
            const colour = up ? "#12c974" : "#e33f4d";
            const bodyTop = geo.y(Math.max(o, cl));
            const bodyBottom = geo.y(Math.min(o, cl));
            // A doji would otherwise render as an invisible zero-height rect.
            const bodyHeight = Math.max(1, bodyBottom - bodyTop);
            const bodyWidth = Math.max(geo.slot * 0.62, 0.35);

            return (
              <g key={c.t} onMouseEnter={() => setHover(i)} opacity={hover === null || hover === i ? 1 : 0.55}>
                <rect x={x - geo.slot / 2} y={0} width={geo.slot} height={height - PAD_BOTTOM} fill="transparent" />
                <line x1={x} y1={geo.y(Number(c.h))} x2={x} y2={geo.y(Number(c.l))} stroke={colour}
                      strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={colour} />
              </g>
            );
          })}
        </svg>

        {/* Price axis, positioned in HTML so the text is not stretched by the viewBox. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 w-[74px]">
          {gridlines.map((g, i) => (
            <span key={i} className="num absolute right-2 -translate-y-1/2 text-[10px] text-mute-500"
                  style={{top: g.y}}>
              {formatWethPerPons(BigInt(Math.round(g.v)), 5)}
            </span>
          ))}
          <span
            className="num absolute right-1 -translate-y-1/2 rounded bg-up-500 px-1.5 py-0.5 text-[10px] font-bold text-base-950"
            style={{top: geo.y(Number(last.c))}}
          >
            {formatWethPerPons(BigInt(last.c), 5)}
          </span>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between pr-[74px] text-[10px] text-mute-600">
          {[0, Math.floor(candles.length / 2), candles.length - 1].map((i) => (
            <span key={i} className="num px-2">
              {new Date(candles[i]!.t * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-base-800 px-4 py-2 text-[10px] text-mute-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-up-500" /> up
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-down-500" /> down
        </span>
        {lockPrice !== undefined && lockPrice > 0n && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-4 bg-gold-500" /> live round locked here
          </span>
        )}
        <span className="ml-auto">spot price — rounds settle on the TWAP, not on these candles</span>
      </div>
    </div>
  );
}

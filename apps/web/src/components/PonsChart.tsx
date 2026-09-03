"use client";

import {formatWethPerPons} from "@pons/sdk";
import {useMemo} from "react";

export interface ChartPoint {
  t: number;
  price: bigint;
}

export interface RoundMarker {
  epoch: string;
  lockTimestamp: number;
  closeTimestamp: number;
  lockPrice: bigint;
  closePrice: bigint;
}

/**
 * PONS/WETH chart with round markers.
 *
 * Drawn as inline SVG rather than pulling in a charting library: the shape is simple,
 * and it keeps the bundle small and the rendering deterministic.
 *
 * The chart is informational. It plots indexed oracle readings, and the lock/close
 * markers show the values the contract actually recorded — so what you see is the
 * settlement history, not a separate price feed that might disagree with it.
 */
export function PonsChart({points, markers, height = 220}: {points: ChartPoint[]; markers?: RoundMarker[]; height?: number}) {
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.t);
    const ys = points.map((p) => Number(p.price));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const padY = (maxY - minY) * 0.12 || Math.max(1, maxY * 0.01);
    const lo = minY - padY;
    const hi = maxY + padY;

    const x = (t: number) => ((t - minX) / Math.max(1, maxX - minX)) * 100;
    const y = (v: number) => 100 - ((v - lo) / Math.max(1, hi - lo)) * 100;

    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(3)},${y(Number(p.price)).toFixed(3)}`).join(" ");
    const area = `${path} L100,100 L0,100 Z`;
    return {path, area, x, y, minX, maxX, lo, hi};
  }, [points]);

  if (!geometry) {
    return (
      <div className="card flex items-center justify-center p-8 text-sm text-mute-500" style={{height}}>
        Not enough price history yet.
      </div>
    );
  }

  const last = points[points.length - 1]!;
  const first = points[0]!;
  const rising = last.price >= first.price;

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">PONS / WETH — settlement oracle readings</span>
        <span className={`num text-sm ${rising ? "text-up-400" : "text-down-400"}`}>
          {formatWethPerPons(last.price)} WETH
        </span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{height, width: "100%"}} role="img"
           aria-label="PONS price over time with round lock and close markers">
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={rising ? "#12c974" : "#e33f4d"} stopOpacity="0.28" />
            <stop offset="100%" stopColor={rising ? "#12c974" : "#e33f4d"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((g) => (
          <line key={g} x1="0" y1={g} x2="100" y2={g} stroke="#171b1f" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={geometry.area} fill="url(#fill)" />
        <path d={geometry.path} fill="none" stroke={rising ? "#12c974" : "#e33f4d"} strokeWidth="1.6"
              vectorEffect="non-scaling-stroke" strokeLinejoin="round" />

        {markers?.map((m) => {
          const lx = geometry.x(m.lockTimestamp);
          const cx = geometry.x(m.closeTimestamp);
          if (lx < 0 || lx > 100) return null;
          return (
            <g key={m.epoch}>
              <line x1={lx} y1="0" x2={lx} y2="100" stroke="#f0b429" strokeWidth="0.6" strokeDasharray="2 2"
                    vectorEffect="non-scaling-stroke" opacity="0.6" />
              {m.lockPrice > 0n && (
                <circle cx={lx} cy={geometry.y(Number(m.lockPrice))} r="1.2" fill="#f0b429" vectorEffect="non-scaling-stroke" />
              )}
              {m.closePrice > 0n && cx <= 100 && (
                <circle cx={cx} cy={geometry.y(Number(m.closePrice))} r="1.2"
                        fill={m.closePrice > m.lockPrice ? "#12c974" : "#e33f4d"} vectorEffect="non-scaling-stroke" />
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-mute-500">
        <span><span className="inline-block h-2 w-2 rounded-full bg-gold-500" /> round locked</span>
        <span><span className="inline-block h-2 w-2 rounded-full bg-up-500" /> closed higher</span>
        <span><span className="inline-block h-2 w-2 rounded-full bg-down-500" /> closed lower</span>
        <span className="ml-auto">Informational — the contract remains authoritative.</span>
      </div>
    </div>
  );
}

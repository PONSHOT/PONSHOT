"use client";

import {useEffect, useState} from "react";

/**
 * Counts down to a chain timestamp.
 *
 * Uses the wall clock rather than polling the chain: a countdown that refetched every
 * second would be a needless RPC load, and being a second out on a display timer costs
 * nothing. The contract, not this timer, decides whether an entry is still accepted —
 * so the UI treats "00:00" as a hint, and lets a late transaction revert honestly rather
 * than pretending it knows better.
 */
export function useCountdown(target: bigint | number | undefined): {
  seconds: number;
  text: string;
  expired: boolean;
} {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  if (target === undefined) return {seconds: 0, text: "--:--", expired: false};
  const seconds = Math.max(0, Number(target) - now);
  return {seconds, text: formatDuration(seconds), expired: seconds === 0};
}

export function formatDuration(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

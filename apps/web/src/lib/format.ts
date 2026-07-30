/**
 * Display helpers used across the interface.
 *
 * Everything here formats values that arrive as integers and stays integer-based. Any
 * figure a user might act on is rendered from the exact on-chain value, never from a
 * float that rounded on the way in.
 */
import {formatEth, formatWethPerPons} from "@pons/sdk";

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Names an anonymous wallet without pretending it has a profile. */
export const displayName = (a: string) => `${a.slice(2, 6)}${a.slice(-4)}`.toUpperCase();

export function timeAgo(iso: string | number | Date | null | undefined): string {
  if (!iso) return "—";
  const then = typeof iso === "number" ? iso * 1000 : new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Compact ETH for dense rows: 1.2K, 4.37, 0.0081. */
export function compactEth(wei: bigint, decimals = 4): string {
  const whole = wei / 10n ** 18n;
  if (whole >= 1000n) return `${(Number(whole) / 1000).toFixed(2)}K`;
  return formatEth(wei, decimals);
}

export {formatEth, formatWethPerPons};

/** Basis points as a percentage, e.g. 7260 -> "72.6%". */
export function bpsToPercent(bps: number | null | undefined, decimals = 1): string {
  if (bps === null || bps === undefined) return "—";
  return `${(bps / 100).toFixed(decimals)}%`;
}

/** Share of a total, guarding the empty case a percentage cannot express. */
export function sharePercent(part: bigint, total: bigint): number {
  if (total === 0n) return 50;
  return Number((part * 10_000n) / total) / 100;
}

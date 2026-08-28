/**
 * PONS price presentation.
 *
 * The authoritative price is an integer: wei of WETH per 1e18 PONS, as the contract
 * stores it. Everything here converts that integer to text for display. Nothing in this
 * file may ever feed back into a settlement decision, and nothing here uses a float for
 * a value a user is asked to act on.
 */

const WAD = 10n ** 18n;

/**
 * Formats a wei-per-PONS price with enough significant digits to be readable at any
 * magnitude. PONS trades around 0.000216 WETH, where a fixed 4-decimal format would
 * show "0.0002" and hide every move that matters.
 */
export function formatWethPerPons(price: bigint, significant = 4): string {
  if (price === 0n) return "0";
  const whole = price / WAD;
  if (whole > 0n) return `${whole}.${(price % WAD).toString().padStart(18, "0").slice(0, significant)}`;

  const frac = price.toString().padStart(18, "0");
  let firstSignificant = 0;
  while (firstSignificant < frac.length && frac[firstSignificant] === "0") firstSignificant++;
  const digits = frac.slice(firstSignificant, firstSignificant + significant);
  return `0.${"0".repeat(firstSignificant)}${digits}`;
}

/** Percentage change between two prices, in basis points, as an exact integer. */
export function changeBps(from: bigint, to: bigint): bigint {
  if (from === 0n) return 0n;
  return ((to - from) * 10_000n) / from;
}

/** Renders a basis-point change as a signed percentage, e.g. "+1.93%". */
export function formatChangeBps(bps: bigint, decimals = 2): string {
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const scale = 10n ** BigInt(decimals);
  const scaled = (abs * scale) / 100n;
  const text = `${scaled / scale}.${(scaled % scale).toString().padStart(decimals, "0")}`;
  return `${negative ? "-" : "+"}${text}%`;
}

/**
 * Derives an indicative PONS/USD figure.
 *
 * **Display only.** V1 settles strictly on PONS/WETH; this exists so the UI can show a
 * familiar unit, and it inherits the trust assumptions of whatever ETH/USD source is
 * passed in. It must never be shown in a way that suggests it decided a round, and the
 * UI labels it as an estimate wherever it appears.
 *
 * @param wethPerPons wei of WETH per 1e18 PONS (authoritative units)
 * @param ethUsdX8 ETH/USD scaled by 1e8, the usual feed convention
 * @returns USD per PONS scaled by 1e18, or null when no ETH/USD is available
 */
export function ponsUsdX18(wethPerPons: bigint, ethUsdX8: bigint | null | undefined): bigint | null {
  if (ethUsdX8 === null || ethUsdX8 === undefined || ethUsdX8 <= 0n) return null;
  return (wethPerPons * ethUsdX8) / 10n ** 8n;
}

export function formatUsd(usdX18: bigint | null, significant = 4): string {
  if (usdX18 === null) return "—";
  return `$${formatWethPerPons(usdX18, significant)}`;
}

/** Formats a wei amount as ETH with a fixed number of decimals, without floats. */
export function formatEth(wei: bigint, decimals = 4): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const scale = 10n ** BigInt(18 - decimals);
  const scaled = abs / scale;
  const unit = 10n ** BigInt(decimals);
  const text = `${scaled / unit}.${(scaled % unit).toString().padStart(decimals, "0")}`;
  return negative ? `-${text}` : text;
}

/**
 * Converts a Uniswap V3 tick to wei of WETH per 1e18 PONS, matching
 * `TickPriceMath.quoteAtTick` for the live pool where PONS is token1.
 *
 * Provided so a chart can plot ticks the contract would agree with. Note the direction:
 * because PONS is token1, price *falls* as the tick rises.
 */
export function tickToWethPerPons(tick: number, ponsIsToken0: boolean): bigint {
  const ratio = Math.pow(1.0001, tick);
  // Charting only, so a double is acceptable here; every authoritative price comes from
  // the contract as an integer and is never recomputed this way.
  const value = ponsIsToken0 ? ratio : 1 / ratio;
  return BigInt(Math.round(value * 1e18));
}

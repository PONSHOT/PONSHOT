/**
 * Launch parameters, and the measurements behind each one.
 *
 * Every number here is derived from what the live PONS/WETH pool actually does, not from
 * a formula or a round figure. The measurements live in
 * `packages/contracts/test/fork/ManipulationCost.t.sol` and
 * `tools/onchain-audit/observations.py`, and are written up in
 * `docs/TWAP_ANALYSIS.md` and `docs/MANIPULATION_ANALYSIS.md`.
 */

/** Supported round lengths. Launch uses 300s; the contract accepts 60s..1d. */
export const SUPPORTED_INTERVALS = [60, 300, 900, 1800, 3600] as const;
export type RoundInterval = (typeof SUPPORTED_INTERVALS)[number];

export const LAUNCH_INTERVAL_SECONDS = 300;

/**
 * TWAP averaging window for settlement: **300 seconds**, equal to the round interval.
 *
 * The brief suggested starting at 60s. Measurement argues against it.
 *
 * Shifting a `w`-second arithmetic-mean TWAP by `S` basis points requires displacing spot
 * by `S · w / t` bps and holding it for `t` seconds. The cheapest version of that attack
 * holds for the whole window (`t = w`), which needs a spot displacement of exactly `S`
 * — and the *fee* cost of that displacement does not depend on `w` at all. Measured
 * against the real pool, a round trip costs ~198 bps of the amount swapped, so ~0.5 WETH
 * moves spot 160 bps and ~2 WETH moves it 977 bps, whatever the window length.
 *
 * So a longer window does not make the fee cost higher. What it does is force the
 * attacker to *hold* the displacement for longer, exposed the whole time to arbitrage
 * against a visibly mispriced pool — and on a chain producing a block every ~102 ms,
 * 300 seconds is roughly 3,000 blocks of that exposure rather than 600. That exposure is
 * the real defence, and it is the one thing a fork cannot measure, so the window is set
 * to maximise it rather than to a figure that merely sounds prudent.
 *
 * 300s is also the largest window that keeps `window <= interval`, which matters: a
 * longer window would make a round's lock and close windows overlap, so part of the
 * closing average would already be settled before entries even closed. At exactly the
 * interval the two windows are contiguous and disjoint, and the question the market asks
 * becomes a clean one — did PONS average more WETH during this round than during the
 * previous one.
 */
export const LAUNCH_TWAP_WINDOW_SECONDS = 300;

/**
 * Grace period before an unpriced round may be voided: **1800 seconds**.
 *
 * Uniswap V3 records an observation only when a swap moves the tick, so an instant is
 * not immediately quotable. Measured across the pool's entire 20,000-slot buffer
 * (4.58 days of history): gaps between observations run to a median of 6s, p95 of 84s,
 * p99 of 195s and a **maximum of 888s**. 1800s clears that worst case with room to
 * spare, so an ordinarily quiet market can never trigger a spurious cancellation, while
 * a genuine outage still resolves into refunds within half an hour.
 */
export const LAUNCH_BUFFER_SECONDS = 1800;

/** 3% of the pooled stake, against a contract-enforced ceiling of 5%. */
export const LAUNCH_TREASURY_FEE_BPS = 300;
export const MAX_TREASURY_FEE_BPS = 500;

/**
 * Divergence tolerance for the composite oracle, in basis points.
 *
 * Measured, not chosen: across ~2h of matched 300s windows on the two live PONS/WETH
 * pools, natural divergence ran to a median of 38bp and a maximum of 72bp
 * (`tools/onchain-audit/divergence.py`). 100bp would have refused none of those 60 rounds.
 * Tighter and honest rounds start refunding; wider and the shift an attacker can sneak
 * under the gate grows with it.
 */
export const LAUNCH_MAX_DIVERGENCE_BPS = 100;

/**
 * Exposure limits — the parameters that matter most, and the ones set most conservatively.
 *
 * The binding constraint is that what an attacker can *win* stays below what manipulating
 * the oracle *costs*. In a parimutuel round the maximum extractable amount is essentially
 * the losing pool, bounded by `maximumRoundPool`.
 *
 * Both figures below were measured by swapping against the real pools on a fork
 * (`test/fork/CompositeManipulationCost.t.sol`), holding the displacement across a full
 * 300s window:
 *
 * | oracle                          | cost       | shift    | cost per bp |
 * |---------------------------------|------------|----------|-------------|
 * | single 1% pool                  | 2.346 WETH | 1,110 bp | 0.00211 WETH |
 * | composite, *calibrated* attack  | 1.701 WETH |   440 bp | 0.00386 WETH |
 *
 * So the composite costs a tuned attacker **1.83× more per basis point**. It also makes an
 * *untuned* attack worthless: the same 2.35 WETH that moved the single-pool oracle 1,110bp
 * pushes the pools 1,101bp apart, trips the gate, and the round refuses to price. Ratios
 * even 15% off the mark were refused outright in the sweep.
 *
 * The caps therefore rise by the measured factor and no further: 1 ETH became 2 ETH, not
 * 10. **1.83× is real but it is not transformative, and it does not make this a large
 * market.** PONS liquidity is the binding constraint, and no oracle construction over
 * these two pools changes that — raising the caps again needs deeper liquidity, not
 * another aggregation trick.
 */
export const LAUNCH_MINIMUM_BET_WEI = 1_000_000_000_000_000n; // 0.001 ETH
export const LAUNCH_MAXIMUM_BET_WEI = 500_000_000_000_000_000n; // 0.5 ETH
export const LAUNCH_MAXIMUM_ROUND_POOL_WEI = 2_000_000_000_000_000_000n; // 2 ETH

/** Timelock the contract applies to fee and oracle changes. */
export const CONFIG_TIMELOCK_SECONDS = 2 * 24 * 3600;

# TWAP window analysis

The brief suggested starting at a 60-second window and said not to choose the production
value blindly. Having measured the pool, **the production window is 300 seconds**. This
document is the reasoning.

## Inputs

All figures measured on chain 4663, 2026-09-03.

| Input | Measured |
|---|---|
| Block time | ~102.5 ms (~10 blocks/second) |
| Pool depth | ~1,200 WETH + ~5.2M PONS, 1% fee tier |
| Observation cardinality | 20,000, fully initialised |
| Buffer span | 395,971 s = **4.58 days** |
| Max serviceable window | ~396,596 s (binary-searched against `observe()`) |
| Round interval | 300 s |

Availability is not the constraint. A 60-second window and a 3,600-second window are both
comfortably inside a 4.58-day buffer; the choice is about manipulation economics and
product behaviour.

## How a TWAP is actually moved

To shift a `w`-second arithmetic-mean tick by `S` basis points, an attacker must displace
spot by `D` bps and hold it for `t` seconds such that

```
S = D · t / w
```

Two consequences follow, and the second is the one that matters.

**First: sub-second manipulation is worthless.** Uniswap writes at most one observation
per second, recording the tick that held *before* the first swap of that second. A
displacement created and reversed inside one second never enters the accumulator at all.
On a chain with ~10 blocks per second this rules out the entire single-block
flash-loan-and-revert class of attack.

Verified against the live pool: a **250 WETH** round trip inside one second moved spot by
over 40% and moved the settlement TWAP by **exactly zero wei**
(`test_fork_flashMoveOnRealPoolDoesNotMoveTheSettledPrice`,
`test_fork_unheldDisplacementBuysNothing`).

**Second — and this is the uncomfortable one: a longer window does not raise the fee cost
of the attack.** The cheapest attack holds the displacement for the whole window, i.e.
`t = w`, which needs `D = S`. The fee cost of displacing spot by `S` bps is a property of
the pool's liquidity curve, not of `w`. Doubling the window doubles the *time* the
attacker must hold, not the *fee* they pay.

Measured round-trip cost, against real liquidity:

| Spot displacement | WETH deployed | Round-trip cost | Cost as bps of size |
|---|---|---|---|
| 6 bps | 1 | 0.0199 WETH | 198 |
| 160 bps | 25 | 0.496 WETH | 198 |
| 414 bps | 50 | 0.986 WETH | 197 |
| 977 bps | 100 | 1.950 WETH | 194 |
| 2,480 bps | 250 | 4.708 WETH | 188 |

The cost is essentially the double 1% fee, and it is *sublinear per basis point* — larger
attacks are cheaper per bp of displacement, because fees scale linearly with size while
price impact scales faster.

## So what is the window actually buying?

Exposure time. The attacker must hold a visibly mispriced pool for `t` seconds while
arbitrageurs — including anyone running against the 0.3% PONS/WETH pool, which is not
being manipulated — trade against them. At ~102.5 ms per block:

| Window | Blocks of exposure at full hold |
|---|---|
| 60 s | ~585 |
| 300 s | ~2,930 |
| 3,600 s | ~35,100 |

That arbitrage cost is real, is the dominant term in practice, and is precisely what a
fork cannot measure — a forked chain has no arbitrageurs. So it is treated as **upside,
not as a safety budget**: the exposure limits in
[MANIPULATION_ANALYSIS.md](MANIPULATION_ANALYSIS.md) are set against the fee-only floor,
and the window is then chosen to maximise the exposure on top of it.

## Why not longer than 300 s?

Because `window <= interval` must hold.

A round's lock window is `[L − w, L]` and its close window is `[C − w, C]` where
`C = L + interval`. If `w > interval` the two overlap, and at the moment entries close
part of the closing average is already determined. At exactly `w = interval` the windows
are contiguous and disjoint:

```
round n:   [ lock window ][ close window ]
           L−300         L              L+300
```

and the market asks a clean question: *did PONS average more WETH during this round than
during the previous one?*

This is enforced, not merely intended: `Deploy.s.sol` refuses to deploy when
`twapWindow > interval`.

## Why not shorter?

A 60-second window costs the same in fees to move and buys a fifth of the arbitrage
exposure. There is no argument for it here beyond familiarity.

A shorter window would only become preferable if PONS liquidity deepened enough that fee
cost alone dominated — at which point responsiveness would be worth buying. That is not
the current situation.

## Precision

Prices are wei of WETH per 1e18 PONS. At the current price of ~2.16e14, one tick (1 bp) is
~2.2e10 wei — nine orders of magnitude above the 1 wei granularity. Rounding-induced ties
are therefore not a practical concern, though `closePrice == lockPrice` is still handled
explicitly as a tie and refunds in full.

`meanTick` rounds toward negative infinity, matching Uniswap's own convention, so the
rounding direction does not depend on the sign of the tick
(`testFuzz_meanTickMatchesUniswapConvention`).

## Availability, and the cost of insisting on it

The window is available. What is *not* instantaneous is sealing — see
[ORACLE.md](ORACLE.md). Measured gap distribution across the full buffer:

| statistic | gap | seal lag for a random instant (length-weighted) |
|---|---|---|
| median | 6 s | 60 s |
| p75 | 20 s | — |
| p90 | 51 s | 232 s |
| p95 | 84 s | 308 s |
| p99 | 195 s | 521 s |
| **max** | **888 s** | **888 s** |

Recent activity is in line: over the last 24 h, mean 22 s, p95 99 s, max 888 s.

`bufferSeconds` is therefore **1800 s** — comfortably above the worst observed lag, so an
ordinary quiet stretch can never void a round, while a genuine outage still resolves into
refunds within half an hour. The contract enforces a floor of 900 s on this parameter so
it cannot be configured below the measured worst case.

## Reproducing

```bash
python3 tools/onchain-audit/observations.py

anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546 &
ROBINHOOD_RPC=http://127.0.0.1:8546 forge test --mc ManipulationCost -vv
```

# Oracle specification

## What is being measured

A round's prices are defined as arithmetic-mean-tick TWAPs over **closed historical
windows fixed by the round's own schedule**:

```
lockPrice(n)  = TWAP over [ lockTimestamp(n)  − w , lockTimestamp(n)  ]
closePrice(n) = TWAP over [ closeTimestamp(n) − w , closeTimestamp(n) ]
```

where `w` is the round's `twapWindow`, snapshotted when the round was created.

Both are converted to **wei of WETH per 1e18 PONS**, 18-decimal fixed point, using
integer arithmetic only (`TickPriceMath`, adapted from Uniswap's `OracleLibrary`).

The important word is *historical*. This is not "the price around now". The answer is a
pure function of `(instant, window)` and committed pool history, so:

- a keeper that settles 40 seconds late produces byte-identical state to one that settles
  on time;
- nothing the settling transaction does can influence its own reading;
- and therefore **the lifecycle transitions can be permissionless**, because no caller
  gains anything from choosing when to call.

That last point is the design's keystone. It is why a compromised keeper cannot pick a
price, and why a dead keeper cannot hold the market hostage.

## The direction trap

In Uniswap V3, `1.0001^tick = token1 per token0` in raw units. In the settlement pool
WETH is token0 and PONS is token1, so the quoted PONS price is `1 / 1.0001^tick` and is
**strictly decreasing in tick**.

`TickPriceMath.quoteAtTick` handles both orderings and the oracle resolves which applies
by reading `token0()`/`token1()` at construction. There is no `PONS_IS_TOKEN0` constant
anywhere, because a constant is exactly what would eventually be wrong.

Covered by `test_priceDecreasesAsTickRises_whenBaseIsToken1`,
`testFuzz_quoteIsMonotonicInTick`, and — against the live pool, by actually selling PONS —
`test_fork_sellingPonsLowersItsPrice`.

## The sealing rule

This is the least obvious part of the design and the part most worth reading carefully.

`observe()` will answer for an instant **newer than the pool's most recent observation**.
It does so by extrapolating from that observation using the pool's *current* tick:

```solidity
// Uniswap v3-core, Oracle.getSurroundingObservations
if (beforeOrAt.blockTimestamp <= target) {
    if (beforeOrAt.blockTimestamp == target) return (beforeOrAt, atOrAfter);
    else return (beforeOrAt, transform(beforeOrAt, target, tick, liquidity));
    //                                                     ^^^^ live tick
}
```

If the newest observation is 130 seconds old — which was directly observed on this pool —
then a 60-second window asked for "now" would be composed **entirely** of the live tick.

So `UniswapV3PonsOracle` refuses to answer until the target instant is **sealed**: the
pool must already hold an observation at or after it. Once that holds, both endpoints are
interpolated purely between committed observations.

### Why sealing is required, precisely

It is worth being exact, because the obvious justification is not quite the real one.

An unsealed reading is not, in fact, freely manipulable. To poison the extrapolated tail
an attacker must change the tick — and changing the tick *writes an observation at the
current timestamp*, which seals the target and records the honest pre-swap tick for the
interval before it. The attack seals the very window it was trying to corrupt.

The real problem is **determinism**. While a target is unsealed, its computed value
depends on the live tick, so reading at `T+1` and reading at `T+50` can differ. That
hands whoever settles a free option: look at both, pick the better one. Since the whole
architecture rests on "nobody can influence a price by choosing when to act", that option
must not exist. Sealing removes it.

Demonstrated by `test_sealedReadingIsIndependentOfWhoWaitsHowLong` and
`test_anyoneCanDriveTheLifecycleWithTheSameResult`.

### What sealing costs

Uniswap writes an observation only when a swap **moves the tick**, at most once per
second. So sealing is not instantaneous, and a quiet market delays it. Measured across
the pool's full 20,000-slot buffer:

| statistic | gap between observations |
|---|---|
| median | 6 s |
| p95 | 84 s |
| p99 | 195 s |
| **max** | **888 s** |

This is why round progression is **decoupled** from price availability. A round past its
lock time stops taking entries immediately and acquires its price later — at the value it
was always going to have. Only if the price is still unavailable `bufferSeconds`
(1800 s) after it was due does the round become cancellable, refunding everyone in full.

See [TWAP_ANALYSIS.md](TWAP_ANALYSIS.md) for the full distribution and how the window was
chosen.

## Interface

```solidity
interface IPredictionOracle {
    function description() external view returns (string memory);
    function decimals() external pure returns (uint8);
    function oracleVersion() external view returns (uint64);
    function getPrice() external view returns (uint256 price, uint256 timestamp);
    function getPriceAt(uint256 targetTimestamp, uint32 twapWindow)
        external view returns (uint256 price, int24 meanTick);
    function canQuote(uint256 targetTimestamp, uint32 twapWindow)
        external view returns (bool ok, string memory reason);
    function earliestAvailableTimestamp() external view returns (uint256);
}
```

Two deliberate departures from the interface sketched in the brief:

- **`getPriceAt` exists**, because settlement needs a price *as of a specific past
  instant*, not a current one. Without it, settlement would inherit keeper latency.
- **`getPrice()` returns a TWAP, not spot.** A consumer holding only the generic
  interface should not be able to settle on a manipulable number by accident. Spot is
  available separately as `getSpotPrice()` and is labelled display-only everywhere it
  appears, including in the UI.

`canQuote` exists so callers can ask "could this settle now?" without paying for a revert.
The market wraps `getPriceAt` in `try/catch`, so a broken or hostile oracle degrades a
round to *unpriced* — and eventually refundable — rather than bricking the market.

## Failure modes and responses

| Condition | Oracle behaviour | Market behaviour |
|---|---|---|
| Target in the future | revert `TargetInFuture` | not yet actionable |
| Target not yet sealed | revert `TargetNotSealed` | round waits; cancellable after `bufferSeconds` |
| Window predates the ring buffer | revert `HistoryEvicted` | same |
| `window == 0` or `> 7 days` | revert | rejected at configuration time |
| Pool never initialised its buffer | `canQuote` → `HISTORY_EVICTED` | deploy preflight refuses to deploy |
| Price rounds to zero | revert `QuoteIsZero` | round waits, then refunds |
| Oracle reverts on everything | caught by `try/catch` | round refunds after tolerance |
| Malformed cumulative tick | revert `MeanTickOutOfRange` | round refunds after tolerance |

## Observation cardinality

The pool's buffer is already at **20,000 slots, fully initialised, holding 4.58 days**.
`increaseObservationCardinalityNext()` is **not needed**. The adapter exposes
`increasePoolCardinality()` for operational convenience only; it changes nothing about
pricing.

The deploy script refuses to proceed if `cardinality <= 1`, or if the configured window is
not already serviceable by a live `observe()` call.

## The composite oracle

Production settles on `CompositePonsOracle`, not the single-pool adapter. It reads both
live PONS/WETH pools, normalises each to a common orientation (so pools with opposite
token ordering can be compared at all), requires them to agree within 100 basis points,
and returns the median tick.

Everything in this document still applies per source: each pool's target instant must be
sealed, each must hold the window in its ring buffer, and an unavailable source stops the
quote rather than being skipped — silently dropping one would hand an attacker the
cheapest attack available, namely stall a pool and then move the survivor alone.

`UniswapV3PonsOracle` remains in the tree, fully tested, and is selectable with
`ALLOW_SINGLE_SOURCE_ORACLE=true`. It is the simpler construction and the right choice if
a pair ever has only one venue worth reading.

See [MANIPULATION_ANALYSIS.md](MANIPULATION_ANALYSIS.md) for what the composite is measured
to buy, and what it is not.

## Migration

Each round snapshots its own `oracle`, `twapWindow`, `treasuryFeeBps` and `oracleVersion`
into `RoundTerms` at creation. Changing the oracle is timelocked (2 days) and can only
ever reach rounds that do not yet exist. A round therefore carries, on chain, the proof of
which rules applied when users entered it.

`test_configChangesCannotReachAnAlreadyOpenRound` pins this.

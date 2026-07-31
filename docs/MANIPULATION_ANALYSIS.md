# Manipulation analysis

**Summary: PONS liquidity is shallow relative to any interesting prediction volume. A
composite oracle across both live pools makes an untuned attack worthless and raises a
tuned attacker's cost by a measured 1.83×, so the caps rise from 1 ETH to 2 ETH per round
— and no further. That factor is real but not transformative; liquidity remains the
binding constraint.**

Every figure below was measured by swapping against a fork of the live pool
(`packages/contracts/test/fork/ManipulationCost.t.sol`), not derived from a liquidity
model. A model is only as good as its assumptions about the tick distribution; trading
against the real pool has none.

## The pool

| | Settlement pool (1%) | Second pool (0.3%) |
|---|---|---|
| Address | `0x10CC…26bA` | `0xEd50…22fF` |
| WETH | ~1,200 | ~584 |
| PONS | ~5.2M | ~1.85M |
| Observation cardinality | 20,000 | 1,400 |

Approximate TVL of the settlement pool: ~2,400 WETH-equivalent. PONS's fully-diluted
valuation at the current price is on the order of 216,000 WETH, so **the float is thin
relative to the supply** — a structural reason to expect the price to be movable.

## Threat 1 — flash manipulation (single block or single second)

**Cost: irrelevant. Effect: exactly zero.**

Uniswap V3 writes an observation only when a swap *moves the tick*, at most once per
second, and records the tick that held *before* that swap. A displacement created and
reversed inside one second never reaches the accumulator.

Measured on the live pool: a **250 WETH** buy followed immediately by selling the entire
proceeds back moved spot by **more than 40%** and moved the settlement TWAP by **0 wei**.

At ~102.5 ms per block, a whole second is ~10 blocks, so this also disposes of
multi-block-but-sub-second bundles. Flash loans do not help: the constraint is *time
held*, not capital.

Tests: `test_fork_flashMoveOnRealPoolDoesNotMoveTheSettledPrice`,
`test_fork_unheldDisplacementBuysNothing`, `test_subSecondManipulationDoesNotMoveTwap`.

## Threat 2 — a held displacement across the settlement window

This is the attack that works, and it must be priced honestly.

Measured cost to shift a 60-second settlement TWAP, **assuming no arbitrageur reacts**:

| Capital | Held | TWAP shift | Cost | Cost per bp |
|---|---|---|---|---|
| 25 WETH | 5 s | 12 bps | 0.496 WETH | 0.0413 WETH |
| 25 WETH | 15 s | 39 bps | 0.496 WETH | 0.0127 WETH |
| 25 WETH | 30 s | 81 bps | 0.496 WETH | 0.0061 WETH |
| 50 WETH | 30 s | 211 bps | 0.986 WETH | 0.0047 WETH |
| 100 WETH | 30 s | 483 bps | 1.949 WETH | 0.0040 WETH |
| 250 WETH | 30 s | 1,178 bps | 4.707 WETH | 0.0040 WETH |

Two things to take from this table.

**The cost does not depend on hold time — only the achieved shift does.** The fee is paid
once on the round trip. Holding longer converts the same fee into a larger shift, which
is why the cost per basis point falls fivefold between a 5-second and a 30-second hold.

**Larger attacks are cheaper per basis point.** Fees scale linearly with size; price
impact scales faster. There is no size at which this becomes uneconomic on its own.

At scale the floor is roughly **0.004 WETH per basis point of TWAP movement**.

### What this table does not include

Arbitrage. On a fork there is nobody to trade against the attacker. In reality holding a
double-digit-percent mispricing for hundreds or thousands of blocks — with a second,
un-manipulated PONS/WETH pool sitting right there for arbitrageurs to price against —
would cost far more than the fee.

That cost is real and probably dominant. It is deliberately **not** used to justify the
exposure limits, because it cannot be measured here and it evaporates exactly when it is
most needed (a quiet market, a network incident, a weekend). The fee-only figures are a
hard floor, and the limits are set against the floor.

## Threat 3 — the split-liquidity problem

PONS liquidity is spread across two live pools and the oracle reads only one. This cuts
both ways:

- *Against the attacker*: manipulating the 1% pool alone opens an arbitrage gap against
  the 0.3% pool, which arbitrageurs will close at the attacker's expense.
- *For the attacker*: the capital needed to move the settlement price is only the capital
  needed to move **one** pool, not the whole PONS market. The 1% pool's ~1,200 WETH is
  the number that matters, not the ~1,800 WETH across both.

The second effect is already reflected in the measurements above, since they were taken
against the settlement pool alone.

## The composite oracle, measured

The market settles on `CompositePonsOracle`, which reads **both** live PONS/WETH pools and
requires them to agree within 100 basis points before it answers.

The gate tolerance is the number the whole thing turns on, and it is empirical. Across ~2h
of matched 300s windows the two pools' natural divergence ran to a median of 38bp and a
maximum of 72bp (`tools/onchain-audit/divergence.py`); 100bp would have refused none of
those 60 rounds while capping a single-pool shift near half the gate.

### What it buys, measured on the real pools

From `test/fork/CompositeManipulationCost.t.sol`, holding each displacement across a full
300s window:

| Attack | Cost | Result |
|---|---|---|
| Move the 1% pool only, against the **single-pool** oracle | 2.346 WETH | settlement price shifts **1,110 bp** |
| Move the 1% pool only, against the **composite** | 2.346 WETH | pools diverge 1,101bp → gate trips → **round refuses to price, attacker gains nothing** |
| Move both pools, split 100:100 | 1.529 WETH | spread 176bp → **refused** |
| Move both pools, split 100:115 | 1.557 WETH | spread 133bp → **refused** |
| Move both pools, split 100:130 | 1.595 WETH | spread 90bp → shift 394bp, 0.00405 WETH/bp |
| Move both pools, split 100:145 | 1.643 WETH | spread 46bp → shift 417bp, 0.00394 WETH/bp |
| Move both pools, **calibrated** 100:160 | 1.701 WETH | spread 2bp → shift **440bp**, **0.00386 WETH/bp** |

Two things follow.

**A single-pool attack is neutralised outright.** The same capital that moved the old
oracle by 11% now trips the gate: the oracle reports unavailable, the round refunds, and
the attacker has paid both fee tiers for nothing.

**A calibrated two-pool attack still works, at 1.83× the cost.** 0.00386 WETH/bp against
0.00211 WETH/bp for the single-pool oracle at the same window. The attacker must also tune
the split: at 100:100 and 100:115 the sweep refused the attack outright, so any drift
during the hold risks losing the whole thing.

### What it does not buy

It does not average a manipulated pool away. With two sources the median sits between them,
so a divergence tolerated by the gate still moves the answer by up to half of it. The gate
is the protection; the median only limits what slips under it.

Nor does it change the fundamental position. **1.83× is a real improvement and it is not a
transformative one.** Adding more PONS/WETH pools would help only if they held comparable
depth, and there are none — the 0.1% and 0.05% tiers are empty.

### Availability cost: none worth noting

Requiring both sources could have made settlement less available. Measured, it does not:
the 0.3% pool's observation gaps run to a **maximum of 108s** against the 1% pool's 888s,
so the binding seal lag is unchanged. Its ring buffer is shorter (1,400 slots ≈ 2.4h
against 20,000 ≈ 4.6 days), which caps how far back the composite can price — comfortably
beyond the 1800s cancellation tolerance, and checked by the deploy preflight.

## Setting the exposure limits

In a parimutuel round, the most an attacker can extract is essentially **the losing
pool** — bounded above by `maximumRoundPool`. The attack shape is: enter the minority
side, then force it to win.

Required shift: whatever it takes to move the close TWAP across the lock price. The
attacker can observe the natural move before acting, so this is often small. Against the
measured floor of ~0.004 WETH/bp, forcing a few hundred basis points costs on the order
of **1–2 WETH**.

Launch limits are therefore:

| Parameter | Value | Rationale |
|---|---|---|
| `maximumRoundPool` | **2 ETH** | 1 ETH scaled by the measured 1.83× the composite adds, rounded down |
| `maximumBet` | **0.5 ETH** | Forces at least four participants to reach the cap |
| `maxDivergenceBps` | **100** | Above the 72bp natural maximum; refused 0/60 honest rounds |
| `minimumBet` | 0.001 ETH | Dust protection |
| `twapWindow` | 300 s | Maximises arbitrage exposure; see [TWAP_ANALYSIS.md](TWAP_ANALYSIS.md) |
| `treasuryFeeBps` | 300 | Contract-enforced ceiling of 500 |

These are small. That is the honest consequence of the measurements, not excessive
caution. **A 1,200 WETH pool cannot safely secure a large prediction market**, and no
parameter choice inside this contract changes that.

Option 2 below has now been taken; what remains is genuinely harder.

1. **Materially deeper PONS liquidity.** The only lever that scales.
2. ~~A composite oracle across several venues.~~ Done — measured at 1.83×, above.
3. An explicit, documented decision to accept a manipulation-positive expected value on a
   capped notional.

Whichever is chosen, the analysis has to be redone against fresh measurements.

## Threat 4 — settlement timing

Not available. A round's price is a pure function of its scheduled timestamps and
committed pool history, so no participant — keeper, admin, bettor, MEV searcher — gains
anything by choosing when to settle. Late settlement produces byte-identical state.

Tests: `test_anyoneCanDriveTheLifecycleWithTheSameResult`,
`test_lateLockUsesTheScheduledInstantNotTheExecutionTime`,
`test_sealedReadingIsIndependentOfWhoWaitsHowLong`.

## Threat 5 — front-running and back-running entries

Entries are visible in the mempool, and a searcher can enter after seeing a large entry
in order to take the better side. This is inherent to a transparent parimutuel and is not
an exploit: it moves the multiplier, and the multiplier is labelled an *estimate*
everywhere it appears in the UI.

What is not possible: front-running the *settlement*, because the price is fixed by the
schedule long before any settlement transaction exists.

## Threat 6 — liquidity withdrawal

An LP removing the pool's liquidity does not corrupt history — past observations remain —
but makes future prices trivially movable. Responses available:

- `pausePrediction()` stops new entries immediately;
- rounds already open settle normally if their instants are already sealed;
- `emergencyCancelRound` voids rounds whose price is genuinely unavailable;
- `poolLiquidity()` is surfaced on the admin dashboard and should be alerted on.

The contract does **not** gate settlement on liquidity: doing so would make the outcome
depend on the pool's state at settlement time, reintroducing exactly the timing dependence
the design removes.

## Threat 7 — pool migration

If the canonical PONS market moves, the oracle can be repointed for **future rounds only**,
behind a 2-day timelock, and each round records the oracle and version that governed it.
An open round can never have its price source changed.

## Residual risk

With `maximumRoundPool = 2 ETH`, a **calibrated** two-pool attacker spending ~1.7 WETH in
fees — plus whatever arbitrage costs them over a 300s hold — can win up to ~2 ETH. **The
expected value of that attack is negative but not by a wide margin**, and it turns positive
if the caps are raised again without deeper liquidity. An *uncalibrated* attacker loses the
whole outlay, which is the composite's main contribution.

This is stated plainly because it is the single most important operational fact about the
system. It is monitored (see [MONITORING in SECURITY.md](SECURITY.md)) and it is the first
thing an audit should scrutinise.

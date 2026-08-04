# Security

**No production deployment has been made, and none should be made before an independent
audit.** Passing tests is not an audit. This document exists to tell an auditor where to
look and what was already considered.

## Where the risk actually is

Not in the accounting, which is small, integer-only and covered by fuzz and invariant
tests. It is in the **economics of the oracle**: the PONS/WETH pool holds ~1,200 WETH, and
the measured fee-only cost of shifting its TWAP is low enough that the exposure limits had
to be set to 1 ETH per round. See [MANIPULATION_ANALYSIS.md](MANIPULATION_ANALYSIS.md).
That is the first thing to scrutinise.

## Threats considered

| Threat | Position |
|---|---|
| Flash-loan / single-block manipulation | **Ineffective.** Uniswap records at most one observation per second, using the pre-swap tick; a displacement not held across a second boundary never enters the accumulator. Measured: 250 WETH round-tripped in one second moved the TWAP by 0 wei |
| Held TWAP manipulation | **Possible and priced.** Against the composite oracle a *calibrated* two-pool attack costs 0.00386 WETH/bp, measured; an *uncalibrated* one is refused outright and loses the whole outlay. Exposure limits set against that floor |
| Single-pool manipulation | **Neutralised.** Moving one pool past the 100bp gate makes the oracle report unavailable and the round refund. Measured: 2.35 WETH that shifted a single-pool oracle 1,110bp achieved nothing |
| Low-liquidity attack | Structural. Addressed by caps, not by cleverness |
| Settlement timing / MEV | **Not available.** Prices are pure functions of the schedule; late settlement is byte-identical |
| Front-running entries | Inherent to a transparent parimutuel. Multipliers are labelled estimates everywhere |
| Keeper compromise | Grants nothing an anonymous caller lacks. Lifecycle is permissionless |
| Keeper failure | Cannot stall the market; anyone can advance it. Prolonged oracle failure refunds |
| Reentrancy | Pull-based claims, `nonReentrant`, checks-effects-interactions. Attacker test asserts both sides of the ledger |
| DoS by hostile recipient | Settlement moves no ETH, so it cannot be blocked. One rejecting recipient cannot block another user |
| Admin compromise | No path to a price, an entry, an outcome, or user funds. Fee and oracle changes timelocked and snapshotted per round |
| Round timestamp manipulation | Schedule derives from stored timestamps, never the executing block |
| Forced ETH (`selfdestruct`) | Never counted as a liability; can only increase solvency |
| Rounding | Floors toward the contract. Dust is permanent and on the solvent side |
| Double claim | `claimed` flag set before transfer; duplicate epochs in one call rejected |
| Reorg | Contract is unaffected. Indexer stays behind head, verifies the last block hash, rewinds and replays idempotently |
| Pool migration | Oracle repointable for future rounds only, timelocked, with per-round version recorded |
| Liquidity removal | Pausable; `poolLiquidity()` surfaced for alerting. Settlement is deliberately not gated on liquidity, which would reintroduce timing dependence |

## What no role can do

There is no function by which any role can set a price, alter a placed bet, change a
recorded outcome, claim on a user's behalf, or withdraw ETH owed to users.

- `claimTreasury` is bounded by `treasuryAmount`, which only grows from fees booked at
  settlement.
- `pausePrediction` stops new entries only; settlement, claims and refunds continue.
- `emergencyCancelRound` is refused whenever a round can be settled — its only outcomes
  are full refunds.
- Fee changes are capped at 5% by an immutable constant, timelocked 2 days, and
  snapshotted per round.

Pinned by `test_operatorRoleGrantsNoEconomicPower`, `test_adminCannotVoidARoundThatCanBeSettled`,
`test_settledRoundIsImmutable`, `test_configChangesCannotReachAnAlreadyOpenRound`,
`test_treasuryCannotOverdrawIntoUserFunds`.

## Defects found in the pre-launch review

Recorded because "we tested it" is not the same as "we looked for this", and an auditor
should know what has already been swept.

| Defect | Why it mattered | Fix |
|---|---|---|
| `executeRound`/`pendingWork` scanned `bufferSeconds / interval` rounds unbounded | At the allowed maximum tolerance that is 10,083 iterations with an external call each — past the block gas limit. One `setBufferSeconds` call could have bricked the keeper path and the ops dashboard | `MAX_SCAN_ROUNDS = 64` clamps the loop, and `_checkTolerance` rejects a tolerance the scan could not cover, so the limit is enforced where it is set rather than silently truncating |
| `baseUnit = uint128(10 ** baseDecimals)` truncated silently for decimals 39–77 | Fits `uint256` but overflows `uint128`, so every price the oracle returned would be wrong by an invisible factor. The contract also never verified the decimals it was handed | Rejects decimals above 38, and cross-checks the declared value against the token's own `decimals()` when it exposes one |
| `oracle.oracleVersion()` was read unguarded while creating a round | Provenance metadata could revert `executeRound` wholesale, discarding the lock and settle work already done in the same transaction | Wrapped in `try/catch`; an unavailable version records 0 rather than halting the schedule |
| `code.length > 0` used to mean "is a contract" in the deploy preflight | **Defeated by EIP-7702.** A delegated EOA carries 23 bytes of code (`0xef0100` + address) while staying under one private key — and Anvil's first account already has such a delegation on chain 4663, so the naive check waved it through as a multisig | `_isContract` rejects the 7702 designator explicitly |
| Fork tests reported PASS when the RPC was unreachable | A green CI run could mean "verified nothing" against the live chain | The skip is now loud, and `REQUIRE_FORK=true` (set in CI) turns it into a failure |
| Well-known Anvil keys are used throughout local tooling | One copied command and a public key owns a live market's admin role, or funds its keeper | Both the keeper and the deploy script refuse a known development key on any non-local chain |

## Known limitations

1. **Exposure caps are low** (2 ETH per round) and are a direct consequence of pool depth.
   The composite oracle bought a measured 1.83×, which is why the cap doubled rather than
   moved an order of magnitude. Raising it again needs deeper PONS liquidity — there is no
   third pool of comparable depth to add.
2. **Fee-only manipulation cost is a floor, not an estimate.** Real cost includes
   arbitrage, which is larger but unmeasurable on a fork and unreliable exactly when it
   matters most.
3. **Settlement can be delayed by a quiet market.** Measured worst case 888 s. The price
   does not change while waiting, but users see "awaiting settlement".
4. **Only two venues exist.** Both are now consulted. The 0.1% and 0.05% tiers hold
   nothing, so there is no further diversification available on this pair.
5. **Admin must be a multisig, and the deploy script now enforces it** — rejecting EOAs
   and EIP-7702 delegated EOAs unless `ALLOW_EOA_ADMIN=true` is set deliberately.
6. **No formal verification** of the payout arithmetic beyond fuzz and invariant testing.
7. **A long keeper outage takes a while to unwind.** The schedule is fixed, so rounds are
   created one per transaction. After a day's outage on 5-minute rounds that is ~288 calls
   — the keeper does this automatically at its poll cadence, and no funds are at risk
   (nobody could enter during the outage), but there is no live round to bet on until it
   catches up. Rounds older than the 64-round scan window need the per-epoch
   `cancelRound`, which is permissionless; they are empty, so nothing is at stake.

## Monitoring

Alert on:

| Condition | Why |
|---|---|
| `solvency().solvent == false` | Critical. Should be impossible |
| `pendingWork().cancellable` non-empty | Rounds are stuck past tolerance |
| Rounds unresolved beyond one interval | Keeper or oracle degraded |
| `secondsSinceLastObservation` > 900 | Leading indicator of stalled settlement |
| Pool liquidity dropping sharply, in *either* pool | Manipulation cost falling |
| Composite source spread widening | Leading indicator of both a manipulation attempt and of one pool drying up. Read it from `CompositePonsOracle.inspect()` |
| Round pool approaching `maximumRoundPool` | Exposure at the limit |
| Keeper `/ready` returning 503 | |
| Operator balance below floor | Keeper will stop sending |
| Indexer lag growing | Read model going stale |
| Market paused | Should be deliberate |
| Any `RoleGranted`/`RoleRevoked`/config event | Should be deliberate |

## Before any mainnet deployment

1. Independent audit by a firm experienced with Uniswap V3 oracles.
2. Re-run [MANIPULATION_ANALYSIS.md](MANIPULATION_ANALYSIS.md) against liquidity as it
   stands on the day.
3. Move `DEFAULT_ADMIN_ROLE` to a multisig; keep the keeper key separate and hot.
4. Deploy with the smallest workable caps and raise them only with evidence.
5. Run on a testnet with a live keeper and indexer for a sustained period first.
6. Publish the oracle's rules, the caps, and this document alongside the interface.

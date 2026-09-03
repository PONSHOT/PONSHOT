# Round lifecycle

## Schedule

Rounds overlap, and each round's close instant *is* the next round's lock instant:

```
round n:      start ──────────── lock ──────────── close
round n+1:                 start ──────────── lock ──────────── close
round n+2:                                start ──────────── lock ────────────

              closeTimestamp(n) == lockTimestamp(n+1)      ← invariant, by construction
              lockTimestamp(n)  == startTimestamp(n+1)
```

Consequences:

- One oracle reading serves both round *n*'s close and round *n+1*'s lock, so consecutive
  rounds cannot disagree about the same instant and no stretch of time goes unmeasured.
- There is always a future round accepting entries.

Times for a new round are derived from the **previous round's stored timestamps**, never
from the executing block, so a late keeper cannot make the schedule drift
(`test_lateExecutionDoesNotDriftTheSchedule`).

### Changing the interval

`startNextRound` sets `lockTimestamp(n+1) = closeTimestamp(n)` and
`closeTimestamp(n+1) = lockTimestamp(n+1) + interval`. Deriving the next lock from the
previous *close* rather than by adding an interval is what preserves the boundary
invariant across a configuration change. One transitional round has an entry window of
the old length and a live window of the new one; everything after it is consistent, and
the invariant never breaks (`test_intervalChangePreservesTheBoundaryInvariant`).

## Stored status

```solidity
enum RoundStatus { Pending, Open, Locked, Settled, Cancelled }
```

Legal transitions, and nothing else:

```
Pending ──► Open ──► Locked ──► Settled
              │         │
              └─────────┴────► Cancelled
```

## Derived phase

`Open` covers two situations the UI must distinguish: taking entries, and *entries closed
but no price available yet*. `phaseOf()` exposes the finer view:

| Phase | Meaning |
|---|---|
| `Open` | accepting entries (`now < lockTimestamp`) |
| `AwaitingLock` | entries closed, lock price not yet obtainable |
| `Live` | locked, running |
| `AwaitingSettle` | close time passed, close price not yet obtainable |
| `Settled` | resolved |
| `Cancelled` | voided; everyone refundable |
| `Cancellable` | stuck past tolerance; anyone may void it |

## Progression is decoupled from pricing

The pool cannot always price an instant the moment it passes — Uniswap records an
observation only when a swap moves the tick, and the measured worst case was 888 s.
If round *n+1* could not open until round *n* had a price, one quiet stretch would stall
the product.

So the two are independent:

- **Entries close on the clock.** A round past `lockTimestamp` refuses stakes immediately,
  whether or not anyone has locked it (`test_rejectsEntryOnceLockTimeHasPassedEvenIfUnlocked`).
- **The next round opens on the clock**, regardless of oracle availability
  (`test_nextRoundOpensEvenWhenThePriceIsUnavailable`).
- **The price is attached when it becomes obtainable**, at the value it always would have
  had.

## Who may drive it

Everyone. `lockRound`, `settleRound`, `startNextRound` and `cancelRound` are
permissionless.

That is safe *because* prices are pure functions of the schedule: every caller produces
identical state, so there is nothing to gain by calling — or by not calling. The keeper in
`apps/keeper` is a convenience, and a compromised or dead keeper cannot pick a price,
censor a round, or hold funds.

Only `genesisStartRound` needs `OPERATOR_ROLE`, because it is the one call that chooses
where the schedule begins.

## Outcomes

| Condition | Outcome | Effect |
|---|---|---|
| `closePrice > lockPrice` | `Bull` | UP wins |
| `closePrice < lockPrice` | `Bear` | DOWN wins |
| `closePrice == lockPrice` | `Tie` | full refund, no fee |
| either side has no stake | `NoContest` | full refund, no fee |

`NoContest` covers both directions, which is a deliberate extension of the brief. The
brief requires refunding when the *winning* side is empty (otherwise the treasury would
absorb the losing pool). The mirror case — winners with no counterparty — is treated the
same way, because there was nothing to win and charging a rake on a bettor's own stake
would be a pure loss for being right. Where both sides have stake, the brief's formula
applies exactly.

See [ACCOUNTING.md](ACCOUNTING.md).

## Cancellation

A round becomes cancellable when its required price is *still* unobtainable
`bufferSeconds` after it was due. Anyone may then void it, and every participant recovers
100% of their stake with no fee.

Lateness alone is never grounds for voiding: if the price becomes available during the
grace period, the round settles normally at the value it always had
(`test_aLatePriceStillSettlesRatherThanCancelling`).

`emergencyCancelRound` (PAUSER_ROLE) is deliberately powerless over decided rounds. It is
permitted only when the round is still taking entries — so no outcome exists yet — or when
the price is genuinely unavailable right now. If a round *can* be settled, no role can
void it (`test_adminCannotVoidARoundThatCanBeSettled`).

## Worked example

Interval 300 s, window 300 s.

```
12:00:00  round 100 opens                     entries accepted
12:05:00  round 100 locks   price = TWAP[12:00:00, 12:05:00]
          round 101 opens                     entries accepted
12:10:00  round 100 closes  price = TWAP[12:05:00, 12:10:00]
          round 101 locks   price = TWAP[12:05:00, 12:10:00]   ← same reading
          round 102 opens
```

If the keeper is 4 minutes late at 12:10, nothing changes: both prices are still the
windows ending at 12:10:00, round 102 still opens with `start = 12:10:00`, and the only
visible difference is `settledAt`/`lockedAt`, which the indexer records as the seal lag.

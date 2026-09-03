# Architecture

## Shape

```
                    ┌──────────────────────────┐
   users ── ETH ───►│      PonsPrediction      │◄── anyone: lock / settle / cancel
                    │  rounds · payouts · claims│    (permissionless lifecycle)
                    └────────────┬─────────────┘
                                 │ IPredictionOracle
                                 ▼
                    ┌──────────────────────────┐
                    │   UniswapV3PonsOracle    │
                    │  historical-window TWAP  │
                    └────────────┬─────────────┘
                                 ▼
                    PONS/WETH Uniswap V3 pool (1%)

   PonsPrediction events ──► indexer ──► PostgreSQL ──► read API ──► web
                                 ▲
   keeper ──► lifecycle txs ─────┘ (convenience only; holds no authority)
```

## The one idea everything follows from

A round's prices are a pure function of the round's own scheduled timestamps and
committed pool history:

```
lockPrice(n)  = oracle.getPriceAt(lockTimestamp(n),  twapWindow(n))
closePrice(n) = oracle.getPriceAt(closeTimestamp(n), twapWindow(n))
```

No caller can change the answer by choosing when to call. From that:

- **the keeper is not a trust assumption** — anyone can drive the lifecycle and get
  identical state, so a compromised keeper gains nothing and a dead one blocks nothing;
- **settlement cannot be front-run or timed** — there is no timing edge to capture;
- **lateness is visible but harmless** — `lockedAt`/`settledAt` record when a price was
  recorded, separately from the instant it refers to.

## Trust boundaries

| Component | Can it decide a winner? | Why not |
|---|---|---|
| Frontend | No | Reads only. Every action is a contract call. |
| Read API | No | No write path exists. Serves indexed history and aggregates. |
| Indexer | No | Derives rows from emitted logs. Dropping the database loses nothing but convenience. |
| Keeper | No | Sends transactions whose outcome does not depend on who sent them or when. |
| Admin | No | No function sets a price, alters an entry, changes a recorded outcome, or withdraws user funds. |
| **Contract + oracle** | **Yes** | The only place an outcome is decided. |

## Repository

```
apps/
  web/        Next.js interface
  keeper/     lifecycle driver: retries, nonce management, replacement txs, health
  indexer/    log indexer with reorg handling → PostgreSQL
  api/        read-only HTTP API over the read model
packages/
  contracts/  Foundry: PonsPrediction, UniswapV3PonsOracle, tests, deploy scripts
  config/     verified chain/token/pool constants and launch parameters
  sdk/        generated ABIs, shared payout and price maths, viem helpers
docs/         this documentation
deployments/  <chainId>.json, written by the deploy script
tools/        on-chain audit scripts
scripts/      local stack, end-to-end simulation, ABI sync
```

The brief's sketch also listed `packages/shared` and `packages/ui`. Neither was created:
the shared types and maths live in `@pons/sdk`, the verified constants in `@pons/config`,
and the interface is small enough that a separate component library would have been a
directory with one consumer. Empty packages are worse than absent ones — they invite code
to be put somewhere it does not belong.

### Why the shared packages exist

`@pons/config` is the only place a chain, token or pool address is written. The Solidity
mirror (`PonsAddresses.sol`) is checked against the canonical JSON by `ConfigParity.t.sol`,
so the two cannot drift — a keeper watching a different pool from the one the contract
settles on is exactly the failure that check exists to prevent.

`@pons/sdk` holds the payout and price arithmetic used by the UI, the simulation and the
tests. It reproduces the contract's integer maths, flooring included, so a payout screen
and the chain never disagree by a wei.

ABIs are generated from Foundry output by `scripts/sync-abis.mjs`. Hand-copied ABIs drift
silently: a keeper decoding an old event shape simply sees nothing.

## Contract layout

| Contract | Role |
|---|---|
| `PonsPrediction` | Rounds, entries, settlement, claims, treasury, roles, pause |
| `UniswapV3PonsOracle` | Historical-window TWAP over the PONS/WETH pool. No owner, no setters |
| `IPredictionOracle` | The seam. Lets a future oracle be introduced for future rounds |
| `TickPriceMath` | Tick → price, integer only, ordering-agnostic |
| `PonsAddresses` | Verified constants, checked against `@pons/config` |

`UniswapV3PonsOracle` is immutable by construction: pool, tokens and ordering are fixed at
deployment and verified against the pool itself. Migrating means deploying a new adapter
and pointing *future* rounds at it, behind a timelock.

## Design decisions worth knowing about

**Permissionless lifecycle.** Justified above and in [ORACLE.md](ORACLE.md). It is a
departure from the usual operator-gated design and it is strictly stronger.

**Round progression decoupled from pricing.** The pool cannot always price an instant the
moment it passes; the measured worst case was 888 s. Rounds open and close on the clock;
prices attach when obtainable. See [ROUND_LIFECYCLE.md](ROUND_LIFECYCLE.md).

**Per-round terms snapshot.** Oracle, window, fee and oracle version are pinned into each
round at creation, so configuration changes provably cannot reach a round anyone has
already entered.

**No upgradeability.** Both contracts are non-upgradeable. For a market holding user
stakes, an upgrade path is an admin key over settled outcomes. Migration means deploying a
new market and letting the old one wind down; open rounds settle or refund under the rules
they were created with.

**No proxy, no initializer, no storage gaps** — the corollary of the above.

## Data flow for one round

1. `startNextRound` (anyone) creates round *n+1* with times derived from round *n*, and
   snapshots the current oracle, window and fee into it.
2. Users call `betBull`/`betBear` with ETH until `lockTimestamp`.
3. Once the pool has sealed `lockTimestamp`, anyone calls `lockRound(n)`.
4. Once it has sealed `closeTimestamp`, anyone calls `settleRound(n)`; the outcome and
   reward pool are computed and the fee booked.
5. Winners call `claim`. Ties, no-contests and cancellations refund in full.
6. Every step emits an event; the indexer builds the read model; the API serves it; the
   UI reads live state from the chain for anything a user acts on.

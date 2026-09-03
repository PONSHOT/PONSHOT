# Tickwise — PONS prediction on Robinhood Chain

Round-based up/down prediction on the **PONS/WETH** price, staked in native ETH and
settled on chain from a manipulation-resistant Uniswap V3 time-weighted average.

> Independent project. Not operated, endorsed, sponsored by, or affiliated with Robinhood
> or with Pons. "Robinhood Chain" names the network; "PONS" names the asset the market
> tracks.

**Status: not deployed.** The contracts, services and interface are complete and tested,
including against the live pool on a fork. No production deployment has been made, and
[SECURITY.md](docs/SECURITY.md) explains what should happen before one is.

---

## The idea it is built on

A round's prices are a **pure function of the round's own scheduled timestamps** and
committed pool history:

```
lockPrice(n)  = TWAP over [ lockTimestamp(n)  − w , lockTimestamp(n)  ]
closePrice(n) = TWAP over [ closeTimestamp(n) − w , closeTimestamp(n) ]
```

Not "the price when the keeper's transaction landed". Nobody — keeper, admin, bettor,
searcher — can change the answer by choosing when to act.

Everything else follows from that:

- **The lifecycle is permissionless.** Anyone can lock, settle or cancel a round, because
  every caller produces identical state. A compromised keeper gains nothing; a dead keeper
  blocks nothing.
- **Late settlement is harmless.** A keeper 40 seconds late produces byte-identical state
  to one on time.
- **Round progression is decoupled from pricing.** The pool cannot always price an instant
  the moment it passes, so rounds open and close on the clock and prices attach when
  obtainable.

## What was found on chain, and what it changed

Phase 1 was an audit of the brief's own assumptions. Three findings changed the design.

**PONS is `token1`, not `token0`.** The brief warned not to assume the ordering, and it
was right to. Because PONS is token1, the quoted price *falls* as the tick rises. Getting
this backwards would invert every outcome while leaving the system looking healthy, so the
ordering is derived from the pool at construction and proven by an actual trade against
the live pool.

**Uniswap writes an observation only when a swap moves the tick.** So an instant is not
immediately priceable. Measured across the pool's full 20,000-slot buffer, the gap between
observations reaches **888 seconds**. This is why the oracle refuses to price an unsealed
instant — otherwise the answer would depend on when you asked, handing whoever settles a
free option — and why round progression had to be decoupled from pricing.

**The pool is shallower than the brief's exposure suggestions assume.** Measured by
swapping against a fork of the real pool, shifting a single-pool settlement TWAP costs
about **0.002 WETH per basis point**, fee-only — and that cost *does not fall with a longer
window*, because the window buys arbitrage exposure rather than fee cost.

That drove the market onto a **composite oracle**: it reads both live PONS/WETH pools and
requires them to agree within 100bp, a tolerance measured against 72bp of observed natural
divergence rather than guessed. Measured on the real pools, a single-pool attack is
neutralised outright — the same 2.35 WETH that shifted the old oracle by **1,110bp** now
pushes the pools past the gate, the round refuses to price, and the attacker gains nothing.
A *calibrated* two-pool attack still works, at **1.83x the cost**.

So the caps went from 1 ETH to **2 ETH per round** — scaled by the measured factor and no
further. [MANIPULATION_ANALYSIS.md](docs/MANIPULATION_ANALYSIS.md) is explicit that 1.83x
is real but not transformative: PONS liquidity remains the binding constraint, and there is
no third pool of comparable depth to add.

A fourth finding is the pleasant one: at ~102.5 ms per block, a whole second is ~10 blocks,
and Uniswap records at most one observation per second using the *pre-swap* tick. So
flash manipulation is not merely expensive but **inert**. Measured on the live pool: 250
WETH round-tripped inside one second moved spot more than 40% and moved the settlement
TWAP by **exactly zero wei**.

Full audit transcript: [PONS_MARKET.md](docs/PONS_MARKET.md).

## Quick start

```bash
npm install
npm run contracts:test          # 124 tests: unit, fuzz, invariant, integration

scripts/dev-up.sh --simulate    # full local stack + the end-to-end scenario
```

The simulation opens a round, has Alice back UP and Bob back DOWN, moves the PONS price,
locks, opens the next round, settles, pays the winners, refuses the loser, refuses a double
claim, and reconciles the treasury — asserting every step.

Against the live chain:

```bash
export ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com
forge test --mc PonsOracleFork -vv        # verify every address and assumption
python3 tools/onchain-audit/observations.py

# Tests that trade need a cached endpoint; the public RPC rate-limits them
anvil --fork-url $ROBINHOOD_RPC --port 8546 &
ROBINHOOD_RPC=http://127.0.0.1:8546 forge test --mc LiveMarketFork -vv
ROBINHOOD_RPC=http://127.0.0.1:8546 forge test --mc ManipulationCost -vv
```

> **Note on long-lived forks.** Anvil pins the block it forked at, and Robinhood Chain's
> public node prunes historical state. A fork left running for hours will start failing
> with `metadata is not found, <block>` when a test touches a storage slot it has not
> already cached. That is the node pruning, not a test failure — restart the fork to pick
> up a current block.

## The interface

The app is branded **PONSHOT** — *Predict. Shot. Win.* A near-black ground, the brand
lime (`#9be81c`) for UP with a counterpart red for DOWN, a candlestick chart, a pool-split
ring, a leaderboard and a live entry feed. Pages: Predict, Positions, Leaderboard, History
(plus an Admin view).

The logo — a glossy coin carrying a lime "P", trailing a comet streak with a smaller coin
at its head — is drawn as inline SVG in `apps/web/src/components/Brand.tsx` rather than
shipped as bitmaps, so it stays sharp at any size, needs no extra request and can take its
colour from the surrounding UI. The favicon is `apps/web/src/app/icon.svg`. Only the link
preview and the iOS touch icon want rasters; `apps/web/public/brand/README.md` says which
files to drop in, and both degrade gracefully when absent.

The footer carries **Powered by PONS** alongside the non-affiliation notice, which reads
as a contradiction unless the wording is precise. It is stated as a dependency, not a
relationship: PONS is the asset whose price the market tracks, and the notice says so
explicitly. If a written relationship with Pons ever exists, that clause should be
revisited — until then it must not imply one.

**Stakes are denominated in ETH, not PONS.** This is worth stating because a design can
imply otherwise. `PonsPrediction.betBull`/`betBear` are `payable` and read `msg.value`, so
the amount a user risks is native ETH; PONS is the asset whose *price* the round tracks,
not the token being staked. Rendering pools or balances as "PONS" would misdescribe what
a wallet is about to send. Moving to PONS-denominated staking is an ERC-20 staking change
in the contract — the accounting was shaped so it could be added later, but it is not
built, and the UI will keep saying ETH until it is.

Two related honesty rules the interface keeps:

- **Spot is the headline, the TWAP is labelled as what settles.** Spot is what moves and
  what a trader recognises; showing it alone would imply it decides rounds, and showing
  only the TWAP would look stuck beside any chart. Both appear, always labelled.
- **USD is optional and absent by default.** There is no ETH/USD source on chain 4663 this
  project is willing to call trustworthy, so prices render in WETH. Supplying one makes
  the USD figure appear, marked as an estimate; it never touches settlement.

## Layout

```
apps/web       Next.js interface — predict, history, stats, admin
apps/keeper    lifecycle driver: retries, nonce management, replacement txs, health
apps/indexer   log indexer with reorg handling → PostgreSQL
apps/api       read-only HTTP API over the read model
packages/contracts   Foundry: PonsPrediction, UniswapV3PonsOracle, tests, deploy
packages/config      verified chain/token/pool constants and launch parameters
packages/sdk         generated ABIs, shared payout/price maths, viem helpers
docs/                architecture, oracle, analyses, operations
```

## Who can decide a winner

| Component | Can it? |
|---|---|
| Frontend | No — reads only |
| Read API | No — there is no write path |
| Indexer | No — derives rows from emitted logs |
| Keeper | No — its transactions produce the same state whoever sends them |
| Admin | No — no function sets a price, alters an entry, or rewrites an outcome |
| **Contract + oracle** | **Yes** |

## Testing

124 contract tests, all passing:

| Suite | What it covers |
|---|---|
| `UniswapV3PonsOracle` (28) | ordering both ways, decimals, negative and extreme ticks, TWAP weighting, sealing, eviction, fuzz monotonicity |
| `PonsPredictionLifecycle` (16) | scheduling, boundary invariant, illegal transitions, immutability of settled rounds |
| `PonsPredictionBetting` (10) | limits, one entry per wallet, entries closing on the clock, pause semantics |
| `PonsPredictionSettlement` (18) | the brief's worked example to the wei, ties, empty sides, reentrancy, hostile recipients, treasury bounds |
| `PonsPredictionFailure` (11) | oracle outage → refunds, late prices, limits on emergency powers |
| `PonsPredictionPermissions` (12) | what a compromised operator cannot do; timelocks; per-round terms |
| `PonsPredictionFuzz` (6) | payouts never exceed the pool, correct side only, monotonicity |
| `PonsPredictionInvariants` (11) | solvency, ETH conservation, schedule, outcome consistency, under random action ordering |
| `EndToEnd` (5) | the brief's required scenarios through the real oracle stack |
| Fork suites | every assumption against live chain 4663, plus measured manipulation cost |

Plus SDK tests asserting the TypeScript payout maths reproduces the contract's, flooring
included.

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Shape, trust boundaries, design decisions |
| [PONS_MARKET.md](docs/PONS_MARKET.md) | The on-chain audit, with what was corrected |
| [ORACLE.md](docs/ORACLE.md) | What is measured, the direction trap, the sealing rule |
| [TWAP_ANALYSIS.md](docs/TWAP_ANALYSIS.md) | Why 300 s, with the measurements |
| [MANIPULATION_ANALYSIS.md](docs/MANIPULATION_ANALYSIS.md) | Measured attack costs and the caps they imply |
| [ROUND_LIFECYCLE.md](docs/ROUND_LIFECYCLE.md) | Schedule, phases, outcomes, cancellation |
| [ACCOUNTING.md](docs/ACCOUNTING.md) | Payout maths, invariants, dust |
| [KEEPER.md](docs/KEEPER.md) | What it is not, and how it stays reliable |
| [SECURITY.md](docs/SECURITY.md) | Threat model, known limitations, monitoring |
| [ADMIN.md](docs/ADMIN.md) | Roles and common operations |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Preflight, deployment, post-deployment checks |
| [INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md) | Playbooks |
| [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md) | Licences, vendored code, what was studied |

## Licence

GPL-2.0-or-later. See [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).

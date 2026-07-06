# PONSHOT — PONS prediction on Robinhood Chain

[![CI](https://github.com/PONSHOT/PONSHOT/actions/workflows/ci.yml/badge.svg)](https://github.com/PONSHOT/PONSHOT/actions/workflows/ci.yml)
[![Contracts](https://img.shields.io/badge/contracts-139%20local%20%2B%2017%20fork-2ea44f)](#testing)
[![Licence](https://img.shields.io/badge/licence-MIT%20%2F%20GPL--2.0--or--later-blue)](#licence)
[![Chain](https://img.shields.io/badge/chain-Robinhood%204663-9be81c)](https://rpc.mainnet.chain.robinhood.com)

Round-based up/down prediction on the **PONS/WETH** price, staked in native ETH and
settled on chain from a manipulation-resistant Uniswap V3 time-weighted average.

> Independent project. Not operated, endorsed, sponsored by, or affiliated with Robinhood
> or with Pons. "Robinhood Chain" names the network; "PONS" names the asset the market
> tracks.

## Deployed

Live on Robinhood Chain (chain ID **4663**) since block **53,636,175**, 2026-09-03 18:47 UTC.

> **The live deployment is [v1.0.0](https://github.com/PONSHOT/PONSHOT/releases/tag/v1.0.0),
> not the current `main`.** `main` now carries the buyback-and-burn tokenomics described in
> [TOKENOMICS.md](docs/TOKENOMICS.md) — a 10% fee that is burned rather than banked, and a
> no-winner round that funds the burn instead of refunding. `PonsPrediction` has no upgrade
> path, so that change reaches users only through a **new deployment**, which has not
> happened. The addresses below still behave exactly as v1.0.0 documents.

| | |
|---|---|
| `PonsPrediction` | [`0xC463621052E57Cfa2F8CDA86ee337d8d9aD4dBD0`](deployments/4663.json) |
| `CompositePonsOracle` | [`0x5aBD0f26f1A5e7B24E1bb4De50513a31D3cb0D33`](deployments/4663.json) |
| PONS | `0x39dBED3a2bd333467115dE45665cC57F813C4571` |
| PONS/WETH pools | `0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA`, `0xEd50bDeeA8aDC232f159486192a4157281D722ff` |
| Round interval | 900 s, 300 s TWAP window, 1800 s tolerance |
| Treasury fee | 3.00% of the pot |

Two limitations are stated rather than buried. Admin and treasury are presently a **single
EOA** under an explicit deployment waiver — the timelocked config path and role separation
exist so a multisig can take over without redeploying, and it should.
[SECURITY.md](docs/SECURITY.md) carries the full list of known limitations, and
[ADMIN.md](docs/ADMIN.md) states exactly what privileged roles can and cannot do: no role
can change a settled outcome, seize a user's stake, or void a round capable of settling.

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
npm run contracts:deps          # clone forge-std and OpenZeppelin at the pinned revisions
npm run contracts:test          # 139 tests: unit, fuzz, invariant, integration

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
packages/contracts   Foundry: PonsPrediction, the oracles, tests, deploy scripts
packages/config      verified chain/token/pool constants and launch parameters
packages/sdk         generated ABIs, shared payout/price maths, viem helpers
docs/                architecture, oracle, analyses, operations
tools/               on-chain audit scripts used to produce the measurements
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

**139 local tests and 17 fork tests, all passing.** The counts below come from
`forge test --summary`; the fork column is a separate run against live chain 4663.

| Suite | Tests | What it covers |
|---|--:|---|
| `UniswapV3PonsOracleTest` | 31 | ordering both ways, decimals, negative and extreme ticks, TWAP weighting, sealing, eviction, fuzz monotonicity |
| `CompositePonsOracleTest` | 14 | tick normalisation across orderings, the divergence gate, median selection, source outage |
| `PonsPredictionSettlementTest` | 18 | the brief's worked example to the wei, ties, empty sides, reentrancy, hostile recipients, treasury bounds |
| `PonsPredictionLifecycleTest` | 16 | scheduling, the boundary invariant, illegal transitions, immutability of settled rounds |
| `PonsPredictionPermissionsTest` | 14 | what a compromised operator cannot do; timelocks; per-round terms |
| `PonsPredictionFailureTest` | 12 | oracle outage → refunds, late prices, limits on emergency powers |
| `PonsPredictionInvariantsTest` | 11 | solvency, ETH conservation, schedule, outcome consistency, under random action ordering |
| `PonsPredictionBettingTest` | 10 | limits, one entry per wallet, entries closing on the clock, pause semantics |
| `PonsPredictionFuzzTest` | 6 | payouts never exceed the pool, correct side only, monotonicity |
| `EndToEndTest` | 5 | the brief's required scenarios through the real oracle stack |
| `ConfigParityTest` | 2 | the Solidity address mirror and `addresses.json` agree |
| **Local total** | **139** | |
| `PonsOracleForkTest` | 7 | every declared address, liquidity and buffer depth, window serviceability, unsealed refusal |
| `CompositeManipulationCostTest` | 4 | the divergence gate against both live pools; a single-pool attack neutralised |
| `LiveMarketForkTest` | 3 | a full round against the real pool; direction; flash moves |
| `ManipulationCostTest` | 3 | measured cost per basis point, round-trip cost, unheld displacement |
| **Fork total** | **17** | against live chain 4663 |

A skipped fork test used to report `PASS`, so a green run could mean nothing was verified.
CI sets `REQUIRE_FORK=true`, which turns a skip into a failure.

Measured rather than modelled, and reproducible with the commands in [Quick start](#quick-start):

| Measurement | Result |
|---|---|
| Shifting a single-pool settlement TWAP | ~0.00211 WETH per basis point |
| Same spend (2.35 WETH) against the composite oracle | gate trips, round refuses to price, attacker gains nothing |
| Calibrated two-pool attack | 0.00386 WETH/bp — **1.83x** the single-pool cost |
| 250 WETH round-tripped inside one second | spot moves >40%, settled TWAP moves **0 wei** |
| Natural divergence between the two pools | median 38bp, max 72bp — the 100bp gate refused 0 of 60 honest rounds |

Plus SDK tests asserting the TypeScript payout maths reproduces the contract's, flooring
included.

## Documentation

| | |
|---|---|
| [TOKENOMICS.md](docs/TOKENOMICS.md) | The 90/10 split, the two buybacks, why the swap is not inside settlement |
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
| [MIGRATION.md](docs/MIGRATION.md) | Retiring a market for a new one without stranding a claim |
| [INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md) | Playbooks |
| [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md) | Licences, vendored code, what was studied |

## Licence

Not a single licence, and the split is not a preference. `packages/contracts` incorporates
Uniswap V3 library code (`TickMath.sol`, `Oracle.sol`) which is GPL-2.0-or-later, so the
contracts built on it inherit that and cannot be redistributed under MIT. Everything else
links none of it and is MIT. Every file carries its own SPDX identifier, which governs.

See [LICENSE](LICENSE), [LICENSE-GPL](LICENSE-GPL), [LICENSE-MIT](LICENSE-MIT) and
[THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).

# Migrating to the buyback-and-burn market

`PonsPrediction` has no upgrade path. The buyback-and-burn tokenomics therefore reach
users only through a **new deployment**, with the existing market retired rather than
changed.

This is deliberate. An upgradeable market is one where an admin key can rewrite payout
rules under money that is already staked, and the whole point of the design is that the
guarantees are enforced by code that cannot move.

## The one thing that actually matters

**A retired market keeps owing its users forever.** Claims are pull-based and nothing
expires, so the old contract will pay whoever asks, whenever they ask, for as long as the
chain exists.

That means a migration cannot lose anyone's money — but it can lose their *route to it*.
If the interface stops offering a claim button for the old address, the funds are
unreachable in practice for anyone who does not read Solidity. So the migration keeps that
path: `NEXT_PUBLIC_LEGACY_PREDICTION_ADDRESS` puts a "you have funds in the previous
market" panel on the Positions page, which claims directly from the old contract.

## What `pause` does and does not stop

Verified against the deployed source, because the whole drain depends on it:

| Blocked by pause | Still works while paused |
|---|---|
| `betBull`, `betBear` | `lockRound`, `settleRound` |
| `executeRound` | `cancelRound` |
| `startNextRound`, `genesisStartRound` | `claim`, `claimTreasury` |

So pausing stops new money entering and stops new rounds being created, while leaving
every path that resolves an existing round and pays out. That is exactly the shape a
drain needs: the market stops taking bets, finishes the ones it has, and keeps paying.

Note that `executeRound` is paused but `lockRound`/`settleRound` are not. The keeper's
combined path stops; the individual calls it falls back to do not. Nothing is stranded.

## Readiness check

```bash
npx tsx scripts/migration-status.mts 0xC463621052E57Cfa2F8CDA86ee337d8d9aD4dBD0
```

Prints whether any round can still change state and how much is still owed, and exits
non-zero while any round is unresolved. Run it until it says `READY`.

Current reading (2026-09-04): nothing is owed to users, the contract holds 0.00015 ETH,
and that entire balance is accrued protocol fee — `treasuryAmount()`, withdrawable to the
treasury. So today's migration would strand nothing at all. That will not stay true once
people are betting again, which is why the check exists rather than a remembered fact.

## Sequence

Steps 1–3 are reversible. Step 4 is where users start seeing the new market.

**1. Decide the two open questions first.** Both change the deployed bytecode's
configuration, and neither can be fixed by redeploying quietly later:

- The project token. `PROJECT_TOKEN` and `PROJECT_POOL` may be left unset — that half of
  the burn then accrues in the burner until `setTarget` names them — but launching without
  it should be a decision, not an omission. See [TOKENOMICS.md](TOKENOMICS.md).
- Who holds `DEFAULT_ADMIN_ROLE`. Deploying the new market to the same single EOA repeats
  [issue #1](https://github.com/PONSHOT/PONSHOT/issues/1) at the moment it is cheapest to
  avoid, because a fresh deployment needs no role handover at all — pass the multisig as
  `ADMIN_ADDRESS` and it is right from block zero.

**2. Pause the old market.** New entries stop; open rounds carry on.

```bash
cast send $OLD "pausePrediction()" --private-key $PAUSER_KEY --rpc-url $RPC
```

**3. Let the open rounds finish.** The keeper settles them on its normal schedule; its
`executeRound` path is paused, so it falls back to `lockRound`/`settleRound`. Watch the
readiness check until no round is unresolved. A round whose price never becomes available
resolves to a refund via `cancelRound` after `bufferSeconds`, which is also permissionless.

**4. Deploy the new market.**

```bash
PROJECT_TOKEN=0x… PROJECT_POOL=0x… ADMIN_ADDRESS=0xMultisig scripts/deploy-mainnet.sh
```

The script deploys the burner first and constructs the market already pointing at it, so
there is no window in which fees accrue toward an address that has to be corrected later.
Preflight re-verifies token ordering, pool registration, liquidity, observation cardinality
and window serviceability against the live chain before anything is broadcast.

**5. Record the predecessor.** Add to `deployments/4663.json`:

```json
"legacyPonsPrediction": "0xC463621052E57Cfa2F8CDA86ee337d8d9aD4dBD0"
```

`scripts/write-web-env.mjs` turns that into `NEXT_PUBLIC_LEGACY_PREDICTION_ADDRESS`, which
is what keeps the old market's claim path in the interface.

**6. Point the services at the new addresses.**

```bash
node scripts/write-web-env.mjs deployments/4663.json
npm run abi && (cd apps/web && npm run build)
```

The indexer needs a **fresh database**, not a migrated one. Its chain-instance anchor is
the market's deployment block, so pointing it at a new market with the old database is
refused rather than silently blending two markets' history into one set of totals. Create
a new database and let it index from the new deployment block.

**7. Verify before announcing.**

```bash
npx tsx scripts/verify-read-path.mts    # every read the UI makes, against the new market
curl -s localhost:8789/burn | jq        # configured:true, both targets, zero burned so far
```

Then genesis-start the first round and confirm a full cycle settles before telling anyone
the new market is live.

## What is not migrated, and why

**Positions, history and the leaderboard start empty.** The new market is a different
contract with its own epochs; carrying numbers across would mean asserting that a round in
one contract is the same round in another, which is not true. The old market's history
stays readable in its own indexed database if it is kept.

**Accrued fees stay in the old contract** until withdrawn with `claimTreasury` to the
treasury address. They belong to the old tokenomics — they were charged as a treasury fee,
not as a burn allocation — and moving them into the burner would spend money under rules
the people who paid it never agreed to. Withdraw them, or leave them; do not launder them
through the new mechanism.

**Nothing forces users to move.** The old market is paused, not destroyed. Anyone with an
unclaimed balance keeps it and can collect at any time.

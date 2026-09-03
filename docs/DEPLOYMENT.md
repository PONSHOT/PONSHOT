# Deployment

**There is no production deployment.** The only artifact under `deployments/` is a fork
dry run, kept to show the script's preflight and postflight checks passing against real
on-chain state. Before deploying for real, read [SECURITY.md](SECURITY.md).

## Preflight, and why it is a hard stop

`script/Deploy.s.sol` re-verifies every assumption **before** anything is deployed:

- PONS, WETH and the pool all have code;
- the pool holds exactly that pair, in whichever order the pool says;
- the pool is the one the factory registers for `(token0, token1, fee)` — so a look-alike
  pool with the same tokens cannot be substituted;
- in-range liquidity is non-zero;
- `observationCardinality > 1`;
- a live `observe()` call for the configured window succeeds;
- PONS decimals are 18;
- the fee is within the contract's ceiling;
- `twapWindow <= interval`, so lock and close windows cannot overlap.

It refuses to proceed rather than emit a plausible-looking deployment, because a flipped
token order or a wrong pool produces a market that looks healthy and settles backwards.

Afterwards it reads the deployed system back, confirms roles and wiring, and requires a
non-zero live price before writing any address down.

## Local

```bash
scripts/dev-up.sh              # chain + mock PONS/WETH + mock pool + oracle + market
scripts/dev-up.sh --simulate   # the above, then the full end-to-end scenario
scripts/dev-up.sh --keeper     # the above, and run the keeper against it
```

A fresh chain every run, deliberately: a simulation that inherits rounds from a previous
run produces numbers nobody can reconcile.

## Robinhood Chain

```bash
export ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com
export DEPLOYER_PRIVATE_KEY=0x...
export ADMIN_ADDRESS=0x...      # multisig
export OPERATOR_ADDRESS=0x...   # keeper hot key
export TREASURY_ADDRESS=0x...

# Optional; defaults are the analysed launch values
export ROUND_INTERVAL=300
export TWAP_WINDOW=300
export BUFFER_SECONDS=1800
export TREASURY_FEE_BPS=300
export MINIMUM_BET=1000000000000000        # 0.001 ETH
export MAXIMUM_BET=250000000000000000      # 0.25 ETH
export MAXIMUM_ROUND_POOL=1000000000000000000  # 1 ETH

cd packages/contracts
forge script script/Deploy.s.sol:Deploy --rpc-url $ROBINHOOD_RPC --broadcast
```

Writes `deployments/4663.json`. Measured cost of the full deployment on a fork: **~0.0074
ETH** at ~0.92 gwei.

Nothing downstream hand-copies addresses: the keeper, indexer and API read this file, and
the web build takes its `NEXT_PUBLIC_*` values from it.

## Verify the source

```bash
forge verify-contract <address> src/PonsPrediction.sol:PonsPrediction \
  --chain 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api
```

## Start the market

Genesis is the only lifecycle call that needs a role, because it chooses where the
schedule begins.

```bash
cast send $MARKET "genesisStartRound()" --private-key $OPERATOR_KEY --rpc-url $ROBINHOOD_RPC
```

Round 1 opens immediately, locks one interval later and closes one interval after that.

## Bring up the services

```bash
# indexer (runs migrations on start)
cd apps/indexer && DATABASE_URL=postgres://... CHAIN_ID=4663 RPC_URLS=$ROBINHOOD_RPC npm start

# read API
cd apps/api && DATABASE_URL=postgres://... CHAIN_ID=4663 RPC_URLS=$ROBINHOOD_RPC npm start

# keeper
cd apps/keeper && KEEPER_PRIVATE_KEY=0x... CHAIN_ID=4663 RPC_URLS=$ROBINHOOD_RPC npm start

# web
cd apps/web && npm run build && npm start
```

The web app's addresses come from `.env.local`; see `apps/web/.env.example`.
`scripts/write-web-env.mjs` generates it from a deployment file.

### Pointing the indexer at a new market

Most read-model tables are keyed by chain id, so one database serves one market per chain.
If the database already holds a *different* market for the same chain, the indexer refuses
to start rather than blend two histories:

```
database holds market 0x… for chain 4663, but this indexer is configured for 0x….
Point at a different database, or set INDEXER_RESET=true to discard the existing
read model for this chain.
```

`INDEXER_RESET=true` deletes every derived row for that chain and re-indexes from scratch.
Nothing is lost that cannot be rebuilt from chain events, but it is destructive and
therefore opt-in rather than automatic.

## Running the demo stack under pm2

`ecosystem.config.cjs` runs the whole system as six pm2 processes against a local Anvil,
since there is no production deployment to point at.

```bash
docker compose up -d postgres          # the read model's database

pm2 start ecosystem.config.cjs --only pons-chain
( cd packages/contracts && ROUND_INTERVAL=60 \
    forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 --broadcast )
node scripts/write-web-env.mjs deployments/31337.json
cast send $MARKET "genesisStartRound()" --private-key $DEV_KEY --rpc-url http://127.0.0.1:8545

( cd apps/web && npm run build )       # NEXT_PUBLIC_* are baked in at build time
pm2 start ecosystem.config.cjs
pm2 save
```

| Process | Port | Role |
|---|---|---|
| `pons-chain` | 8545 | Anvil, `--block-time 1` so the clock advances, `--state` so it survives restarts |
| `pons-keeper` | 8787 | drives the lifecycle; `/ready` and `/metrics` |
| `pons-trader` | — | moves the mock pool's tick |
| `pons-indexer` | 8788 | logs → PostgreSQL |
| `pons-api` | 8789 | read API |
| `pons-web` | 8894 | the interface |

Three details that are easy to get wrong:

- **The trader is not decoration.** Uniswap records an observation only when a swap moves
  the tick, so with nothing trading every round sits at *awaiting lock* forever. The site
  would look broken while being perfectly correct.
- **Anvil needs `--state`.** Without it a pm2 restart brings back an empty chain that the
  frontend still points at, and every read fails against addresses that no longer exist.
- **The API and RPC are proxied through Next** (`/api`, `/rpc`, see `next.config.mjs`).
  Baking in `localhost:8789` would make the site work only when opened on the host itself
  — from any other machine those names resolve to the visitor's own computer.

The order matters: the chain must exist before contracts are deployed, and the deployment
must exist before the web app is built, because `NEXT_PUBLIC_*` values are compile-time.

Rebuild and restart the interface after any redeploy. **Stop it first**: a running
`next start` reads from `.next`, so rebuilding underneath it makes the process crash-loop
on a missing `prerender-manifest.json` until the build finishes.

```bash
pm2 stop pons-web
node scripts/write-web-env.mjs deployments/31337.json
( cd apps/web && npm run build )
pm2 start ecosystem.config.cjs --only pons-web
```

**Use `pm2 start ecosystem.config.cjs`, never `pm2 restart <name>`, after editing the
ecosystem file.** `restart` reuses the config pm2 already has saved, so changed environment
variables and log paths are silently ignored — which looks exactly like the change not
working.

A configuration refusal (for instance the indexer finding another market's data in its
database) exits **78** and pm2 is set to stop rather than restart on it: retrying cannot
fix a config error, and looping buries the one log line that explains it.

## Two build-time traps worth knowing

Both cost a production deploy on this project, and neither is visible in a healthy-looking
smoke test.

**`next.config.mjs` rewrites are baked at build time.** A rewrite whose destination comes
from the environment keeps whatever value was set *during the build*, so supplying it at
runtime through pm2 changes nothing. That is how the first mainnet deploy ended up
proxying `/rpc` to a local devnet that had already been deleted — every page returned 200
and every chain read failed. `/rpc` is now a route handler (`src/app/rpc/route.ts`) that
reads its target per request; only `/api` remains a rewrite, and its target is the same in
every environment.

**`NEXT_PUBLIC_*` are compile-time too.** Rebuild the frontend after any redeploy, or it
keeps pointing at the previous market. `scripts/write-web-env.mjs` regenerates the file;
the build is what applies it.

The RPC proxy forwards **read methods only**. Transactions are signed and broadcast by the
user's own wallet through its own provider and never pass through the server, so there is
no reason to relay writes — and an unrestricted proxy is an open relay for anyone who
finds the URL.

## Post-deployment checks

```bash
cast call $ORACLE "getPrice()(uint256,uint256)"          # sane, non-zero
cast call $ORACLE "baseIsToken0()(bool)"                 # must be false for this pool
cast call $MARKET "solvency()(uint256,uint256,bool)"     # solvent
cast call $MARKET "MAX_TREASURY_FEE_BPS()(uint256)"      # 500
curl -s $KEEPER/ready                                    # 200
curl -s $API/health                                      # indexer lag small
```

Then watch one round settle end to end before announcing anything.

## Rollback

There is no upgrade path, by design. To retire a deployment:

1. `pausePrediction()` — no new entries.
2. Let open rounds settle, or cancel any that cannot be priced.
3. Confirm every participant has claimed or been refunded.
4. Withdraw the treasury.
5. Deploy the replacement and repoint the frontend.

Users are never stranded: claims and refunds are permissionless and remain available
whether or not the market is paused.

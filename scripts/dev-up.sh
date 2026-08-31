#!/usr/bin/env bash
# Brings up the whole local stack on one command, from a clean chain every time.
#
#   scripts/dev-up.sh            # chain + contracts, then leaves Anvil running
#   scripts/dev-up.sh --simulate # the above, then runs the end-to-end simulation
#   scripts/dev-up.sh --keeper   # the above, and starts the keeper against it
#
# A fresh chain each run is deliberate: a simulation that silently inherits rounds from
# a previous run produces numbers nobody can reconcile.
set -euo pipefail

# lib/ is not committed; restore it at the pinned revisions before anything builds.
"$(dirname "${BASH_SOURCE[0]}")/restore-contract-deps.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT/.dev}"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
PORT="${ANVIL_PORT:-8545}"
CHAIN_ID=31337
DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

mkdir -p "$RUN_DIR"

log() { printf '\033[1m▸ %s\033[0m\n' "$*"; }

cleanup_previous() {
  if [[ -f "$RUN_DIR/anvil.pid" ]]; then
    kill "$(cat "$RUN_DIR/anvil.pid")" 2>/dev/null || true
    rm -f "$RUN_DIR/anvil.pid"
    sleep 1
  fi
  rm -f "$ROOT/apps/keeper/.keeper-state.json"
}

start_anvil() {
  # A stale Anvil left over from an earlier session would silently keep the port, and
  # forge would then deploy against a chain this script did not create - which surfaces
  # much later as a confusing "nonce too low". Fail here instead.
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
    echo "Something is already serving $RPC. Stop it first, e.g.:" >&2
    echo "  pkill -f 'anvil --port $PORT'" >&2
    exit 1
  fi

  log "starting Anvil on port $PORT (chain $CHAIN_ID)"
  # Auto-mine: transactions land immediately and time is driven explicitly with
  # evm_increaseTime, which keeps a 300-second round from taking 300 real seconds.
  # The raised gas limit is for growing the pool's observation buffer in one block.
  anvil --port "$PORT" --chain-id "$CHAIN_ID" --gas-limit 60000000 --silent \
    > "$RUN_DIR/anvil.log" 2>&1 &
  echo $! > "$RUN_DIR/anvil.pid"
  for _ in $(seq 1 40); do
    if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then return; fi
    sleep 0.5
  done
  echo "Anvil did not come up; see $RUN_DIR/anvil.log" >&2
  exit 1
}

deploy() {
  log "deploying mock PONS/WETH, mock V3 pool, oracle adapter and market"
  ( cd "$ROOT/packages/contracts" \
    && DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
       ROUND_INTERVAL="${ROUND_INTERVAL:-300}" \
       forge script script/DeployLocal.s.sol:DeployLocal \
         --rpc-url "$RPC" --broadcast >"$RUN_DIR/deploy.log" 2>&1 ) \
    || { echo "deploy failed; see $RUN_DIR/deploy.log" >&2; exit 1; }
  log "addresses written to deployments/$CHAIN_ID.json"
  cat "$ROOT/deployments/$CHAIN_ID.json"
  # Deliberately no RPC argument: write-web-env defaults to the same-origin `/rpc`
  # and `/api` proxies, which work from any host. Passing the raw RPC here baked
  # `127.0.0.1:<port>` into the frontend, which only resolves on this machine and
  # silently broke a running demo the next time it was rebuilt.
  # --force because this IS the local stack asking to be pointed at itself. The guard in
  # write-web-env exists to stop an accidental repoint from another workflow, not this one.
  node "$ROOT/scripts/write-web-env.mjs" "$ROOT/deployments/$CHAIN_ID.json" --force
}

# `deployments/<chainId>.json` and `apps/web/.env.local` are shared with whatever else is
# running against this chain id. Replacing them under a live stack (a pm2 demo, say)
# repoints it at a chain it never deployed to, so say so rather than doing it silently.
PREVIOUS_WEB_CHAIN=""
if [[ -f "$ROOT/apps/web/.env.local" ]]; then
  PREVIOUS_WEB_CHAIN="$(sed -n 's/^NEXT_PUBLIC_CHAIN_ID=//p' "$ROOT/apps/web/.env.local" | head -1)"
fi
if [[ -n "$PREVIOUS_WEB_CHAIN" && "$PREVIOUS_WEB_CHAIN" != "$CHAIN_ID" ]]; then
  log "apps/web/.env.local currently points at chain $PREVIOUS_WEB_CHAIN; it will be repointed here"
  log "restore it afterwards with: node scripts/write-web-env.mjs deployments/$PREVIOUS_WEB_CHAIN.json --force"
fi

cleanup_previous
start_anvil
deploy

# A one-shot run (a simulation, a CI check) must not leave the machine's web build
# pointing at a devnet that is about to be torn down. Long-running modes keep it.
restore_web_env() {
  if [[ -n "$PREVIOUS_WEB_CHAIN" && "$PREVIOUS_WEB_CHAIN" != "$CHAIN_ID" \
        && -f "$ROOT/deployments/$PREVIOUS_WEB_CHAIN.json" ]]; then
    node "$ROOT/scripts/write-web-env.mjs" "$ROOT/deployments/$PREVIOUS_WEB_CHAIN.json" --force >/dev/null
    log "restored apps/web/.env.local to chain $PREVIOUS_WEB_CHAIN"
  fi
}

case "${1:-}" in
  --simulate)
    log "running the end-to-end simulation"
    ( cd "$ROOT" && npx tsx scripts/simulate.ts ); sim_status=$?
    restore_web_env
    [[ $sim_status -eq 0 ]] || exit $sim_status
    ;;
  --keeper)
    log "starting the keeper (Ctrl-C to stop)"
    ( cd "$ROOT/apps/keeper" \
      && KEEPER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
         CHAIN_ID="$CHAIN_ID" RPC_URLS="$RPC" \
         DEPLOYMENTS_PATH="$ROOT/deployments/$CHAIN_ID.json" \
         POLL_INTERVAL_MS=2000 LOG_LEVEL=debug \
         npx tsx src/index.ts )
    ;;
  *)
    log "stack is up. Anvil pid $(cat "$RUN_DIR/anvil.pid"), RPC $RPC"
    log "next: scripts/dev-up.sh --simulate    or    scripts/dev-up.sh --keeper"
    ;;
esac

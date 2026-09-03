#!/usr/bin/env bash
# One-shot production deployment to Robinhood Chain (4663).
#
# Everything here has already been dry-run against the live chain: preflight passes, both
# pools are serviceable, and the cost is known. This script performs the irreversible
# parts — deploy, open the first round, fund the keeper — and then wires the services.
#
#   DEPLOYER_PRIVATE_KEY=0x... scripts/deploy-mainnet.sh
#
# Re-running it after a successful deploy will deploy a SECOND market. Check
# deployments/4663.json first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC="${ROBINHOOD_RPC:-https://rpc.mainnet.chain.robinhood.com}"
CHAIN_ID=4663
KEEPER_JSON="${KEEPER_JSON:-$ROOT/.secrets/keeper.json}"

: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"

ADMIN="${ADMIN_ADDRESS:-$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")}"
TREASURY="${TREASURY_ADDRESS:-$ADMIN}"

log() { printf '\033[1m▸ %s\033[0m\n' "$*"; }

# --- 1. a dedicated hot key for the keeper -----------------------------------------
# It signs from the server continuously, so it must not be the key that holds
# DEFAULT_ADMIN_ROLE and can withdraw the treasury.
if [[ ! -f "$KEEPER_JSON" ]]; then
  mkdir -p "$(dirname "$KEEPER_JSON")"; chmod 700 "$(dirname "$KEEPER_JSON")"
  cast wallet new --json > "$KEEPER_JSON"
  chmod 600 "$KEEPER_JSON"
  log "generated a new keeper key at $KEEPER_JSON"
fi
KEEPER_ADDR=$(python3 -c "import json,sys;print(json.load(open('$KEEPER_JSON'))[0]['address'])")
KEEPER_PK=$(python3 -c "import json,sys;print(json.load(open('$KEEPER_JSON'))[0]['private_key'])")

log "admin/treasury $ADMIN"
log "keeper         $KEEPER_ADDR"

# --- 2. deploy ---------------------------------------------------------------------
log "deploying (composite oracle over both PONS/WETH pools)"
( cd "$ROOT/packages/contracts" \
  && DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
     ADMIN_ADDRESS="$ADMIN" TREASURY_ADDRESS="$TREASURY" OPERATOR_ADDRESS="$KEEPER_ADDR" \
     ROUND_INTERVAL="${ROUND_INTERVAL:-900}" TWAP_WINDOW="${TWAP_WINDOW:-300}" \
     BUFFER_SECONDS="${BUFFER_SECONDS:-1800}" TREASURY_FEE_BPS="${TREASURY_FEE_BPS:-300}" \
     MINIMUM_BET="${MINIMUM_BET:-1000000000000000}" \
     MAXIMUM_BET="${MAXIMUM_BET:-500000000000000000}" \
     MAXIMUM_ROUND_POOL="${MAXIMUM_ROUND_POOL:-2000000000000000000}" \
     MAX_DIVERGENCE_BPS="${MAX_DIVERGENCE_BPS:-100}" \
     ALLOW_EOA_ADMIN="${ALLOW_EOA_ADMIN:-true}" \
     forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow )

MARKET=$(python3 -c "import json;print(json.load(open('$ROOT/deployments/$CHAIN_ID.json'))['PonsPrediction'])")
ORACLE=$(python3 -c "import json;print(json.load(open('$ROOT/deployments/$CHAIN_ID.json'))['PonsOracleAdapter'])")
log "market $MARKET"
log "oracle $ORACLE"

# --- 3. fund the keeper -------------------------------------------------------------
# Leave a margin with the admin key for configuration calls; give the rest to the keeper,
# which is the only account with an ongoing cost.
FUND="${KEEPER_FUND_WEI:-}"
if [[ -z "$FUND" ]]; then
  BAL=$(cast balance "$ADMIN" --rpc-url "$RPC")
  FUND=$(python3 -c "print(max(0, int($BAL) - 1_500_000_000_000_000))")   # keep 0.0015 ETH
fi
if [[ "$FUND" -gt 0 ]]; then
  log "funding keeper with $(python3 -c "print(f'{$FUND/1e18:.6f}')") ETH"
  cast send "$KEEPER_ADDR" --value "$FUND" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
fi

# --- 4. open the first round --------------------------------------------------------
# The only lifecycle call that needs a role: it chooses where the schedule begins.
log "opening the first round"
cast send "$MARKET" "genesisStartRound()" --private-key "$KEEPER_PK" --rpc-url "$RPC" >/dev/null
log "currentEpoch = $(cast call "$MARKET" 'currentEpoch()(uint256)' --rpc-url "$RPC")"

# --- 5. wire the frontend -----------------------------------------------------------
node "$ROOT/scripts/write-web-env.mjs" "$ROOT/deployments/$CHAIN_ID.json"
log "wrote apps/web/.env.local"

cat <<SUMMARY

  Deployed to Robinhood Chain ($CHAIN_ID)
    market    $MARKET
    oracle    $ORACLE
    admin     $ADMIN     (also treasury)
    keeper    $KEEPER_ADDR  (OPERATOR_ROLE only)

  Next:
    1. cd apps/web && npm run build        # NEXT_PUBLIC_* are compile-time
    2. start keeper / indexer / api / web against CHAIN_ID=$CHAIN_ID
    3. watch the first round lock and settle before announcing anything

  The keeper is the only ongoing cost. Top it up before it empties, or rounds stop being
  advanced automatically — they are still advanceable by anyone, and unpriced rounds
  refund in full after $((${BUFFER_SECONDS:-1800} / 60)) minutes, so no funds are ever stuck.
SUMMARY

# Keeper

## What it is, and what it is not

The keeper sends the transactions that advance the market. It holds **no authority**:
`lockRound`, `settleRound`, `startNextRound` and `cancelRound` are permissionless, and
their results do not depend on who calls them or when.

So a compromised keeper cannot choose a settlement price, steal funds, withdraw treasury,
change the oracle, change fees, alter a historical round, or claim on anyone's behalf. And
a dead keeper cannot hold the market hostage — any participant can push it forward.

It holds `OPERATOR_ROLE`, which grants exactly one thing: `genesisStartRound`, the call
that chooses where the schedule begins. `test_operatorRoleGrantsNoEconomicPower` pins the
rest.

## Loop

Each tick:

1. Renew or acquire the single-writer lock.
2. Read balance, `currentEpoch`, `paused`.
3. Ask the contract what is actionable via `pendingWork()` — the keeper never decides this
   itself, which is what keeps its view and the contract's from drifting.
4. Call `executeRound()`, which folds lock, settle and start into one transaction.
5. Cancel any round the contract reports as stuck.
6. Pick up anything `executeRound` could not reach with the granular calls.

A tick with nothing to do is a no-op, not an error: `executeRound` is written not to revert
when idle, so a quiet period does not look like a fault.

## Reliability

| Concern | Handling |
|---|---|
| Nonce drift | Read from the chain with `pending`; re-read on any error matching nonce/replacement patterns |
| Stuck transactions | Replaced **at the same nonce** with fees bumped 25%. Re-sending at a new nonce is how double execution happens |
| Gas estimation | `estimateContractGas` plus 30% headroom — another caller can change round state between estimate and inclusion |
| Wasted gas | Every call is simulated first; "nothing to do" becomes a cheap skip rather than a reverted transaction |
| Benign reverts | `RoundNotOpen`, `NotYetSettleable`, `PriceUnavailable`, … are logged at info and reported as success. A keeper racing another caller is normal |
| RPC outage | `fallback` transport across configured endpoints, with per-endpoint health probed and exposed |
| Confirmation | Waits `CONFIRMATIONS` blocks (default 12 — under two seconds at ~102.5 ms/block) |
| Restart | State persisted write-then-rename. Losing it is survivable: every decision is re-derivable from chain state |
| Duplicate execution | Redis lock when configured. Fails **open** — a Redis outage must not stop settlement, and duplicates are merely wasteful |
| Out of gas money | Refuses to send below `MIN_BALANCE_WEI` and logs at error, rather than emitting failures |
| Repeated failure | Linear backoff, and an RPC re-probe after three consecutive failures |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | — | required |
| `CHAIN_ID` | 4663 | |
| `RPC_URLS` | Robinhood mainnet | comma-separated; failover order |
| `DEPLOYMENTS_PATH` | `deployments/<chainId>.json` | addresses are read from the deployment file, not env |
| `POLL_INTERVAL_MS` | 5000 | rounds are minutes long |
| `CONFIRMATIONS` | 12 | |
| `TX_TIMEOUT_MS` | 30000 | before replacing |
| `REPLACEMENT_BUMP_PERCENT` | 25 | |
| `MAX_ATTEMPTS` | 5 | |
| `MIN_BALANCE_WEI` | 0.01 ETH | refuse-to-send floor |
| `REDIS_URL` | unset | omit for single-instance |
| `HEALTH_PORT` | 8787 | |
| `DRY_RUN` | false | simulate only |

`PREDICTION_ADDRESS`/`ORACLE_ADDRESS` override the deployment file if both are set.

## Endpoints

- `GET /health` — shallow liveness.
- `GET /ready` — 503 when the keeper has stopped ticking, every RPC is down, or the
  operator is out of gas: the three conditions under which rounds go unresolved.
- `GET /metrics` — Prometheus text, including rounds awaiting lock/settle, rounds
  cancellable, and transaction counters.

## Running

```bash
cd apps/keeper
KEEPER_PRIVATE_KEY=0x... CHAIN_ID=4663 npm start
```

Locally, `scripts/dev-up.sh --keeper` brings up a chain, deploys, and starts it.

## Operating notes

- **Keep the operator funded.** It is the only ongoing cost, and the floor check turns
  exhaustion into a loud error rather than silent failure.
- **Alert on `/ready`, not `/health`.** Liveness is not usefulness.
- **A rising `rounds_awaiting_lock` is expected in a quiet market**, because the pool has
  not sealed the instant yet. `rounds_cancellable` above zero is the real alarm.
- **Two replicas without Redis is fine.** They will occasionally duplicate work and waste
  gas; they cannot produce a wrong result.

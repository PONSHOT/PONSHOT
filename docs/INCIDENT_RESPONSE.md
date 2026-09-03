# Incident response

## First principles

Two facts shape every response here.

1. **Nobody can change a decided outcome**, including you. If a round can be settled, it
   will settle to the same value whenever anyone gets round to it.
2. **The market does not need the keeper.** Lifecycle calls are permissionless. If the
   keeper is the problem, anyone — including you, from a laptop — can advance the market.

So most incidents do not need an emergency action. Reach for `pausePrediction` when new
money should stop arriving; almost never for anything else.

## Triage

```bash
export MARKET=<address> RPC=<rpc>
cast call $MARKET "solvency()(uint256,uint256,bool)" --rpc-url $RPC
cast call $MARKET "pendingWork()(uint256[],uint256[],uint256[],bool)" --rpc-url $RPC
cast call $MARKET "currentEpoch()(uint256)" --rpc-url $RPC
cast call $MARKET "paused()(bool)" --rpc-url $RPC
curl -s $KEEPER/ready
curl -s $API/oracle/pons
```

## Playbooks

### Rounds are not settling

Usually the pool has not sealed the instant yet — normal in a quiet market.

1. `curl $API/oracle/pons` → is `secondsSinceLastObservation` large?
2. If yes: **wait.** The price is fixed by the schedule and will not change. Rounds become
   cancellable after `bufferSeconds` (1800 s) and refund in full.
3. If no, the price is available and the keeper is not acting. Advance it yourself:
   `cast send $MARKET "executeRound()"`.
4. Then fix the keeper: check `/ready`, the operator balance, and RPC health.

Do **not** pause for this. Pausing stops entries but does nothing for settlement.

### Keeper is down

Not an emergency. Send `executeRound()` from any funded key on a loop, then restore the
keeper. Its state file is disposable — every decision is re-derivable from the chain.

### Oracle is unavailable for a long period

1. Confirm with `canQuote` on the affected instant.
2. Rounds past their tolerance are cancellable by anyone:
   `cast send $MARKET "cancelRound(uint256)" <epoch>`. Every participant recovers 100%.
3. If it will persist, `pausePrediction()` so no more rounds accumulate.
4. `emergencyCancelRound` can void unpriceable rounds without waiting for the tolerance.

### Suspected price manipulation

1. Pull the round: `curl $API/prediction/rounds/<epoch>`. Compare `lockPrice`/`closePrice`
   against the pool's tick history around those instants.
2. **The outcome cannot be reversed.** No role can. Do not imply otherwise.
3. Reduce exposure immediately: lower `maximumRoundPool` and `maximumBet`, or pause.
4. Re-run [MANIPULATION_ANALYSIS.md](MANIPULATION_ANALYSIS.md) against current liquidity
   before resuming.
5. Publish what happened, with the transactions.

### Pool liquidity collapses

1. `pausePrediction()` — manipulation cost has fallen and new rounds should not open.
2. Let rounds with sealed instants settle normally.
3. Cancel rounds that cannot be priced.
4. Do not resume until either liquidity recovers or a different oracle is in place. Note
   that repointing the oracle affects future rounds only, behind a 2-day timelock.

### Solvency invariant reports false

Critical, and should be impossible.

1. `pausePrediction()` immediately.
2. Do **not** touch the treasury.
3. Compare `address(this).balance` against `totalLiabilities + treasuryAmount` and
   reconstruct from indexed events (`total staked − total claimed − total refunded −
   treasury withdrawn`).
4. Preserve everything and get an auditor in. Users can still claim; claims are
   independent of admin action.

### Indexer or API is down

Cosmetic. `/history` and `/stats` degrade; the market is unaffected and the UI reads live
state from the chain for everything a user acts on. Restart the indexer — it resumes from
its cursor and re-indexes idempotently.

### Chain reorg

The contract is unaffected. The indexer detects a hash mismatch at its last indexed block,
rewinds four confirmation-depths and replays; every write is keyed on log identity, so
replay is a no-op where nothing changed.

## Communication

- Say what is known, what is not, and which funds are affected.
- If an outcome is disputed, publish the instants, the windows and the transactions, and
  state plainly that no party can alter it.
- Never promise a reversal that the contract does not permit.

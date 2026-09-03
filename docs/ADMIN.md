# Administration

## Roles

| Role | Holds | Can do |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | multisig (intended) | grant/revoke roles, set treasury, withdraw booked fees |
| `PAUSER_ROLE` | multisig / ops | pause and unpause entries, emergency-cancel an unpriceable round |
| `CONFIG_ROLE` | multisig | bet limits, interval, TWAP window, buffer; propose fee and oracle changes |
| `OPERATOR_ROLE` | keeper (hot key) | `genesisStartRound` only |

Routine lifecycle needs no role at all — see [KEEPER.md](KEEPER.md).

## What administration cannot reach

No role can set a price, alter a placed bet, change a recorded outcome, claim for a user,
or withdraw ETH owed to users. This is a property of the contract, not a policy.

- Fee changes: capped at 5% by an immutable constant, 2-day timelock, snapshotted per
  round so they only ever affect rounds created afterwards.
- Oracle changes: 2-day timelock, validated at proposal time, snapshotted per round.
- `emergencyCancelRound`: refused whenever a round can be settled. Only ever refunds.
- `claimTreasury`: bounded by fees booked at settlement.

## Dashboard

`/admin` in the web app. Authorisation is read **from the chain** — the connected
wallet's roles are queried live and controls appear accordingly. A hidden button is a
courtesy; the contract is the boundary.

It shows current epoch, pause state, treasury and liabilities, the solvency invariant,
oracle and pool health (including seconds since the last observation), unresolved work,
and indexer lag.

## Common operations

### Change the fee

```bash
cast send $MARKET "proposeTreasuryFee(uint32)" 250 --private-key $CONFIG_KEY
# wait 2 days
cast send $MARKET "commitTreasuryFee()" --private-key $CONFIG_KEY
```

Rounds already open keep the fee they were created with.

### Change the round interval

```bash
cast send $MARKET "setInterval(uint32)" 900 --private-key $CONFIG_KEY
```

Takes effect for rounds created afterwards. One transitional round has an entry window of
the old length and a live window of the new one; the close/lock boundary invariant is
preserved throughout.

**Keep `bufferSeconds / interval` inside the scan window.** `executeRound` and
`pendingWork` walk back over rounds that might still be unresolved, bounded by
`MAX_SCAN_ROUNDS` (64). The contract rejects a combination the scan could not cover —
`bufferSeconds <= 61 * interval` — so raising the tolerance may require lengthening the
interval too. `lockRound`, `settleRound` and `cancelRound` address one round each, never
loop, and remain available for anything outside the window.

**Keep `twapWindow <= interval`.** A longer window makes lock and close windows overlap,
so part of the closing average is already settled when entries close. The deploy script
enforces this; `setInterval` does not, so shortening the interval below the window is an
operator error to avoid.

### Adjust exposure limits

```bash
cast send $MARKET "setMaximumRoundPool(uint256)" 2000000000000000000 --private-key $CONFIG_KEY
```

**Do not raise these without redoing [MANIPULATION_ANALYSIS.md](MANIPULATION_ANALYSIS.md)
against current liquidity.** The caps are what keep the prize below the cost of moving the
oracle.

### Pause

```bash
cast send $MARKET "pausePrediction()" --private-key $PAUSER_KEY
```

Stops new entries. Settlement, claims and refunds continue — deliberately, because
stopping them would strand user funds.

### Rotate the keeper

```bash
cast send $MARKET "grantRole(bytes32,address)"  $(cast call $MARKET "OPERATOR_ROLE()(bytes32)") $NEW --private-key $ADMIN_KEY
cast send $MARKET "revokeRole(bytes32,address)" $(cast call $MARKET "OPERATOR_ROLE()(bytes32)") $OLD --private-key $ADMIN_KEY
```

Safe at any time: the role only gates genesis, and the market keeps running regardless.

### Migrate the oracle

```bash
cast send $MARKET "proposeOracle(address)" $NEW_ORACLE --private-key $CONFIG_KEY
# wait 2 days
cast send $MARKET "commitOracle()" --private-key $CONFIG_KEY
```

Only affects rounds created afterwards. Each round records the oracle and version that
governed it, so historical rounds remain provably settled under their original rules.

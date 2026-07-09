import type {Db} from "./db.js";
import type {PoolClient} from "pg";

/**
 * Turns contract logs into read-model rows.
 *
 * Every statement here is an upsert keyed by something the chain already guarantees is
 * unique. That is what makes the indexer safe to restart, safe to backfill over ground
 * it has already covered, and safe to run through a reorg: replaying a log rewrites the
 * same row rather than adding a second one.
 *
 * Nothing in this file interprets a price or decides an outcome. Outcomes arrive already
 * decided, in `RoundSettled`.
 */

export interface DecodedLog {
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  blockTime?: Date;
  sender?: string;
}

const OUTCOME = ["UNDECIDED", "BULL", "BEAR", "TIE", "NO_CONTEST", "ALL_LOST"] as const;

const s = (v: unknown): string => String(v);
const n = (v: unknown): string => (v === undefined || v === null ? "0" : String(v));

export async function applyLog(client: PoolClient, chainId: number, ev: DecodedLog): Promise<void> {
  const epoch = ev.args.epoch !== undefined ? String(ev.args.epoch) : null;

  // The raw log, recorded first so every derived row can be traced back to its source.
  await client.query(
    `INSERT INTO events (chain_id, block_number, block_hash, tx_hash, log_index, name, epoch, payload, block_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (chain_id, block_number, tx_hash, log_index) DO NOTHING`,
    [
      chainId,
      ev.blockNumber.toString(),
      ev.blockHash,
      ev.transactionHash,
      ev.logIndex,
      ev.name,
      epoch,
      JSON.stringify(ev.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ev.blockTime ?? null,
    ]
  );

  switch (ev.name) {
    case "RoundStarted":
      await client.query(
        `INSERT INTO rounds (chain_id, epoch, start_timestamp, lock_timestamp, close_timestamp, status)
         VALUES ($1,$2,$3,$4,$5,'OPEN')
         ON CONFLICT (chain_id, epoch) DO UPDATE SET
           start_timestamp = EXCLUDED.start_timestamp,
           lock_timestamp  = EXCLUDED.lock_timestamp,
           close_timestamp = EXCLUDED.close_timestamp`,
        [chainId, epoch, n(ev.args.startTimestamp), n(ev.args.lockTimestamp), n(ev.args.closeTimestamp)]
      );
      break;

    case "RoundLocked": {
      const instant = BigInt(n(ev.args.instant));
      const executedAt = BigInt(n(ev.args.executedAt));
      await client.query(
        `UPDATE rounds SET lock_price=$3, lock_tick=$4, locked_at=$5, status='LOCKED'
         WHERE chain_id=$1 AND epoch=$2`,
        [chainId, epoch, n(ev.args.lockPrice), Number(ev.args.lockTick ?? 0), executedAt.toString()]
      );
      // Seal lag: how long after the scheduled instant the price actually became
      // obtainable. Recorded because it is the metric that says whether the market is
      // healthy, and it is invisible anywhere else.
      await client.query(
        `INSERT INTO oracle_observations (chain_id, epoch, kind, instant, price, tick, executed_at, lag_seconds, tx_hash)
         VALUES ($1,$2,'LOCK',$3,$4,$5,$6,$7,$8)
         ON CONFLICT (chain_id, epoch, kind) DO UPDATE SET
           price=EXCLUDED.price, tick=EXCLUDED.tick, executed_at=EXCLUDED.executed_at,
           lag_seconds=EXCLUDED.lag_seconds, tx_hash=EXCLUDED.tx_hash`,
        [
          chainId, epoch, instant.toString(), n(ev.args.lockPrice), Number(ev.args.lockTick ?? 0),
          executedAt.toString(), (executedAt - instant).toString(), ev.transactionHash,
        ]
      );
      await recordExecution(client, chainId, ev, "lock");
      break;
    }

    case "RoundSettled": {
      const instantRow = await client.query<{close_timestamp: string}>(
        `SELECT close_timestamp FROM rounds WHERE chain_id=$1 AND epoch=$2`,
        [chainId, epoch]
      );
      const instant = BigInt(instantRow.rows[0]?.close_timestamp ?? "0");
      const executedAt = BigInt(n(ev.args.executedAt));
      const outcome = OUTCOME[Number(ev.args.outcome ?? 0)] ?? "UNDECIDED";

      await client.query(
        `UPDATE rounds SET close_price=$3, close_tick=$4, settled_at=$5, status='SETTLED',
                           outcome=$6, reward_base=$7, reward_amount=$8, burn_fee=$9
         WHERE chain_id=$1 AND epoch=$2`,
        [
          chainId, epoch, n(ev.args.closePrice), Number(ev.args.closeTick ?? 0), executedAt.toString(),
          outcome, n(ev.args.rewardBaseAmount), n(ev.args.rewardAmount), n(ev.args.burnFee),
        ]
      );
      if (instant > 0n) {
        await client.query(
          `INSERT INTO oracle_observations (chain_id, epoch, kind, instant, price, tick, executed_at, lag_seconds, tx_hash)
           VALUES ($1,$2,'CLOSE',$3,$4,$5,$6,$7,$8)
           ON CONFLICT (chain_id, epoch, kind) DO UPDATE SET
             price=EXCLUDED.price, tick=EXCLUDED.tick, executed_at=EXCLUDED.executed_at,
             lag_seconds=EXCLUDED.lag_seconds, tx_hash=EXCLUDED.tx_hash`,
          [
            chainId, epoch, instant.toString(), n(ev.args.closePrice), Number(ev.args.closeTick ?? 0),
            executedAt.toString(), (executedAt - instant).toString(), ev.transactionHash,
          ]
        );
      }
      if (BigInt(n(ev.args.burnFee)) > 0n) {
        await client.query(
          `INSERT INTO burn_events (chain_id, tx_hash, log_index, block_number, kind, amount, detail, block_time)
           VALUES ($1,$2,$3,$4,'FEE_ACCRUED',$5,$6,$7)
           ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
          [chainId, ev.transactionHash, ev.logIndex, ev.blockNumber.toString(), n(ev.args.burnFee),
           JSON.stringify({epoch}), ev.blockTime ?? null]
        );
      }
      await markWinners(client, chainId, epoch!, outcome);
      await recordExecution(client, chainId, ev, "settle");
      break;
    }

    case "RoundCancelled":
      await client.query(
        `UPDATE rounds SET status='CANCELLED', outcome='CANCELLED', cancel_reason=$3 WHERE chain_id=$1 AND epoch=$2`,
        [chainId, epoch, s(ev.args.reason)]
      );
      await recordExecution(client, chainId, ev, "cancel");
      break;

    case "BetBull":
    case "BetBear": {
      const account = s(ev.args.sender).toLowerCase();
      const position = ev.name === "BetBull" ? "BULL" : "BEAR";
      await client.query(
        `INSERT INTO bets (chain_id, epoch, account, position, amount, block_number, tx_hash, log_index, block_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (chain_id, epoch, account) DO UPDATE SET
           position=EXCLUDED.position, amount=EXCLUDED.amount, block_number=EXCLUDED.block_number,
           tx_hash=EXCLUDED.tx_hash, log_index=EXCLUDED.log_index`,
        [chainId, epoch, account, position, n(ev.args.amount), ev.blockNumber.toString(), ev.transactionHash,
         ev.logIndex, ev.blockTime ?? null]
      );
      // Round totals are recomputed from the bets themselves rather than incremented, so
      // a replayed log cannot inflate them.
      await recomputeRoundTotals(client, chainId, epoch!);
      await recomputeUser(client, chainId, account);
      break;
    }

    case "Claim":
    case "Refund": {
      const account = s(ev.args.sender).toLowerCase();
      await client.query(
        `INSERT INTO claims (chain_id, epoch, account, amount, kind, block_number, tx_hash, log_index, block_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (chain_id, epoch, account, kind) DO UPDATE SET
           amount=EXCLUDED.amount, block_number=EXCLUDED.block_number, tx_hash=EXCLUDED.tx_hash`,
        [chainId, epoch, account, n(ev.args.amount), ev.name === "Claim" ? "CLAIM" : "REFUND",
         ev.blockNumber.toString(), ev.transactionHash, ev.logIndex, ev.blockTime ?? null]
      );
      await recomputeUser(client, chainId, account);
      break;
    }

    // v2 name, then v1: the same withdrawal, recorded the same way.
    case "BurnSwept":
    case "TreasuryClaim":
      await client.query(
        `INSERT INTO burn_events (chain_id, tx_hash, log_index, block_number, kind, amount, detail, block_time)
         VALUES ($1,$2,$3,$4,'SWEPT_TO_BURNER',$5,$6,$7)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
        [chainId, ev.transactionHash, ev.logIndex, ev.blockNumber.toString(), n(ev.args.amount),
         JSON.stringify({to: s(ev.args.to)}), ev.blockTime ?? null]
      );
      break;

    // Emitted by PonsBuybackBurner, not the market. Recorded per event so the burned
    // supply shown anywhere is a sum over observed burns rather than a claimed figure.
    case "BoughtAndBurned":
      await client.query(
        `INSERT INTO burns (chain_id, tx_hash, log_index, block_number, target_index, token,
                            eth_in, burned, floor_amount, block_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
        [
          chainId, ev.transactionHash, ev.logIndex, ev.blockNumber.toString(),
          Number(ev.args.index ?? 0), s(ev.args.token).toLowerCase(),
          n(ev.args.ethIn), n(ev.args.burned), n(ev.args.floor), ev.blockTime ?? null,
        ]
      );
      break;

    // Configuration and role changes are kept as an audit trail. They cannot change a
    // decided round, but an operator investigating an incident needs to see them.
    case "FeeUpdated":
    case "OracleUpdated":
    case "IntervalUpdated":
    case "TwapWindowUpdated":
    case "BufferSecondsUpdated":
    case "MinimumBetUpdated":
    case "MaximumBetUpdated":
    case "MaximumRoundPoolUpdated":
    case "BurnerUpdated":
    case "TreasuryUpdated":
    case "TargetConfigured":
    case "RateLimitUpdated":
    case "FeeChangeProposed":
    case "OracleChangeProposed":
    case "RoleGranted":
    case "RoleRevoked":
    case "Paused":
    case "Unpaused":
      await client.query(
        `INSERT INTO burn_events (chain_id, tx_hash, log_index, block_number, kind, amount, detail, block_time)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
        [chainId, ev.transactionHash, ev.logIndex, ev.blockNumber.toString(), `CONFIG_${ev.name}`,
         JSON.stringify(ev.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), ev.blockTime ?? null]
      );
      break;

    default:
      break;
  }
}

async function recordExecution(client: PoolClient, chainId: number, ev: DecodedLog, action: string) {
  await client.query(
    `INSERT INTO keeper_executions (chain_id, tx_hash, block_number, sender, action, epoch, block_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (chain_id, tx_hash, action, epoch) DO NOTHING`,
    [chainId, ev.transactionHash, ev.blockNumber.toString(), (ev.sender ?? "").toLowerCase(), action,
     ev.args.epoch !== undefined ? String(ev.args.epoch) : null, ev.blockTime ?? null]
  );
}

/** Recomputed from `bets`, never incremented, so replays are harmless. */
async function recomputeRoundTotals(client: PoolClient, chainId: number, epoch: string) {
  await client.query(
    `UPDATE rounds r SET
       bull_amount  = COALESCE(b.bull, 0),
       bear_amount  = COALESCE(b.bear, 0),
       total_amount = COALESCE(b.bull, 0) + COALESCE(b.bear, 0)
     FROM (
       SELECT
         SUM(amount) FILTER (WHERE position='BULL') AS bull,
         SUM(amount) FILTER (WHERE position='BEAR') AS bear
       FROM bets WHERE chain_id=$1 AND epoch=$2
     ) b
     WHERE r.chain_id=$1 AND r.epoch=$2`,
    [chainId, epoch]
  );
}

async function recomputeUser(client: PoolClient, chainId: number, account: string) {
  await client.query(
    `INSERT INTO users (chain_id, account, rounds_entered, rounds_won, total_staked, total_claimed, total_refunded,
                        first_seen, last_seen)
     SELECT $1, $2,
       (SELECT COUNT(*) FROM bets WHERE chain_id=$1 AND account=$2),
       (SELECT COUNT(*) FROM claims WHERE chain_id=$1 AND account=$2 AND kind='CLAIM'),
       (SELECT COALESCE(SUM(amount),0) FROM bets WHERE chain_id=$1 AND account=$2),
       (SELECT COALESCE(SUM(amount),0) FROM claims WHERE chain_id=$1 AND account=$2 AND kind='CLAIM'),
       (SELECT COALESCE(SUM(amount),0) FROM claims WHERE chain_id=$1 AND account=$2 AND kind='REFUND'),
       (SELECT MIN(block_time) FROM bets WHERE chain_id=$1 AND account=$2),
       (SELECT MAX(block_time) FROM bets WHERE chain_id=$1 AND account=$2)
     ON CONFLICT (chain_id, account) DO UPDATE SET
       rounds_entered=EXCLUDED.rounds_entered, rounds_won=EXCLUDED.rounds_won,
       total_staked=EXCLUDED.total_staked, total_claimed=EXCLUDED.total_claimed,
       total_refunded=EXCLUDED.total_refunded, first_seen=EXCLUDED.first_seen, last_seen=EXCLUDED.last_seen`,
    [chainId, account]
  );
}

/** Refreshes win counts once a round's outcome is known. */
async function markWinners(client: PoolClient, chainId: number, epoch: string, outcome: string) {
  if (outcome !== "BULL" && outcome !== "BEAR") return;
  await client.query(
    `UPDATE users u SET rounds_won = (
       SELECT COUNT(*) FROM claims c WHERE c.chain_id=u.chain_id AND c.account=u.account AND c.kind='CLAIM')
     WHERE u.chain_id=$1 AND u.account IN (SELECT account FROM bets WHERE chain_id=$1 AND epoch=$2)`,
    [chainId, epoch]
  );
}

/** Removes everything at or above `fromBlock`, so a reorg can be re-indexed cleanly. */
export async function rollbackFrom(db: Db, chainId: number, fromBlock: bigint): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const b = fromBlock.toString();
    await client.query(`DELETE FROM events WHERE chain_id=$1 AND block_number >= $2`, [chainId, b]);
    await client.query(`DELETE FROM bets WHERE chain_id=$1 AND block_number >= $2`, [chainId, b]);
    await client.query(`DELETE FROM claims WHERE chain_id=$1 AND block_number >= $2`, [chainId, b]);
    await client.query(`DELETE FROM keeper_executions WHERE chain_id=$1 AND block_number >= $2`, [chainId, b]);
    await client.query(`DELETE FROM burn_events WHERE chain_id=$1 AND block_number >= $2`, [chainId, b]);
    // Rounds and users are derived, so they are rebuilt by replaying the surviving
    // events rather than deleted outright — dropping them would lose rounds that were
    // created below the reorg point.
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

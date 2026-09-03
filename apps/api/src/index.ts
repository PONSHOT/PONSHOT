import {createServer} from "node:http";
import {readFileSync} from "node:fs";
import {PonsPredictionAbi, UniswapV3PonsOracleAbi} from "@pons/sdk";
import {ROBINHOOD_CHAIN_ID, robinhood, robinhoodTestnet} from "@pons/config";
import pg from "pg";
import {createPublicClient, defineChain, fallback, http} from "viem";
import type {Address} from "viem";
import {Router} from "./router.js";

/**
 * Read API over the indexed data.
 *
 * The one rule that shapes every handler: **this service never decides anything.** It
 * reports what the chain already decided. There is no write path, no settlement logic
 * and no price of its own — where a caller needs a live number rather than an indexed
 * one, the request is forwarded to the chain and labelled as such in the response.
 *
 * Responses carry `source: "chain" | "index"` so a client can tell a freshly-read value
 * from one that may be a few blocks stale.
 */

const {Pool} = pg;
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => v);

const CHAIN_ID = Number(process.env.CHAIN_ID ?? ROBINHOOD_CHAIN_ID);
const PORT = Number(process.env.PORT ?? 8789);
const db = new Pool({connectionString: process.env.DATABASE_URL ?? "postgres://pons:pons@127.0.0.1:5432/pons"});

const deploymentPath = process.env.DEPLOYMENTS_PATH ?? `${process.cwd()}/../../deployments/${CHAIN_ID}.json`;
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
const PREDICTION = deployment.PonsPrediction as Address;
const ORACLE = deployment.PonsOracleAdapter as Address;

const rpcUrls = (process.env.RPC_URLS ?? robinhood.rpcUrls.default.http.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const chain =
  CHAIN_ID === robinhood.id
    ? robinhood
    : CHAIN_ID === robinhoodTestnet.id
      ? robinhoodTestnet
      : defineChain({
          id: CHAIN_ID,
          name: `chain-${CHAIN_ID}`,
          nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
          rpcUrls: {default: {http: rpcUrls}},
        });

const client = createPublicClient({chain, transport: fallback(rpcUrls.map((u) => http(u, {timeout: 15_000})))});

const readMarket = (fn: string, args: readonly unknown[] = []) =>
  client.readContract({address: PREDICTION, abi: PonsPredictionAbi, functionName: fn as never, args: args as never});
const readOracle = (fn: string, args: readonly unknown[] = []) =>
  client.readContract({address: ORACLE, abi: UniswapV3PonsOracleAbi, functionName: fn as never, args: args as never});

const limitOf = (q: URLSearchParams, fallbackValue = 50, max = 200) =>
  Math.min(max, Math.max(1, Number(q.get("limit") ?? fallbackValue) || fallbackValue));

function requireAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("invalid wallet address");
  return value.toLowerCase();
}

const roundRow = (r: Record<string, unknown>) => ({
  epoch: r.epoch,
  startTimestamp: Number(r.start_timestamp),
  lockTimestamp: Number(r.lock_timestamp),
  closeTimestamp: Number(r.close_timestamp),
  lockPrice: r.lock_price,
  closePrice: r.close_price,
  lockTick: r.lock_tick,
  closeTick: r.close_tick,
  // Kept distinct from the scheduled instants: the gap between them is keeper lateness,
  // and it must not be presented as if the price were taken when the transaction landed.
  lockedAt: r.locked_at === null ? null : Number(r.locked_at),
  settledAt: r.settled_at === null ? null : Number(r.settled_at),
  totalAmount: r.total_amount,
  bullAmount: r.bull_amount,
  bearAmount: r.bear_amount,
  rewardBaseAmount: r.reward_base,
  rewardAmount: r.reward_amount,
  treasuryFee: r.treasury_fee,
  status: r.status,
  outcome: r.outcome,
  cancelReason: r.cancel_reason,
});

const router = new Router();

router.get("/health", async () => {
  // Scoped to *this* market. An unfiltered read would pick up the cursor of any other
  // market indexed into the same database and report its progress as ours.
  const [{rows}, head] = await Promise.all([
    db.query<{last_block: string}>(`SELECT last_block FROM indexer_state WHERE id = $1`, [
      `${CHAIN_ID}:${PREDICTION.toLowerCase()}`,
    ]),
    client.getBlockNumber().catch(() => null),
  ]);
  const indexed = rows[0] ? Number(rows[0].last_block) : 0;
  const lag = head === null ? null : Number(head) - indexed;
  // A negative lag is not a small lag: it means the cursor sits ahead of the chain head,
  // so the read model describes a chain that no longer exists. Reported as its own
  // condition rather than clamped, because clamping would make it look healthy.
  const cursorAheadOfHead = lag !== null && lag < 0;
  return {
    ok: head !== null && !cursorAheadOfHead,
    chainId: CHAIN_ID,
    headBlock: head === null ? null : Number(head),
    indexedBlock: indexed,
    indexerLagBlocks: lag,
    cursorAheadOfHead,
    prediction: PREDICTION,
    oracle: ORACLE,
  };
});

/** The live three-card view, read straight from the chain so it is never stale. */
router.get("/prediction/current", async () => {
  const [previous, live, next] = (await readMarket("getVisibleRounds")) as unknown as [
    Record<string, bigint>,
    Record<string, bigint>,
    Record<string, bigint>,
  ];
  const [currentEpoch, feeBps, minBet, maxBet, maxPool, paused, interval] = await Promise.all([
    readMarket("currentEpoch"),
    readMarket("treasuryFeeBps"),
    readMarket("minimumBet"),
    readMarket("maximumBet"),
    readMarket("maximumRoundPool"),
    readMarket("paused"),
    readMarket("interval"),
  ]);
  const phases = await Promise.all(
    [previous, live, next].map((r) => (r.epoch === 0n ? Promise.resolve(0) : readMarket("phaseOf", [r.epoch])))
  );
  return {
    source: "chain",
    currentEpoch,
    interval,
    treasuryFeeBps: feeBps,
    minimumBet: minBet,
    maximumBet: maxBet,
    maximumRoundPool: maxPool,
    paused,
    rounds: {
      previous: {...previous, phase: phases[0]},
      live: {...live, phase: phases[1]},
      next: {...next, phase: phases[2]},
    },
  };
});

router.get("/prediction/rounds", async ({query}) => {
  const limit = limitOf(query);
  const before = query.get("before");
  const {rows} = await db.query(
    `SELECT * FROM rounds WHERE chain_id=$1 ${before ? "AND epoch < $3" : ""} ORDER BY epoch DESC LIMIT $2`,
    before ? [CHAIN_ID, limit, before] : [CHAIN_ID, limit]
  );
  return {source: "index", rounds: rows.map(roundRow), nextBefore: rows.at(-1)?.epoch ?? null};
});

router.get("/prediction/rounds/:epoch", async ({params}) => {
  const {rows} = await db.query(`SELECT * FROM rounds WHERE chain_id=$1 AND epoch=$2`, [CHAIN_ID, params.epoch]);
  if (rows.length === 0) throw new Error("round not found");
  const bets = await db.query(
    `SELECT account, position, amount, tx_hash, block_time FROM bets WHERE chain_id=$1 AND epoch=$2 ORDER BY amount DESC`,
    [CHAIN_ID, params.epoch]
  );
  const obs = await db.query(
    `SELECT kind, instant, price, tick, executed_at, lag_seconds FROM oracle_observations WHERE chain_id=$1 AND epoch=$2`,
    [CHAIN_ID, params.epoch]
  );
  return {source: "index", round: roundRow(rows[0]!), bets: bets.rows, oracle: obs.rows};
});

/** Settled and cancelled rounds only — the historical record. */
router.get("/prediction/history", async ({query}) => {
  const limit = limitOf(query);
  const {rows} = await db.query(
    `SELECT * FROM rounds WHERE chain_id=$1 AND status IN ('SETTLED','CANCELLED') ORDER BY epoch DESC LIMIT $2`,
    [CHAIN_ID, limit]
  );
  return {source: "index", rounds: rows.map(roundRow)};
});

/**
 * Aggregate statistics.
 *
 * Every figure below is a SQL aggregate over indexed events. Nothing is estimated,
 * extrapolated or carried over from a previous period — if the indexer has not seen it,
 * it is not counted.
 */
router.get("/prediction/stats", async () => {
  const {rows} = await db.query<Record<string, string>>(
    `SELECT
       (SELECT COUNT(*) FROM rounds WHERE chain_id=$1)                                  AS total_rounds,
       (SELECT COUNT(*) FROM rounds WHERE chain_id=$1 AND status='SETTLED')             AS settled_rounds,
       (SELECT COUNT(*) FROM rounds WHERE chain_id=$1 AND status='CANCELLED')           AS cancelled_rounds,
       (SELECT COUNT(*) FROM bets WHERE chain_id=$1)                                    AS total_predictions,
       (SELECT COUNT(DISTINCT account) FROM bets WHERE chain_id=$1)                     AS unique_wallets,
       (SELECT COALESCE(SUM(amount),0) FROM bets WHERE chain_id=$1)                     AS total_volume,
       (SELECT COALESCE(SUM(amount),0) FROM bets WHERE chain_id=$1 AND position='BULL') AS bull_volume,
       (SELECT COALESCE(SUM(amount),0) FROM bets WHERE chain_id=$1 AND position='BEAR') AS bear_volume,
       (SELECT COALESCE(SUM(amount),0) FROM claims WHERE chain_id=$1 AND kind='CLAIM')  AS total_paid_to_winners,
       (SELECT COALESCE(SUM(amount),0) FROM claims WHERE chain_id=$1 AND kind='REFUND') AS total_refunded,
       (SELECT COALESCE(SUM(treasury_fee),0) FROM rounds WHERE chain_id=$1)             AS treasury_fees_accrued,
       (SELECT COUNT(*) FROM rounds WHERE chain_id=$1 AND outcome='BULL')               AS bull_wins,
       (SELECT COUNT(*) FROM rounds WHERE chain_id=$1 AND outcome='BEAR')               AS bear_wins,
       (SELECT COUNT(*) FROM rounds WHERE chain_id=$1 AND outcome='TIE')                AS ties,
       (SELECT COUNT(*) FROM rounds WHERE chain_id=$1 AND outcome='NO_CONTEST')         AS no_contests`,
    [CHAIN_ID]
  );
  const oracleHealth = await db.query(
    `SELECT kind, COUNT(*) AS samples, ROUND(AVG(lag_seconds)) AS avg_lag_seconds, MAX(lag_seconds) AS max_lag_seconds
     FROM oracle_observations WHERE chain_id=$1 GROUP BY kind`,
    [CHAIN_ID]
  );
  const currentEpoch = (await readMarket("currentEpoch")) as bigint;
  const currentRound = await db.query(`SELECT total_amount FROM rounds WHERE chain_id=$1 AND epoch=$2`, [
    CHAIN_ID,
    currentEpoch.toString(),
  ]);
  return {
    source: "index",
    ...rows[0],
    current_round_volume: currentRound.rows[0]?.total_amount ?? "0",
    // Surfaced because it is the number that says whether the oracle is keeping up.
    oracle_settlement_lag: oracleHealth.rows,
  };
});

router.get("/users/:wallet/predictions", async ({params, query}) => {
  const account = requireAddress(params.wallet!);
  const limit = limitOf(query);
  const {rows} = await db.query(
    `SELECT b.epoch, b.position, b.amount, b.tx_hash, b.block_time,
            r.status, r.outcome, r.lock_price, r.close_price, r.reward_amount, r.reward_base,
            c.amount AS claimed_amount, c.kind AS claim_kind
     FROM bets b
     JOIN rounds r ON r.chain_id=b.chain_id AND r.epoch=b.epoch
     LEFT JOIN claims c ON c.chain_id=b.chain_id AND c.epoch=b.epoch AND c.account=b.account
     WHERE b.chain_id=$1 AND b.account=$2
     ORDER BY b.epoch DESC LIMIT $3`,
    [CHAIN_ID, account, limit]
  );
  const summary = await db.query(`SELECT * FROM users WHERE chain_id=$1 AND account=$2`, [CHAIN_ID, account]);
  return {source: "index", account, summary: summary.rows[0] ?? null, predictions: rows};
});

/**
 * What a wallet can collect right now.
 *
 * Read from the chain rather than the index on purpose: this is the number a user is
 * about to send a transaction against, so a stale answer here would be an answer that
 * makes their transaction revert.
 */
router.get("/users/:wallet/claimable", async ({params}) => {
  const account = requireAddress(params.wallet!);
  const {rows} = await db.query<{epoch: string}>(
    `SELECT b.epoch FROM bets b
     JOIN rounds r ON r.chain_id=b.chain_id AND r.epoch=b.epoch
     LEFT JOIN claims c ON c.chain_id=b.chain_id AND c.epoch=b.epoch AND c.account=b.account
     WHERE b.chain_id=$1 AND b.account=$2 AND c.epoch IS NULL
       AND r.status IN ('SETTLED','CANCELLED')
     ORDER BY b.epoch DESC LIMIT 200`,
    [CHAIN_ID, account]
  );

  const entries = await Promise.all(
    rows.map(async ({epoch}) => {
      const [claimable, refundable] = await Promise.all([
        readMarket("claimable", [BigInt(epoch), account as Address]),
        readMarket("refundable", [BigInt(epoch), account as Address]),
      ]);
      return {epoch, claimable, refundable};
    })
  );
  const actionable = entries.filter((e) => (e.claimable as bigint) > 0n || (e.refundable as bigint) > 0n);
  return {
    source: "chain",
    account,
    epochs: actionable.map((e) => e.epoch),
    entries: actionable,
    totalClaimable: actionable.reduce((a, e) => a + (e.claimable as bigint), 0n),
    totalRefundable: actionable.reduce((a, e) => a + (e.refundable as bigint), 0n),
  };
});

/**
 * Live PONS price.
 *
 * Returns both figures side by side and says plainly which one settles rounds. Showing
 * only spot would invite the assumption that spot decides outcomes; showing only the
 * TWAP would make the UI look wrong next to a chart.
 */
router.get("/price/pons", async () => {
  const [[spot, tick], [twap, asOf]] = (await Promise.all([readOracle("getSpotPrice"), readOracle("getPrice")])) as [
    [bigint, number],
    [bigint, bigint],
  ];
  return {
    source: "chain",
    pair: "PONS/WETH",
    spot: {wethPerPons: spot, tick, note: "instantaneous pool price; display only, does not settle rounds"},
    twap: {wethPerPons: twap, asOf, note: "time-weighted average; this is what settles rounds"},
  };
});

/** Oracle and pool health, for the admin dashboard and for alerting. */
router.get("/oracle/pons", async () => {
  const [obs, liquidity, description, window, block] = (await Promise.all([
    readOracle("observationState"),
    readOracle("poolLiquidity"),
    readOracle("description"),
    readOracle("defaultTwapWindow"),
    client.getBlock(),
  ])) as [[number, number, number, bigint, bigint], bigint, string, number, {timestamp: bigint}];
  const [index, cardinality, cardinalityNext, oldest, newest] = obs;
  // Chain time, not wall-clock. Observation timestamps are chain timestamps, and on any
  // chain whose clock is offset from the operator's host (a test network, a fork, a node
  // with drift) subtracting Date.now() produces a nonsense — including negative — lag.
  const now = Number(block.timestamp);
  return {
    source: "chain",
    description,
    defaultTwapWindow: window,
    poolLiquidity: liquidity,
    observations: {
      index,
      cardinality,
      cardinalityNext,
      oldest: Number(oldest),
      newest: Number(newest),
      historySpanSeconds: Number(newest) - Number(oldest),
      // How long ago the pool last recorded anything. A large value means recent
      // instants are not yet priceable, which is the leading indicator of a stalled round.
      secondsSinceLastObservation: now - Number(newest),
    },
  };
});

/**
 * OHLC candles for the price chart.
 *
 * Aggregated in SQL from `price_samples` rather than assembled in JavaScript, so a long
 * range stays one round trip and the arithmetic happens where the rows are. Prices stay
 * strings the whole way: they are uint256 wei and a JSON number would round them.
 */
router.get("/price/candles", async ({query}) => {
  const INTERVALS: Record<string, number> = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600};
  const key = query.get("interval") ?? "5m";
  const bucket = INTERVALS[key];
  if (!bucket) throw new Error(`invalid interval; expected one of ${Object.keys(INTERVALS).join(", ")}`);
  const limit = limitOf(query, 120, 500);

  const {rows} = await db.query(
    `WITH bucketed AS (
       SELECT (ts / $2) * $2 AS bucket_ts, ts, spot
       FROM price_samples WHERE chain_id = $1
     )
     SELECT bucket_ts AS t,
            (array_agg(spot ORDER BY ts ASC))[1]  AS o,
            MAX(spot)                             AS h,
            MIN(spot)                             AS l,
            (array_agg(spot ORDER BY ts DESC))[1] AS c,
            COUNT(*)                              AS samples
     FROM bucketed
     GROUP BY bucket_ts
     ORDER BY bucket_ts DESC
     LIMIT $3`,
    [CHAIN_ID, bucket, limit]
  );

  return {
    source: "index",
    interval: key,
    intervalSeconds: bucket,
    // Oldest first: that is the order a chart draws in.
    candles: rows.reverse().map((r) => ({
      t: Number(r.t),
      o: r.o,
      h: r.h,
      l: r.l,
      c: r.c,
      samples: Number(r.samples),
    })),
    note: "spot price; rounds settle on the TWAP, not on these candles",
  };
});

/**
 * Leaderboard.
 *
 * Profit is realised only: claims and refunds actually collected, minus everything
 * staked. A wallet sitting on an unclaimed win therefore reads as negative until it
 * claims, which is the honest reading — the money is not theirs until they take it, and
 * counting it early would let an abandoned position inflate a ranking forever.
 */
router.get("/leaderboard", async ({query}) => {
  const WINDOWS: Record<string, string | null> = {
    "24h": "1 day",
    "7d": "7 days",
    "30d": "30 days",
    all: null,
  };
  const key = query.get("window") ?? "all";
  if (!(key in WINDOWS)) throw new Error(`invalid window; expected one of ${Object.keys(WINDOWS).join(", ")}`);
  const interval = WINDOWS[key];
  const limit = limitOf(query, 25, 100);
  const since = interval ? `AND b.block_time >= now() - interval '${interval}'` : "";

  const {rows} = await db.query(
    `SELECT b.account,
            COUNT(*)                                                        AS rounds_played,
            -- Won means "called it right", judged from the round's own outcome. Counting
            -- CLAIM events instead would score an unclaimed win as a wrong prediction,
            -- which is a statement about diligence, not about accuracy.
            COUNT(*) FILTER (WHERE r.outcome = 'BULL' AND b.position = 'BULL'
                             OR    r.outcome = 'BEAR' AND b.position = 'BEAR')  AS rounds_won,
            COUNT(*) FILTER (WHERE r.status = 'SETTLED'
                             AND r.outcome IN ('BULL','BEAR'))              AS rounds_decided,
            COALESCE(SUM(b.amount), 0)                                      AS staked,
            COALESCE(SUM(c.amount), 0)                                      AS collected,
            COALESCE(MAX(c.amount) FILTER (WHERE c.kind = 'CLAIM'), 0)      AS biggest_win
     FROM bets b
     JOIN rounds r  ON r.chain_id = b.chain_id AND r.epoch = b.epoch
     LEFT JOIN claims c ON c.chain_id = b.chain_id AND c.epoch = b.epoch AND c.account = b.account
     WHERE b.chain_id = $1 ${since}
     GROUP BY b.account
     ORDER BY (COALESCE(SUM(c.amount), 0) - COALESCE(SUM(b.amount), 0)) DESC
     LIMIT $2`,
    [CHAIN_ID, limit]
  );

  return {
    source: "index",
    window: key,
    entries: rows.map((r, i) => {
      const staked = BigInt(r.staked);
      const collected = BigInt(r.collected);
      const decided = Number(r.rounds_decided);
      return {
        rank: i + 1,
        account: r.account,
        roundsPlayed: Number(r.rounds_played),
        roundsWon: Number(r.rounds_won),
        // Accuracy counts only rounds that actually produced a winner; ties and
        // no-contests were never a call anyone could get right or wrong.
        roundsDecided: decided,
        accuracyBps: decided === 0 ? null : Math.round((Number(r.rounds_won) / decided) * 10_000),
        staked,
        collected,
        netProfit: collected - staked,
        biggestWin: BigInt(r.biggest_win),
      };
    }),
    note:
      "accuracy is calls made correctly, from each round's outcome; profit is realised only, " +
      "so winnings that have not been claimed are not counted as profit yet",
  };
});

/** Recent entries across all rounds, for the live trade feed. */
router.get("/prediction/trades", async ({query}) => {
  const limit = limitOf(query, 30, 100);
  const {rows} = await db.query(
    `SELECT b.epoch, b.account, b.position, b.amount, b.tx_hash, b.block_time,
            r.lock_price, r.status, r.outcome
     FROM bets b
     JOIN rounds r ON r.chain_id = b.chain_id AND r.epoch = b.epoch
     WHERE b.chain_id = $1
     ORDER BY b.block_number DESC, b.log_index DESC
     LIMIT $2`,
    [CHAIN_ID, limit]
  );
  return {source: "index", trades: rows};
});

const server = createServer((req, res) => {
  void router.handle(req, res);
});
server.listen(PORT, () => {
  console.log(JSON.stringify({level: "info", msg: "api listening", port: PORT, chainId: CHAIN_ID}));
});

const shutdown = async () => {
  server.close();
  await db.end().catch(() => {});
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

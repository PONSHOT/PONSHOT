import {createServer} from "node:http";
import {MarketAbiWithLegacy, PonsBuybackBurnerAbi, UniswapV3PonsOracleAbi} from "@pons/sdk";
import {nodeHttp} from "@pons/sdk/node-rpc";
import {createPublicClient, fallback, parseEventLogs} from "viem";
import type {Chain, PublicClient} from "viem";
import type {IndexerConfig} from "./config.js";
import type {Db} from "./db.js";
import {applyLog, rollbackFrom} from "./handlers.js";
import type {DecodedLog} from "./handlers.js";
import {log} from "./logger.js";

/**
 * Log indexer for PonsPrediction.
 *
 * Three things it has to get right, and how:
 *
 *  - **Reorgs.** It stays `confirmations` blocks behind the head, and it remembers the
 *    hash of the last block it indexed. If that hash no longer matches the chain, a
 *    reorg happened: it rewinds well past the divergence and re-indexes. Because every
 *    write is an upsert keyed on log identity, re-indexing is a no-op where nothing
 *    changed.
 *  - **Restarts.** Progress lives in `indexer_state`, and each batch commits in one
 *    transaction together with its cursor update. A crash mid-batch rolls the whole
 *    batch back, so the next boot repeats it rather than skipping it.
 *  - **Backfill.** Startup is just catch-up from `startBlock`; there is no separate
 *    backfill path to drift out of sync with the live one.
 */
export class Indexer {
  private client: PublicClient;
  private stopped = false;
  private lastBlock = 0n;
  private headBlock = 0n;
  private lastError?: string;
  private caughtUp = false;
  private genesisHash: string | null = null;

  constructor(
    private readonly cfg: IndexerConfig,
    private readonly chain: Chain,
    private readonly db: Db
  ) {
    this.client = createPublicClient({
      chain,
      transport: fallback(
        cfg.rpcUrls.map((u) => nodeHttp(u, {timeoutMs: 20_000})),
        {rank: false}
      ),
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Records one price observation.
   *
   * Timestamped with *chain* time rather than wall clock, so the series lines up with
   * round boundaries even on a devnet whose clock is offset from the host's. Failures are
   * swallowed: a missing sample costs a gap in a chart, and must never stall indexing.
   */
  private async samplePrice(): Promise<void> {
    try {
      const [spotResult, twapResult, block] = await Promise.all([
        this.client.readContract({
          address: this.cfg.oracle,
          abi: UniswapV3PonsOracleAbi,
          functionName: "getSpotPrice",
        }) as Promise<readonly [bigint, number]>,
        this.client
          .readContract({address: this.cfg.oracle, abi: UniswapV3PonsOracleAbi, functionName: "getPrice"})
          .catch(() => null) as Promise<readonly [bigint, bigint] | null>,
        this.client.getBlock(),
      ]);

      await this.db.query(
        `INSERT INTO price_samples (chain_id, ts, spot, twap, tick) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (chain_id, ts) DO UPDATE SET spot=EXCLUDED.spot, twap=EXCLUDED.twap, tick=EXCLUDED.tick`,
        [
          this.cfg.chainId,
          Number(block.timestamp).toString(),
          spotResult[0].toString(),
          twapResult ? twapResult[0].toString() : null,
          spotResult[1],
        ]
      );
    } catch (err) {
      log.debug("price sample skipped", {err});
    }
  }

  /**
   * Hash of the block this market was deployed in, which identifies the chain *instance*.
   *
   * Genesis is the obvious choice and the wrong one: a development chain generates a
   * deterministic genesis block, so a devnet torn down and recreated has an identical
   * genesis hash. The deployment block does not — it contains this deployment's own
   * transactions — so it distinguishes "same chain, later" from "a different chain that
   * happens to reuse the addresses", which is exactly the case that silently blends two
   * histories together.
   */
  private async currentAnchorHash(): Promise<string | null> {
    try {
      const block = await this.client.getBlock({blockNumber: this.cfg.startBlock});
      return block.hash ?? null;
    } catch (err) {
      // Not fatal: a node that will not serve that block costs us the check, not the index.
      log.warn("could not read the deployment block; chain-identity check skipped", {err});
      return null;
    }
  }

  private get stateId(): string {
    return `${this.cfg.chainId}:${this.cfg.prediction.toLowerCase()}`;
  }

  async start(): Promise<void> {
    // The read model is per-market, but most tables are keyed by chain id alone. If this
    // database already holds another market's rows for this chain, mixing them would
    // silently blend two histories -- and on a local devnet with repeated redeployments
    // that is exactly what happens. Refuse rather than corrupt, and require an explicit
    // opt-in to wipe, because deleting somebody's indexed history should never be a
    // silent side effect of a config change.
    const existing = await this.db.query<{prediction: string}>(
      `SELECT prediction FROM markets WHERE chain_id = $1`,
      [this.cfg.chainId]
    );
    const previous = existing.rows[0]?.prediction;
    if (previous && previous !== this.cfg.prediction.toLowerCase()) {
      if (process.env.INDEXER_RESET !== "true") {
        throw new Error(
          `database holds market ${previous} for chain ${this.cfg.chainId}, but this indexer is configured ` +
            `for ${this.cfg.prediction.toLowerCase()}. Point at a different database, or set INDEXER_RESET=true ` +
            `to discard the existing read model for this chain.`
        );
      }
      log.warn("market changed for this chain; discarding the existing read model", {
        previous,
        next: this.cfg.prediction.toLowerCase(),
      });
      await this.wipeChain();
    }

    await this.registerMarket();

    // A chain id is not an identity: a devnet recreated from scratch keeps its id and,
    // with deterministic deployment, its addresses -- while every block underneath
    // differs. Cursor position cannot see that, because the new chain simply grows past
    // the old cursor and the indexer appends to a history that never happened.
    const genesisHash = await this.currentAnchorHash();
    const row = await this.db.query<{last_block: string; genesis_hash: string | null}>(
      `SELECT last_block, genesis_hash FROM indexer_state WHERE id=$1`,
      [this.stateId]
    );
    const stored = row.rows[0];
    if (stored && genesisHash && stored.genesis_hash && stored.genesis_hash !== genesisHash) {
      log.warn("chain instance changed; discarding this chain's read model", {
        storedAnchor: stored.genesis_hash,
        currentAnchor: genesisHash,
        anchorBlock: this.cfg.startBlock.toString(),
      });
      await this.wipeChain();
      await this.registerMarket();
      this.lastBlock = this.cfg.startBlock - 1n;
    } else {
      this.lastBlock = stored ? BigInt(stored.last_block) : this.cfg.startBlock - 1n;
    }
    this.genesisHash = genesisHash;
    log.info("indexer started", {
      chainId: this.cfg.chainId,
      prediction: this.cfg.prediction,
      resumeFrom: (this.lastBlock + 1n).toString(),
    });

    while (!this.stopped) {
      try {
        await this.tick();
        this.lastError = undefined;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        log.error("indexer tick failed", {err});
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  private async tick(): Promise<void> {
    this.headBlock = await this.client.getBlockNumber();

    // Cursor ahead of the chain head. This happens when the chain has been rewound past
    // anything a normal reorg check would catch, or when the database was pointed at a
    // different instance of the same chain (a fresh local devnet reusing deterministic
    // addresses does exactly this). Without handling it the indexer would wait forever
    // for a head that is never coming back, reporting a nonsensical negative lag.
    if (this.lastBlock > this.headBlock) {
      // The chain has been rewound past our cursor, or replaced outright by a new
      // instance reusing the same addresses. Either way every derived row describes a
      // history that no longer exists, so the whole read model for this chain goes --
      // not just the event-derived tables. Rolling back only those would leave ghost
      // rounds from the old chain that no replay ever overwrites.
      log.warn("stored cursor is ahead of the chain head; discarding this chain's read model", {
        cursor: this.lastBlock.toString(),
        head: this.headBlock.toString(),
      });
      await this.wipeChain();
      await this.registerMarket();
      this.lastBlock = this.cfg.startBlock - 1n;
    }

    const safeHead = this.headBlock > this.cfg.confirmations ? this.headBlock - this.cfg.confirmations : 0n;
    if (safeHead <= this.lastBlock) {
      this.caughtUp = true;
      return;
    }

    await this.checkForReorg();

    const from = this.lastBlock + 1n;
    const to = from + this.cfg.batchSize - 1n > safeHead ? safeHead : from + this.cfg.batchSize - 1n;
    await this.indexRange(from, to);
    this.caughtUp = this.lastBlock >= safeHead;

    // Only sample once caught up. While backfilling, every sample would carry the same
    // "now" price against a historical block and would draw a flat line across history
    // that never happened.
    if (this.caughtUp) await this.samplePrice();
  }

  /**
   * Detects a reorg by re-reading the block we last indexed and comparing hashes.
   * Cheap (one call per tick) and decisive.
   */
  private async checkForReorg(): Promise<void> {
    const row = await this.db.query<{last_block: string; last_block_hash: string | null}>(
      `SELECT last_block, last_block_hash FROM indexer_state WHERE id=$1`,
      [this.stateId]
    );
    const state = row.rows[0];
    if (!state?.last_block_hash) return;

    const height = BigInt(state.last_block);
    try {
      const block = await this.client.getBlock({blockNumber: height});
      if (block.hash === state.last_block_hash) return;

      // Rewind further than the reorg is likely to reach: re-indexing costs little
      // because every write is idempotent, whereas rewinding too little leaves a
      // stale row behind for good.
      const rewindTo = height > this.cfg.confirmations * 4n ? height - this.cfg.confirmations * 4n : 0n;
      log.warn("reorg detected; rewinding", {
        at: height.toString(),
        expected: state.last_block_hash,
        found: block.hash,
        rewindTo: rewindTo.toString(),
      });
      await rollbackFrom(this.db, this.cfg.chainId, rewindTo);
      this.lastBlock = rewindTo - 1n;
      await this.db.query(`UPDATE indexer_state SET last_block=$2, last_block_hash=NULL WHERE id=$1`, [
        this.stateId,
        (rewindTo - 1n).toString(),
      ]);
    } catch (err) {
      log.warn("could not verify last indexed block", {err});
    }
  }

  private async indexRange(from: bigint, to: bigint): Promise<void> {
    // The burner is a separate deployment, so its buyback events come from a second
    // address. Both are fetched in one request; parsing is non-strict, so a log from one
    // contract that does not match the other's ABI is simply not decoded.
    const hasBurner = this.cfg.burner !== "0x0000000000000000000000000000000000000000";
    const addresses = hasBurner ? [this.cfg.prediction, this.cfg.burner] : [this.cfg.prediction];
    const raw = await this.client.getLogs({address: addresses, fromBlock: from, toBlock: to});
    // Includes the v1 fragments: an event's topic is hashed from its name, so a market
    // deployed before the fee rename emits TreasuryClaim, not BurnSwept, and parsing with
    // the v2 ABI alone would drop it without complaint.
    const parsed = parseEventLogs({
      abi: [...MarketAbiWithLegacy, ...PonsBuybackBurnerAbi],
      logs: raw,
      strict: false,
    });

    // Block timestamps are fetched once per block rather than per log; a busy block can
    // carry a dozen logs and a chain this fast makes per-log fetches expensive.
    const blockTimes = new Map<bigint, Date>();
    for (const l of parsed) {
      if (l.blockNumber !== null && !blockTimes.has(l.blockNumber)) {
        const b = await this.client.getBlock({blockNumber: l.blockNumber});
        blockTimes.set(l.blockNumber, new Date(Number(b.timestamp) * 1000));
      }
    }

    const senders = new Map<string, string>();
    for (const l of parsed) {
      if (!l.transactionHash || senders.has(l.transactionHash)) continue;
      try {
        const tx = await this.client.getTransaction({hash: l.transactionHash});
        senders.set(l.transactionHash, tx.from);
      } catch {
        senders.set(l.transactionHash, "");
      }
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      for (const l of parsed) {
        const decoded: DecodedLog = {
          name: l.eventName,
          args: (l.args ?? {}) as Record<string, unknown>,
          blockNumber: l.blockNumber ?? 0n,
          blockHash: l.blockHash ?? "",
          transactionHash: l.transactionHash ?? "",
          logIndex: l.logIndex ?? 0,
          blockTime: l.blockNumber !== null ? blockTimes.get(l.blockNumber) : undefined,
          sender: senders.get(l.transactionHash ?? ""),
        };
        await applyLog(client, this.cfg.chainId, decoded);
      }

      // The cursor moves in the same transaction as the rows it accounts for, so a
      // crash can never leave the cursor ahead of the data.
      const tip = await this.client.getBlock({blockNumber: to});
      await client.query(
        `INSERT INTO indexer_state (id, chain_id, contract, last_block, last_block_hash, genesis_hash, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (id) DO UPDATE SET last_block=EXCLUDED.last_block,
           last_block_hash=EXCLUDED.last_block_hash,
           genesis_hash=COALESCE(EXCLUDED.genesis_hash, indexer_state.genesis_hash),
           updated_at=now()`,
        [this.stateId, this.cfg.chainId, this.cfg.prediction.toLowerCase(), to.toString(), tip.hash,
         this.genesisHash]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    this.lastBlock = to;
    if (parsed.length > 0) {
      log.info("indexed range", {from: from.toString(), to: to.toString(), logs: parsed.length});
    }
  }

  private async registerMarket(): Promise<void> {
    await this.db.query(
      `INSERT INTO markets (chain_id, prediction, oracle, pons, weth, pool, deployed_block)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (chain_id) DO UPDATE SET
         prediction=EXCLUDED.prediction, oracle=EXCLUDED.oracle, pons=EXCLUDED.pons,
         weth=EXCLUDED.weth, pool=EXCLUDED.pool, deployed_block=EXCLUDED.deployed_block,
         updated_at=now()`,
      [this.cfg.chainId, this.cfg.prediction.toLowerCase(), this.cfg.oracle.toLowerCase(),
       this.cfg.pons.toLowerCase(), this.cfg.weth.toLowerCase(), this.cfg.pool.toLowerCase(),
       this.cfg.startBlock.toString()]
    );
  }

  /** Drops every derived row for this chain. */
  private async wipeChain(): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      for (const table of [
        "events", "bets", "claims", "keeper_executions", "burn_events", "burns",
        "oracle_observations", "rounds", "users",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE chain_id = $1`, [this.cfg.chainId]);
      }
      await client.query(`DELETE FROM indexer_state WHERE chain_id = $1`, [this.cfg.chainId]);
      await client.query(`DELETE FROM markets WHERE chain_id = $1`, [this.cfg.chainId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  status() {
    return {
      lastIndexedBlock: this.lastBlock.toString(),
      headBlock: this.headBlock.toString(),
      lagBlocks: (this.headBlock - this.lastBlock).toString(),
      caughtUp: this.caughtUp,
      lastError: this.lastError,
    };
  }
}

export function startHealthServer(port: number, indexer: Indexer) {
  const server = createServer((_req, res) => {
    const s = indexer.status();
    // A large lag is the failure mode that matters: the API would still answer, just
    // with stale data, which is worse than answering "not ready". A *negative* lag means
    // the cursor is ahead of the head, which is also not ready.
    const lag = Number(s.lagBlocks);
    const ready = !s.lastError && lag >= 0 && lag < 50_000;
    res.writeHead(ready ? 200 : 503, {"content-type": "application/json"});
    res.end(JSON.stringify({ready, ...s}, null, 2));
  });
  server.listen(port, () => log.info("indexer health listening", {port}));
  return server;
}

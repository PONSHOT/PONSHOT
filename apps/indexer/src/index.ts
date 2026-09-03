import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {robinhood, robinhoodTestnet} from "@pons/config";
import {defineChain} from "viem";
import {loadConfig} from "./config.js";
import {createDb, migrate} from "./db.js";
import {Indexer, startHealthServer} from "./indexer.js";
import {log} from "./logger.js";

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl);

const ran = await migrate(db, join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
if (ran.length) log.info("migrations applied", {migrations: ran});

const chain =
  cfg.chainId === robinhood.id
    ? robinhood
    : cfg.chainId === robinhoodTestnet.id
      ? robinhoodTestnet
      : defineChain({
          id: cfg.chainId,
          name: `chain-${cfg.chainId}`,
          nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
          rpcUrls: {default: {http: cfg.rpcUrls}},
        });

const indexer = new Indexer(cfg, chain, db);
const server = startHealthServer(cfg.healthPort, indexer);

const shutdown = async (signal: string) => {
  log.info("shutting down", {signal});
  indexer.stop();
  server.close();
  await db.end().catch(() => {});
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await indexer.start();
} catch (err) {
  // A configuration refusal (wrong market for this database, unreachable deployment
  // file) cannot be fixed by restarting, so exit with EX_CONFIG and let the supervisor
  // stop rather than crash-loop on a deliberate "no".
  log.error("indexer stopped", {err});
  await db.end().catch(() => {});
  process.exit(78);
}

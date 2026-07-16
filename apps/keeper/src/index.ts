import {robinhood, robinhoodTestnet} from "@pons/config";
import {createWalletClient, defineChain} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {loadConfig} from "./config.js";
import {startHealthServer} from "./health.js";
import {Keeper} from "./keeper.js";
import {createLock} from "./lock.js";
import {log} from "./logger.js";
import {RpcPool} from "./rpc.js";
import {StateStore} from "./state.js";
import {TxSender} from "./tx.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

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

  const rpc = new RpcPool(cfg.rpcUrls);
  await rpc.probe(chain);
  const publicClient = rpc.client(chain);

  const account = privateKeyToAccount(cfg.privateKey);
  const wallet = createWalletClient({account, chain, transport: rpc.transport});

  const state = new StateStore(cfg.statePath);
  state.load();

  const sender = new TxSender(publicClient, wallet, account, chain, state, {
    confirmations: cfg.confirmations,
    timeoutMs: cfg.txTimeoutMs,
    bumpPercent: cfg.replacementBumpPercent,
    maxAttempts: cfg.maxAttempts,
    minBalanceWei: cfg.minBalanceWei,
    dryRun: cfg.dryRun,
  });

  const lock = createLock(cfg.redisUrl, cfg.lockKey, cfg.lockTtlMs);
  const keeper = new Keeper(cfg, chain, rpc, publicClient, wallet, account, state, lock, sender);
  const server = startHealthServer(cfg.healthPort, keeper, rpc, state);

  // Shut down cleanly so the lock is released rather than left to expire, which would
  // otherwise stall a replacement replica for a whole TTL.
  const shutdown = (signal: string) => {
    log.info("shutting down", {signal});
    keeper.stop();
    server.close();
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error("unhandled rejection", {err}));

  await keeper.run();
}

main().catch((err) => {
  log.error("keeper failed to start", {err});
  process.exit(1);
});

import {createServer} from "node:http";
import type {Server} from "node:http";
import type {Keeper} from "./keeper.js";
import {log} from "./logger.js";
import type {RpcPool} from "./rpc.js";
import type {StateStore} from "./state.js";

/**
 * Health endpoint.
 *
 * `/health` is shallow and cheap so an orchestrator can hammer it. `/ready` is the one
 * that actually judges: it reports unhealthy when the keeper has stopped making
 * progress, when every RPC is down, or when the operator has run out of gas — the three
 * conditions where rounds will start going unresolved.
 */
export function startHealthServer(port: number, keeper: Keeper, rpc: RpcPool, state: StateStore): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (code: number, body: unknown) => {
      res.writeHead(code, {"content-type": "application/json"});
      res.end(JSON.stringify(body, null, 2));
    };

    if (url.startsWith("/health")) {
      send(200, {ok: true, uptimeSeconds: Math.round(process.uptime())});
      return;
    }

    if (url.startsWith("/ready")) {
      const status = keeper.getStatus();
      const s = state.get();
      const lastTick = status.lastTickAt ? Date.parse(status.lastTickAt) : 0;
      const stale = lastTick === 0 || Date.now() - lastTick > 120_000;
      const brokeGas = BigInt(status.operatorBalanceWei || "0") === 0n;
      const ready = status.running && !stale && rpc.anyHealthy && !brokeGas;
      send(ready ? 200 : 503, {
        ready,
        reasons: {stale, noHealthyRpc: !rpc.anyHealthy, operatorOutOfGas: brokeGas, running: status.running},
        status,
        rpc: rpc.snapshot(),
        totals: s.totals,
        lastExecutionAt: s.lastExecutionAt,
      });
      return;
    }

    if (url.startsWith("/metrics")) {
      const status = keeper.getStatus();
      const s = state.get();
      const lines = [
        `pons_keeper_up ${status.running ? 1 : 0}`,
        `pons_keeper_consecutive_failures ${status.consecutiveFailures}`,
        `pons_keeper_current_epoch ${status.currentEpoch}`,
        `pons_keeper_operator_balance_wei ${status.operatorBalanceWei}`,
        `pons_keeper_tx_sent_total ${s.totals.sent}`,
        `pons_keeper_tx_confirmed_total ${s.totals.confirmed}`,
        `pons_keeper_tx_failed_total ${s.totals.failed}`,
        `pons_keeper_tx_replaced_total ${s.totals.replaced}`,
        `pons_keeper_rounds_awaiting_lock ${status.pending.lockable.length}`,
        `pons_keeper_rounds_awaiting_settle ${status.pending.settleable.length}`,
        `pons_keeper_rounds_cancellable ${status.pending.cancellable.length}`,
      ];
      res.writeHead(200, {"content-type": "text/plain; version=0.0.4"});
      res.end(`${lines.join("\n")}\n`);
      return;
    }

    send(404, {error: "not found"});
  });

  server.listen(port, () => log.info("health endpoint listening", {port}));
  return server;
}

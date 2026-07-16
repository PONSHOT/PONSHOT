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
      const balance = BigInt(status.operatorBalanceWei || "0");

      // The floor, not zero. The keeper refuses to send below `minBalanceWei`, so a
      // balance above zero but under the floor is already a stopped keeper. Reporting
      // ready in that window is exactly how rounds sat unsettled for twenty minutes
      // while every check said the service was fine.
      const belowFloor = balance < keeper.minBalanceWei;
      const fuel = runway(s, balance);
      const ready = status.running && !stale && rpc.anyHealthy && !belowFloor;
      send(ready ? 200 : 503, {
        ready,
        reasons: {
          stale,
          noHealthyRpc: !rpc.anyHealthy,
          operatorBelowFloor: belowFloor,
          running: status.running,
        },
        gas: {
          balanceWei: balance.toString(),
          floorWei: keeper.minBalanceWei.toString(),
          averageCostPerTxWei: fuel.averageCostWei.toString(),
          estimatedTxsRemaining: fuel.txsRemaining,
        },
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
        `pons_keeper_operator_balance_floor_wei ${keeper.minBalanceWei}`,
        `pons_keeper_gas_spent_wei_total ${s.gasSpentWei ?? "0"}`,
        // Alert on this rather than on the balance: wei means nothing without the cost
        // per transaction, and that cost changes with the round interval and gas price.
        `pons_keeper_estimated_txs_remaining ${runway(s, BigInt(status.operatorBalanceWei || "0")).txsRemaining}`,
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

/**
 * How many more transactions the operator can afford.
 *
 * Measured from what has actually been paid rather than from a configured estimate: gas
 * price moves, and a stale constant is worse than no number because it looks authoritative.
 * Falls back to the measured launch figure (0.000262 ETH per round) until enough
 * transactions have confirmed to average over.
 */
const MEASURED_COST_WEI = 262_000_000_000_000n;

function runway(
  s: {gasSpentWei?: string; totals: {confirmed: number; failed: number}},
  balance: bigint
): {averageCostWei: bigint; txsRemaining: number} {
  const paid = BigInt(s.gasSpentWei ?? "0");
  const count = BigInt(s.totals.confirmed + s.totals.failed);
  const averageCostWei = count > 0n && paid > 0n ? paid / count : MEASURED_COST_WEI;
  return {averageCostWei, txsRemaining: Number(balance / averageCostWei)};
}

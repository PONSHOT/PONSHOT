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
          // What a send requires (gas allowance x fee cap) — this is what limits sending.
          reservePerTxWei: fuel.reserveWei.toString(),
          // What a send has typically cost. Interesting, but not what runs the keeper out.
          averagePaidPerTxWei: fuel.averageCostWei.toString(),
          txsRemaining: fuel.txsRemaining,
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
        `pons_keeper_reserve_per_tx_wei ${runway(s, 0n).reserveWei}`,
        // Alert on this rather than on the balance: wei means nothing without the reserve
        // a send requires, and that moves with gas price and the round's gas use.
        `pons_keeper_txs_remaining ${runway(s, BigInt(status.operatorBalanceWei || "0")).txsRemaining}`,
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
 * How many more transactions the operator can actually send.
 *
 * Sized by what a send *requires*, not by what one typically costs, and those are not
 * close. A transaction is rejected outright unless the balance covers its full gas
 * allowance at the fee cap; measured on this chain that reserve reached 0.00081 ETH
 * while the average amount actually paid was 0.0000043 — a factor of about 190, because
 * most transactions use a fraction of their limit and are refunded the rest.
 *
 * Dividing a balance by the average is therefore not a conservative estimate, it is a
 * wrong one: at 0.000113 ETH this reported "26 transactions remaining" for a keeper that
 * could not send a single one. Both numbers are exposed, but the count uses the reserve.
 */
const FALLBACK_RESERVE_WEI = 1_000_000_000_000_000n; // 0.001 ETH, above the observed worst case

function runway(
  s: {gasSpentWei?: string; maxTxCostWei?: string; totals: {confirmed: number; failed: number}},
  balance: bigint
): {averageCostWei: bigint; reserveWei: bigint; txsRemaining: number} {
  const paid = BigInt(s.gasSpentWei ?? "0");
  const count = BigInt(s.totals.confirmed + s.totals.failed);
  const averageCostWei = count > 0n && paid > 0n ? paid / count : 0n;
  const observedMax = BigInt(s.maxTxCostWei ?? "0");
  const reserveWei = observedMax > 0n ? observedMax : FALLBACK_RESERVE_WEI;
  return {averageCostWei, reserveWei, txsRemaining: Number(balance / reserveWei)};
}

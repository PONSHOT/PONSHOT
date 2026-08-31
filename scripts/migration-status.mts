#!/usr/bin/env -S npx tsx
/**
 * Is the old market safe to retire?
 *
 * A retired market keeps owing its users forever — claims are pull-based and nothing
 * expires — so "safe to retire" does not mean "safe to forget". It means: no round can
 * still change state, and whatever is still owed is known rather than assumed.
 *
 * Prints the four numbers that decide it and exits non-zero if any round is still open.
 *
 *   npx tsx scripts/migration-status.mts 0xOldMarket [rpcUrl]
 */
import {PonsPredictionAbi} from "@pons/sdk";
import {createPublicClient, formatEther, http} from "viem";
import type {Address} from "viem";

const [, , marketArg, rpcArg] = process.argv;
if (!marketArg) {
  console.error("usage: migration-status.mts <marketAddress> [rpcUrl]");
  process.exit(2);
}
const market = marketArg as Address;
const rpc = rpcArg ?? process.env.ROBINHOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({transport: http(rpc, {timeout: 20_000})});

const read = (functionName: string, args: readonly unknown[] = []) =>
  client.readContract({address: market, abi: PonsPredictionAbi, functionName: functionName as never, args: args as never});

const [currentEpoch, liabilities, paused, balance] = await Promise.all([
  read("currentEpoch") as Promise<bigint>,
  read("totalLiabilities") as Promise<bigint>,
  read("paused") as Promise<boolean>,
  client.getBalance({address: market}),
]);

// Statuses: 0 Pending, 1 Open, 2 Locked, 3 Settled, 4 Cancelled.
const TERMINAL = new Set([3, 4]);
const unresolved: bigint[] = [];
const from = currentEpoch > 8n ? currentEpoch - 8n : 1n;
for (let e = from; e <= currentEpoch; e++) {
  const r = (await read("getRound", [e])) as {status: number};
  if (!TERMINAL.has(Number(r.status))) unresolved.push(e);
}

console.log(`market            ${market}`);
console.log(`rpc               ${rpc}`);
console.log(`paused            ${paused}`);
console.log(`currentEpoch      ${currentEpoch}`);
console.log(`balance           ${formatEther(balance)} ETH`);
console.log(`owed to users     ${formatEther(liabilities)} ETH   (totalLiabilities)`);
console.log(`unresolved rounds ${unresolved.length === 0 ? "none" : unresolved.join(", ")}`);

if (unresolved.length > 0) {
  console.error("\nNOT READY: rounds can still change state. Settle or cancel them before cutting over.");
  process.exit(1);
}
if (liabilities > 0n) {
  console.log(
    "\nREADY, with a caveat: users are still owed " +
      `${formatEther(liabilities)} ETH. That is fine — the contract will pay them whenever they claim — but the ` +
      "new UI must keep a claim path to this address (NEXT_PUBLIC_LEGACY_PREDICTION_ADDRESS)."
  );
} else {
  console.log("\nREADY: no round can change state and nothing is owed to users.");
}

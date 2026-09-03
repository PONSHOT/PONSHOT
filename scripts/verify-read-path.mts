/**
 * Exercises the exact chain-read path the Positions page uses.
 *
 * Written after that page rendered blank on mainnet while the user's money sat in the
 * contract: viem refuses `multicall` unless the chain definition declares Multicall3, and
 * the failure surfaced as an empty table rather than an error. An HTTP 200 on the page
 * proves nothing about this, so it gets its own check.
 *
 *   npx tsx scripts/verify-read-path.mts <wallet> [chainId]
 */
import {createPublicClient, http} from "viem";
import {robinhood, robinhoodTestnet} from "@pons/config";
import {PonsPredictionAbi} from "@pons/sdk";
import {readFileSync} from "node:fs";

const wallet = (process.argv[2] ?? "") as `0x${string}`;
const chainId = Number(process.argv[3] ?? 4663);
if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
  console.error("usage: verify-read-path.mts <wallet> [chainId]");
  process.exit(1);
}

const chain = chainId === robinhoodTestnet.id ? robinhoodTestnet : robinhood;
const deployment = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), "utf8"));
const market = deployment.PonsPrediction as `0x${string}`;

const client = createPublicClient({chain, transport: http()});

const multicall3 = chain.contracts?.multicall3?.address;
console.log(`  chain ${chain.id}  market ${market}`);
console.log(`  multicall3 declared: ${multicall3 ?? "NO — batched reads will fail"}`);
if (!multicall3) process.exitCode = 1;

const [, total] = (await client.readContract({
  address: market, abi: PonsPredictionAbi, functionName: "getUserEpochs", args: [wallet, 0n, 1n],
})) as unknown as [bigint[], bigint];

const [epochs] = (await client.readContract({
  address: market, abi: PonsPredictionAbi, functionName: "getUserEpochs", args: [wallet, 0n, 40n],
})) as unknown as [bigint[], bigint];
console.log(`  positions: ${total} -> epochs [${epochs.map(String).join(", ")}]`);

if (epochs.length === 0) {
  console.log("  no positions for this wallet; nothing further to check");
  process.exit(0);
}

const results = await client.multicall({
  allowFailure: false,
  contracts: epochs.flatMap((e) => [
    {address: market, abi: PonsPredictionAbi, functionName: "phaseOf", args: [e]},
    {address: market, abi: PonsPredictionAbi, functionName: "claimable", args: [e, wallet]},
    {address: market, abi: PonsPredictionAbi, functionName: "refundable", args: [e, wallet]},
  ]) as never,
});

const PHASE = ["Pending", "Open", "AwaitingLock", "Live", "AwaitingSettle", "Settled", "Cancelled", "Cancellable"];
console.log("  MULTICALL OK");
let owed = 0n;
epochs.forEach((e, i) => {
  const phase = Number(results[i * 3]);
  const claimable = results[i * 3 + 1] as unknown as bigint;
  const refundable = results[i * 3 + 2] as unknown as bigint;
  owed += claimable + refundable;
  console.log(
    `    round ${e}: ${PHASE[phase]}  claimable=${Number(claimable) / 1e18}  refundable=${Number(refundable) / 1e18}`
  );
});
console.log(`  total collectable: ${Number(owed) / 1e18} ETH`);

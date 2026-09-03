/**
 * Simulated trading for the local stack.
 *
 * The mock pool, like the real one, only records an observation when a swap moves the
 * tick — so without something trading, no instant is ever priceable and the keeper has
 * nothing it can do. This stands in for the market: it nudges the tick on a cadence and
 * advances the chain clock, which is what lets a 300-second round play out in seconds.
 */
import {readFileSync} from "node:fs";
import {PonsPredictionAbi} from "@pons/sdk";
import {createPublicClient, createWalletClient, defineChain, http, parseEther} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const TICK_STEP = Number(process.env.TICK_STEP ?? 40);
const WARP_SECONDS = Number(process.env.WARP_SECONDS ?? 20);
const INTERVAL_MS = Number(process.env.TRADE_INTERVAL_MS ?? 1000);

const d = JSON.parse(readFileSync(new URL(`../deployments/${CHAIN_ID}.json`, import.meta.url), "utf8"));
const POOL = d.PONSWETHPool as Address;
const POOL_B = d.PONSWETHPoolSecond as Address | undefined;
const MARKET = d.PonsPrediction as Address;

/**
 * Optional demo entries.
 *
 * Off unless DEMO_BETS=true. A market with empty pools renders correctly but looks dead,
 * so for a running demo a handful of Anvil accounts take positions on the open round.
 * These are Anvil's well-known development keys and are worthless anywhere real.
 */
const DEMO_BETS = process.env.DEMO_BETS === "true";
const DEMO_KEYS: Hex[] = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];

const chain = defineChain({
  id: CHAIN_ID,
  name: "local",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [RPC]}},
});
const pub = createPublicClient({chain, transport: http(RPC)});
const account = privateKeyToAccount(
  (process.env.TRADER_PRIVATE_KEY ??
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba") as Hex
);
const wallet = createWalletClient({account, chain, transport: http(RPC)});

const ABI = [
  {type: "function", name: "swapToTick", inputs: [{name: "newTick", type: "int24"}], outputs: [], stateMutability: "nonpayable"},
  {type: "function", name: "tick", inputs: [], outputs: [{type: "int24"}], stateMutability: "view"},
] as const;

let direction = 1;
let ticks = 0;

/**
 * Places one demo entry on whichever round is currently open.
 *
 * Every failure is swallowed on purpose: the round may have just locked, the wallet may
 * already be in it (one entry per wallet per round), or the pool cap may be reached. All
 * of those are the contract behaving correctly, not a fault worth logging loudly.
 */
async function maybeBet() {
  if (!DEMO_BETS) return;
  try {
    const epoch = (await pub.readContract({
      address: MARKET,
      abi: PonsPredictionAbi,
      functionName: "currentEpoch",
    })) as bigint;
    if (epoch === 0n) return;

    const key = DEMO_KEYS[Math.floor(Math.random() * DEMO_KEYS.length)]!;
    const bettor = createWalletClient({account: privateKeyToAccount(key), chain, transport: http(RPC)});
    const bull = Math.random() < 0.5;
    const amount = parseEther((0.01 + Math.random() * 0.08).toFixed(4));

    const hash = await bettor.writeContract({
      address: MARKET,
      abi: PonsPredictionAbi,
      functionName: bull ? "betBull" : "betBear",
      args: [epoch],
      account: bettor.account,
      chain,
      value: amount,
    });
    await pub.waitForTransactionReceipt({hash});
    console.log(`[trader] demo ${bull ? "UP" : "DOWN"} ${amount} wei on round ${epoch}`);
  } catch (err) {
    // Expected outcomes (round locked, wallet already in, cap reached) are not faults, so
    // this never escalates -- but it is logged, because a silent catch that hides a real
    // misconfiguration is how a "working" demo shows empty pools forever.
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(`[trader] demo entry skipped: ${reason}`);
  }
}

/**
 * Collects anything the demo wallets are owed.
 *
 * Without this the leaderboard's realised profit stays negative forever: stakes leave the
 * wallet immediately, winnings only arrive on claim, and nobody claims. Real users do.
 */
async function maybeClaim() {
  if (!DEMO_BETS) return;
  try {
    const key = DEMO_KEYS[Math.floor(Math.random() * DEMO_KEYS.length)]!;
    const account = privateKeyToAccount(key);
    const [epochs] = (await pub.readContract({
      address: MARKET,
      abi: PonsPredictionAbi,
      functionName: "getUserEpochs",
      args: [account.address, 0n, 40n],
    })) as unknown as [bigint[], bigint];

    const owed: bigint[] = [];
    for (const e of epochs.slice(-15)) {
      const [c, r] = (await Promise.all([
        pub.readContract({address: MARKET, abi: PonsPredictionAbi, functionName: "claimable", args: [e, account.address]}),
        pub.readContract({address: MARKET, abi: PonsPredictionAbi, functionName: "refundable", args: [e, account.address]}),
      ])) as [bigint, bigint];
      if (c > 0n || r > 0n) owed.push(e);
    }
    if (owed.length === 0) return;

    const claimer = createWalletClient({account, chain, transport: http(RPC)});
    const hash = await claimer.writeContract({
      address: MARKET,
      abi: PonsPredictionAbi,
      functionName: "claim",
      args: [owed],
      account,
      chain,
    });
    await pub.waitForTransactionReceipt({hash});
    console.log(`[trader] demo claimed ${owed.length} round(s)`);
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(`[trader] demo claim skipped: ${reason}`);
  }
}

async function step() {
  const current = (await pub.readContract({address: POOL, abi: ABI, functionName: "tick"})) as number;
  // A random walk with occasional reversals, so rounds do not all resolve the same way.
  if (Math.random() < 0.3) direction = -direction;
  const next = current + direction * Math.round(TICK_STEP * (0.5 + Math.random()));

  const hash = await wallet.writeContract({address: POOL, abi: ABI, functionName: "swapToTick", args: [next], account, chain});
  await pub.waitForTransactionReceipt({hash});

  // Move the second pool with it. The market settles on a composite that requires the
  // pools to agree within 100bp, so driving only one would push them apart, trip the gate
  // and make every round refuse to price — the demo would look broken while the contract
  // was behaving exactly as designed. A few basis points of jitter keeps it honest
  // without approaching the gate.
  if (POOL_B) {
    const jitter = Math.round((Math.random() - 0.5) * 12);
    const hashB = await wallet.writeContract({
      address: POOL_B, abi: ABI, functionName: "swapToTick", args: [next + jitter], account, chain,
    });
    await pub.waitForTransactionReceipt({hash: hashB});
  }

  // WARP_SECONDS=0 means "let the chain keep its own clock", which is what a long-running
  // site wants: Anvil is started with --block-time, so time already advances on its own
  // and warping on top of it would run the chain far ahead of wall-clock.
  if (WARP_SECONDS > 0) {
    await pub.request({method: "evm_increaseTime" as never, params: [WARP_SECONDS] as never});
    await pub.request({method: "evm_mine" as never, params: [] as never});
  }

  // Roughly one entry every few ticks, so pools build up without saturating the cap.
  if (Math.random() < 0.35) await maybeBet();
  if (Math.random() < 0.2) await maybeClaim();

  if (++ticks % 5 === 0) {
    const block = await pub.getBlock();
    console.log(`[trader] tick ${current} -> ${next}, chain time ${block.timestamp}`);
  }
}

console.log(`[trader] driving pool ${POOL}: ${TICK_STEP} ticks and +${WARP_SECONDS}s every ${INTERVAL_MS}ms`);
setInterval(() => {
  step().catch((err) => console.error("[trader] step failed", err));
}, INTERVAL_MS);

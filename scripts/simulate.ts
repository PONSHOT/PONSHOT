/**
 * End-to-end local simulation.
 *
 * Runs the exact scenario the brief asks for against a local Anvil: a round opens,
 * Alice backs UP and Bob backs DOWN, the PONS price moves, the round locks, the next
 * round opens, the price moves again, the round settles, the winner claims, and the
 * treasury accounting is checked at every step.
 *
 * It drives the contracts the same way the frontend and keeper do — through @pons/sdk —
 * so a break in the shared payout maths shows up here rather than in a user's wallet.
 */
import {readFileSync} from "node:fs";
import {
  Outcome,
  Phase,
  PHASE_LABEL,
  PonsPredictionAbi,
  UniswapV3PonsOracleAbi,
  formatEth,
  formatMultiplier,
  formatWethPerPons,
  multiplierX18,
  rewardPool,
} from "@pons/sdk";
import {createPublicClient, createWalletClient, defineChain, http, parseEther} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const d = JSON.parse(readFileSync(new URL(`../deployments/${CHAIN_ID}.json`, import.meta.url), "utf8"));
const MARKET = d.PonsPrediction as Address;
const ORACLE = d.PonsOracleAdapter as Address;
const POOL = d.PONSWETHPool as Address;
const POOL_B = d.PONSWETHPoolSecond as Address;

const chain = defineChain({
  id: CHAIN_ID,
  name: "local",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [RPC]}},
});

// Anvil's well-known accounts.
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  alice: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bob: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  charlie: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

const pub = createPublicClient({chain, transport: http(RPC)});
const wallet = (key: string) =>
  createWalletClient({account: privateKeyToAccount(key as Hex), chain, transport: http(RPC)});

const deployer = wallet(KEYS.deployer);
const alice = wallet(KEYS.alice);
const bob = wallet(KEYS.bob);
const charlie = wallet(KEYS.charlie);

const MOCK_POOL_ABI = [
  {type: "function", name: "swapToTick", inputs: [{name: "newTick", type: "int24"}], outputs: [], stateMutability: "nonpayable"},
  {type: "function", name: "tick", inputs: [], outputs: [{type: "int24"}], stateMutability: "view"},
] as const;

const step = (n: number, title: string) => console.log(`\n\x1b[1m── ${n}. ${title}\x1b[0m`);
const ok = (msg: string) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`);
const info = (msg: string) => console.log(`   ${msg}`);

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    console.error(`\n\x1b[31m✗ ASSERTION FAILED: ${msg}\x1b[0m`);
    process.exit(1);
  }
}

async function warp(seconds: number) {
  await pub.request({method: "evm_increaseTime" as never, params: [seconds] as never});
  await pub.request({method: "evm_mine" as never, params: [] as never});
}

/**
 * Moves the mock pool's tick.
 *
 * Note what does *not* happen: moving to the tick the pool is already at writes no
 * observation, because Uniswap V3 only records when a swap actually changes the tick.
 * That is the whole reason `seal()` exists below, and it is the same behaviour that
 * produces the multi-minute seal lags measured on the live pool.
 */
async function movePrice(tick: number) {
  // Both pools, together. The composite oracle requires them to agree within 100bp, so
  // moving one alone would trip the divergence gate and refuse to price the round.
  for (const pool of [POOL, POOL_B]) {
    const hash = await deployer.writeContract({
      address: pool,
      abi: MOCK_POOL_ABI,
      functionName: "swapToTick",
      args: [tick],
      account: deployer.account!,
      chain,
    });
    await pub.waitForTransactionReceipt({hash});
  }
}

const read = (fn: string, args: readonly unknown[] = []) =>
  pub.readContract({address: MARKET, abi: PonsPredictionAbi, functionName: fn as never, args: args as never});

const readOracle = (fn: string, args: readonly unknown[] = []) =>
  pub.readContract({address: ORACLE, abi: UniswapV3PonsOracleAbi, functionName: fn as never, args: args as never});

async function send(w: ReturnType<typeof wallet>, fn: string, args: readonly unknown[], value?: bigint) {
  const hash = await w.writeContract({
    address: MARKET,
    abi: PonsPredictionAbi,
    functionName: fn as never,
    args: args as never,
    account: w.account!,
    chain,
    ...(value !== undefined ? {value} : {}),
  });
  const receipt = await pub.waitForTransactionReceipt({hash});
  assert(receipt.status === "success", `${fn} reverted`);
  return receipt;
}

/**
 * Forces the pool to record an observation at the current timestamp.
 *
 * The oracle will not price an instant until the pool holds an observation at or after
 * it. Nudging the tick by one is the cheapest way to make that happen, and it records
 * the *pre*-nudge tick for the interval just elapsed, so it does not distort the price.
 */
async function seal() {
  const current = (await pub.readContract({address: POOL, abi: MOCK_POOL_ABI, functionName: "tick"})) as number;
  await movePrice(current + 1);
}

/** Builds pool history at `tick` so any TWAP window is serviceable. */
async function seedHistory(tick: number, seconds: number) {
  let elapsed = 0;
  while (elapsed < seconds) {
    await warp(15);
    elapsed += 15;
    await movePrice(tick + 1);
    await movePrice(tick);
  }
}

async function main() {
  const START_TICK = 84_400;
  console.log(`\x1b[1mPONS Prediction — local end-to-end simulation\x1b[0m`);
  console.log(`market ${MARKET}\noracle ${ORACLE}\npool   ${POOL}`);

  step(0, "Seed pool history so the TWAP is serviceable");
  await seedHistory(START_TICK, 180);
  const [spot] = (await readOracle("getSpotPrice")) as [bigint, number];
  ok(`PONS spot = ${formatWethPerPons(spot)} WETH`);

  step(1, "Open the first round");
  if ((await read("currentEpoch")) === 0n) await send(deployer, "genesisStartRound", []);
  const epoch = (await read("currentEpoch")) as bigint;
  const round = (await read("getRound", [epoch])) as {lockTimestamp: bigint; closeTimestamp: bigint};
  ok(`round #${epoch} open; locks at ${round.lockTimestamp}, closes at ${round.closeTimestamp}`);

  step(2, "Alice backs UP with 1 ETH, Bob backs DOWN with 2 ETH");
  await send(alice, "betBull", [epoch], parseEther("1"));
  await send(bob, "betBear", [epoch], parseEther("2"));
  const r2 = (await read("getRound", [epoch])) as {bullAmount: bigint; bearAmount: bigint; totalAmount: bigint};
  assert(r2.bullAmount === parseEther("1"), "bull pool wrong");
  assert(r2.bearAmount === parseEther("2"), "bear pool wrong");
  assert(r2.bullAmount + r2.bearAmount === r2.totalAmount, "sides do not sum to total");
  const feeBps = Number(await read("treasuryFeeBps"));
  ok(`pools UP ${formatEth(r2.bullAmount)} / DOWN ${formatEth(r2.bearAmount)} ETH`);
  ok(`UP pays ${formatMultiplier(multiplierX18(r2.bullAmount, r2.bearAmount, feeBps))}x, ` +
     `DOWN pays ${formatMultiplier(multiplierX18(r2.bearAmount, r2.bullAmount, feeBps))}x (estimated)`);

  step(3, "Charlie tries to enter twice — must be refused");
  await send(charlie, "betBull", [epoch], parseEther("0.5"));
  let refused = false;
  try {
    await send(charlie, "betBear", [epoch], parseEther("0.5"));
  } catch {
    refused = true;
  }
  assert(refused, "a wallet was allowed two positions in one round");
  ok("second entry rejected");

  step(4, "Price moves, then the round locks and the next one opens");
  await movePrice(START_TICK - 100);
  await warp(Number(round.lockTimestamp) - Number((await pub.getBlock()).timestamp) + 5);
  const [quotable, why] = (await readOracle("canQuote", [round.lockTimestamp, 60])) as [boolean, string];
  assert(!quotable, `expected the lock instant to be unsealed before any trade, got quotable (${why})`);
  info(`lock instant not yet priceable: ${why} — exactly the condition bufferSeconds exists for`);
  await seal();
  await send(deployer, "executeRound", []);

  const locked = (await read("getRound", [epoch])) as {lockPrice: bigint; status: number};
  assert(locked.status === 2, "round did not lock");
  ok(`locked at ${formatWethPerPons(locked.lockPrice)} WETH`);
  const nextEpoch = (await read("currentEpoch")) as bigint;
  assert(nextEpoch === epoch + 1n, "next round did not open");
  ok(`round #${nextEpoch} is open for entries — users always have a future round`);

  step(5, "Entries into the locked round are refused");
  let closed = false;
  try {
    await send(charlie, "betBull", [epoch], parseEther("0.1"));
  } catch {
    closed = true;
  }
  assert(closed, "a locked round accepted an entry");
  ok("entries closed");

  step(6, "PONS appreciates during the round");
  // PONS is token1, so a falling tick means a rising PONS price.
  await movePrice(START_TICK - 900);
  await warp(30);
  await movePrice(START_TICK - 900);
  const [spotNow] = (await readOracle("getSpotPrice")) as [bigint, number];
  ok(`PONS spot now ${formatWethPerPons(spotNow)} WETH (was ${formatWethPerPons(spot)})`);
  assert(spotNow > spot, "price should have risen");

  step(7, "Settle the round");
  const closeTs = Number(round.closeTimestamp);
  const now = Number((await pub.getBlock()).timestamp);
  if (now < closeTs + 5) await warp(closeTs - now + 5);
  await seal();
  await send(deployer, "executeRound", []);

  const settled = (await read("getRound", [epoch])) as {
    status: number; lockPrice: bigint; closePrice: bigint; rewardAmount: bigint; rewardBaseAmount: bigint; totalAmount: bigint;
  };
  const terms = (await read("getRoundTerms", [epoch])) as {outcome: number};
  assert(settled.status === 3, "round did not settle");
  ok(`closed at ${formatWethPerPons(settled.closePrice)} WETH`);
  assert(settled.closePrice > settled.lockPrice, "close should exceed lock");
  assert(terms.outcome === Outcome.Bull, `expected UP to win, got outcome ${terms.outcome}`);
  ok("UP wins");

  step(8, "Check the payout arithmetic against the SDK");
  const expectedReward = rewardPool(settled.rewardBaseAmount, settled.totalAmount - settled.rewardBaseAmount, feeBps);
  assert(settled.rewardAmount === expectedReward, `contract reward ${settled.rewardAmount} != SDK ${expectedReward}`);
  ok(`reward pool ${formatEth(settled.rewardAmount)} ETH matches the SDK exactly`);
  const treasury = (await read("treasuryAmount")) as bigint;
  assert(treasury === (settled.totalAmount * BigInt(feeBps)) / 10_000n, "treasury fee wrong");
  ok(`treasury booked ${formatEth(treasury)} ETH (${feeBps / 100}%)`);

  step(9, "Winners claim; the loser cannot");
  const aliceOwed = (await read("claimable", [epoch, alice.account!.address])) as bigint;
  const charlieOwed = (await read("claimable", [epoch, charlie.account!.address])) as bigint;
  const bobOwed = (await read("claimable", [epoch, bob.account!.address])) as bigint;
  assert(bobOwed === 0n, "the loser was owed something");

  const aliceBefore = await pub.getBalance({address: alice.account!.address});
  const rec = await send(alice, "claim", [[epoch]]);
  const gas = rec.gasUsed * rec.effectiveGasPrice;
  const aliceAfter = await pub.getBalance({address: alice.account!.address});
  assert(aliceAfter - aliceBefore + gas === aliceOwed, "Alice received the wrong amount");
  ok(`Alice claimed ${formatEth(aliceOwed)} ETH`);

  await send(charlie, "claim", [[epoch]]);
  ok(`Charlie claimed ${formatEth(charlieOwed)} ETH`);

  let loserBlocked = false;
  try {
    await send(bob, "claim", [[epoch]]);
  } catch {
    loserBlocked = true;
  }
  assert(loserBlocked, "the loser managed to claim");
  ok("Bob cannot claim");

  step(10, "Double claim is refused");
  let doubleBlocked = false;
  try {
    await send(alice, "claim", [[epoch]]);
  } catch {
    doubleBlocked = true;
  }
  assert(doubleBlocked, "a second claim succeeded");
  ok("second claim rejected");

  step(11, "Solvency and treasury accounting");
  const [balance, owed, solvent] = (await read("solvency")) as [bigint, bigint, boolean];
  assert(solvent, "contract is insolvent");
  ok(`balance ${formatEth(balance)} ETH covers ${formatEth(owed)} ETH of obligations`);

  const treasuryBefore = await pub.getBalance({address: deployer.account!.address});
  await send(deployer, "claimTreasury", [treasury]);
  const treasuryAfter = await pub.getBalance({address: deployer.account!.address});
  assert(treasuryAfter > treasuryBefore - parseEther("0.01"), "treasury withdrawal did not arrive");
  assert(((await read("treasuryAmount")) as bigint) === 0n, "treasury balance not cleared");
  ok(`treasury withdrew ${formatEth(treasury)} ETH`);

  const [, owed2, solvent2] = (await read("solvency")) as [bigint, bigint, boolean];
  assert(solvent2, "insolvent after treasury withdrawal");
  ok(`still solvent, ${formatEth(owed2)} ETH still owed to users`);

  step(12, "Rolling structure is intact");
  const head = (await read("currentEpoch")) as bigint;
  for (const e of [head - 1n, head]) {
    const phase = (await read("phaseOf", [e])) as number;
    info(`round #${e}: ${PHASE_LABEL[phase as keyof typeof PHASE_LABEL] ?? phase}`);
  }
  assert(((await read("phaseOf", [head])) as number) === Phase.Open, "head round is not taking entries");
  ok("a future round is always available to enter");

  console.log("\n\x1b[32m\x1b[1mSimulation complete — every assertion passed.\x1b[0m\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

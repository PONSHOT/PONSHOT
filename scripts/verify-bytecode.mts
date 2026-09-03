#!/usr/bin/env -S npx tsx
/**
 * Does the source in this repository compile to the code that is actually deployed?
 *
 * This is the claim contract verification exists to support, and it can be checked
 * without an explorer: compile locally, read the runtime code from the chain, compare.
 * A byte-for-byte match means the deployed contract is this source and nothing else.
 *
 * It exists because Blockscout's verification API sits behind Cloudflare, which
 * challenges non-browser clients — `forge verify-contract` cannot get through from a
 * server. Explorer verification is still worth doing for the people who will never run
 * this, but it is a presentation of the fact, not the fact itself.
 *
 * The build settings must match the deployment exactly: solc 0.8.24, optimizer on at
 * 1000 runs, bytecode_hash "none", cbor_metadata false. Those are pinned in foundry.toml
 * and must not be adjusted to make a comparison pass — that would only be verifying
 * different bytecode.
 *
 *   npx tsx scripts/verify-bytecode.mts PonsPrediction 0xC463...dBD0 [rpcUrl]
 *
 * To check a *released* version, build that tag in a worktree and point this at its
 * artifacts. `--out` exists because a worktree has no node_modules of its own, so the
 * script has to run from here and read from there:
 *
 *   git worktree add /tmp/v1 v1.0.0
 *   cp -r packages/contracts/lib /tmp/v1/packages/contracts/
 *   (cd /tmp/v1/packages/contracts && forge build)
 *   npx tsx scripts/verify-bytecode.mts PonsPrediction 0xC463...dBD0 \
 *     --out /tmp/v1/packages/contracts/out
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {postJsonRpc} from "@pons/sdk/node-rpc";

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const outDir = outIndex >= 0 ? argv[outIndex + 1] : null;
const positional = outIndex >= 0 ? [...argv.slice(0, outIndex), ...argv.slice(outIndex + 2)] : argv;
const [name, address, rpcArg] = positional;
if (!name || !address) {
  console.error("usage: verify-bytecode.mts <ContractName> <address> [rpcUrl]");
  process.exit(2);
}
const rpc = rpcArg ?? process.env.ROBINHOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";

const artifactPath = join(outDir ?? join(process.cwd(), "packages/contracts/out"), `${name}.sol`, `${name}.json`);
let local: string;
let immutableReferences: Record<string, {start: number; length: number}[]> = {};
try {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  local = artifact.deployedBytecode.object.toLowerCase();
  immutableReferences = artifact.deployedBytecode.immutableReferences ?? {};
} catch (err) {
  console.error(`no build artifact at ${artifactPath} — run \`forge build\` first`);
  console.error(err);
  process.exit(2);
}

const response = (await postJsonRpc(rpc, {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_getCode",
  params: [address, "latest"],
})) as {result?: string; error?: {message?: string}};

if (response.error) {
  console.error(`RPC error: ${response.error.message}`);
  process.exit(2);
}
const onchain = (response.result ?? "0x").toLowerCase();

const bytes = (hex: string) => Math.max(0, (hex.length - 2) / 2);
console.log(`contract   ${name}`);
console.log(`address    ${address}`);
console.log(`rpc        ${rpc}`);
console.log(`local      ${bytes(local)} bytes`);
console.log(`on chain   ${bytes(onchain)} bytes`);

if (onchain === "0x" || bytes(onchain) === 0) {
  console.error("\nFAIL: nothing deployed at that address on this chain.");
  process.exit(1);
}
if (local === onchain) {
  console.log("\nMATCH: the deployed contract is exactly what this source compiles to.");
  process.exit(0);
}

/**
 * Blank out `immutable` values before comparing.
 *
 * An immutable is written into the runtime code at construction, so a fresh compile has
 * zeros where the deployed copy has real addresses and numbers. Comparing raw bytes
 * therefore reports a mismatch for every contract with immutables even when the source
 * is identical — CompositePonsOracle has six of them across fourteen positions, 448
 * bytes, and a naive check called that a mismatch. The right question is whether the
 * *code* matches; the values are a separate check, done by reading the getters.
 */
function maskImmutables(hex: string): string {
  const chars = [...hex];
  for (const positions of Object.values(immutableReferences)) {
    for (const {start, length} of positions) {
      for (let i = 0; i < length * 2; i++) chars[2 + start * 2 + i] = "_";
    }
  }
  return chars.join("");
}

const slots = Object.keys(immutableReferences).length;
if (slots > 0 && maskImmutables(local) === maskImmutables(onchain)) {
  const spots = Object.values(immutableReferences).reduce((n, p) => n + p.length, 0);
  console.log(
    `\nMATCH: identical apart from ${slots} immutable value(s) at ${spots} position(s), ` +
      "which are written at construction and cannot match a fresh compile."
  );
  console.log("Check those values by reading the contract's getters, not its bytecode.");
  process.exit(0);
}

// Say *how* they differ. Equal length with scattered differences is usually a metadata
// hash; different lengths mean genuinely different code.
if (bytes(local) !== bytes(onchain)) {
  console.error("\nMISMATCH: different lengths — this is not the same contract.");
} else {
  const differing = [...local].filter((c, i) => c !== onchain[i]).length;
  console.error(`\nMISMATCH: same length, ${differing} differing nibbles.`);
  console.error("Same length usually means the same source built with different settings.");
}
console.error("Check the compiler version, optimizer runs and metadata settings against foundry.toml.");
console.error("If this is a released version, build from a worktree at that tag rather than main.");
process.exit(1);

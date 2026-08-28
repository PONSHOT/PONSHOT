import {PonsPredictionAbi} from "./abis/index.js";

/**
 * Reading a market whose contract may predate buyback-and-burn.
 *
 * The protocol fee was renamed when it stopped being revenue: `treasuryFeeBps` became
 * `burnFeeBps`, `treasuryAmount` became `burnAllocated`, `claimTreasury` became
 * `sweepToBurner`. The rename is right — a field called `treasury_fee` holding burn
 * allocations is how a report ends up saying something false — but the deployed market
 * is immutable, so until it is replaced the services are talking to a contract that only
 * has the old names.
 *
 * That is not hypothetical: the rename shipped, the API kept calling `burnFeeBps` against
 * the live v1 contract, and every read reverted. The whole interface went blank while the
 * contract itself was perfectly healthy.
 *
 * So reads that differ between versions go through here: try the current name, fall back
 * to the old one. It costs one extra call only on a legacy market, and it disappears on
 * its own once the migration happens.
 */

/**
 * The v1 fragments, which the generated ABI no longer carries.
 *
 * The events matter as much as the functions and are easier to forget: an event's topic
 * is hashed from its *name* and parameter types, so renaming `TreasuryClaim` to
 * `BurnSwept` produced a different topic entirely. A non-strict log parse then drops the
 * v1 log silently — no error, just a fee withdrawal that never appears in the database.
 */
export const LegacyMarketAbi = [
  {
    type: "event",
    name: "TreasuryClaim",
    inputs: [
      {name: "to", type: "address", indexed: true, internalType: "address"},
      {name: "amount", type: "uint256", indexed: false, internalType: "uint256"},
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TreasuryUpdated",
    inputs: [
      {name: "previous", type: "address", indexed: false, internalType: "address"},
      {name: "next", type: "address", indexed: false, internalType: "address"},
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "treasuryFeeBps",
    inputs: [],
    outputs: [{name: "", type: "uint32", internalType: "uint32"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "treasuryAmount",
    inputs: [],
    outputs: [{name: "", type: "uint256", internalType: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "treasury",
    inputs: [],
    outputs: [{name: "", type: "address", internalType: "address"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claimTreasury",
    inputs: [{name: "amount", type: "uint256", internalType: "uint256"}],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Both versions in one ABI.
 *
 * Safe to hand to a multicall: an entry for a function the deployed contract does not
 * have reverts on its own, and with `allowFailure` the rest of the batch still returns.
 */
export const MarketAbiWithLegacy = [...PonsPredictionAbi, ...LegacyMarketAbi] as const;

type Reader = (functionName: string) => Promise<unknown>;

/** Protocol fee in basis points, whichever version the contract is. */
export async function readFeeBps(read: Reader): Promise<number> {
  try {
    return Number((await read("burnFeeBps")) as bigint | number);
  } catch {
    return Number((await read("treasuryFeeBps")) as bigint | number);
  }
}

/** Fee booked and not yet swept (v2) or withdrawn (v1). */
export async function readFeeBooked(read: Reader): Promise<bigint> {
  try {
    return (await read("burnAllocated")) as bigint;
  } catch {
    return (await read("treasuryAmount")) as bigint;
  }
}

/** True when the market routes its fee to a buyback-and-burn contract. */
export async function hasBurnTokenomics(read: Reader): Promise<boolean> {
  try {
    await read("burner");
    return true;
  } catch {
    return false;
  }
}

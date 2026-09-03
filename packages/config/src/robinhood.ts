import {defineChain} from "viem";

/**
 * Robinhood Chain, as verified against the live network rather than taken from a
 * document. Every value below was read back from chain 4663 before being written
 * here; see `docs/PONS_MARKET.md` for the audit transcript.
 *
 * This file is the only place any of these values are allowed to appear. Apps import
 * from here; the Solidity mirror is `packages/contracts/src/PonsAddresses.sol`, and
 * `ConfigParity.t.sol` fails if the two ever disagree.
 */
export const ROBINHOOD_CHAIN_ID = 4663 as const;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630 as const;

/** Measured over 20,000 blocks: ~102.5ms. Roughly ten blocks share each timestamp. */
export const BLOCK_TIME_MS = 102.5;

export const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {
    default: {http: ["https://rpc.mainnet.chain.robinhood.com"]},
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
      apiUrl: "https://robinhoodchain.blockscout.com/api",
    },
  },
  contracts: {
    // Multicall3 is deployed at its canonical address here, verified by calling
    // `getChainId()` on it. Declaring it is not optional decoration: viem refuses
    // `multicall` with ChainDoesNotSupportContract when this is absent, so leaving it
    // empty silently broke every batched read — the Positions page rendered blank while
    // the data sat on chain the whole time.
    multicall3: {address: "0xcA11bde05977b3631167028862bE2a173976CA11"},
  },
});

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET_CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.testnet.chain.robinhood.com"]}},
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
      apiUrl: "https://explorer.testnet.chain.robinhood.com/api",
    },
  },
  testnet: true,
});

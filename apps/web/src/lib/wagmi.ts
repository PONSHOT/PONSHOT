"use client";

import {ROBINHOOD_CHAIN_ID, robinhood, robinhoodTestnet} from "@pons/config";
import {createConfig, http} from "wagmi";
import {injected, walletConnect} from "wagmi/connectors";
import {defineChain} from "viem";
import type {Chain} from "viem";

/**
 * Wallet configuration.
 *
 * Robinhood Chain is not in any wallet's built-in list, so it is defined here and
 * offered to the wallet via `wallet_addEthereumChain` when the user is on the wrong
 * network. WalletConnect is only registered when a project id is present — registering
 * it without one produces a connector that fails at click time, which reads to the user
 * as a broken app.
 */
const localChain = defineChain({
  id: 31337,
  name: "Local Anvil",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["http://127.0.0.1:8545"]}},
});

const configuredChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? ROBINHOOD_CHAIN_ID);

export const activeChain: Chain =
  configuredChainId === robinhood.id
    ? robinhood
    : configuredChainId === robinhoodTestnet.id
      ? robinhoodTestnet
      : localChain;

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

const connectors = [
  // Covers MetaMask, Trust Wallet's in-app browser, Rabby, the Coinbase Wallet
  // extension and every other injected EIP-1193 provider, without a per-wallet
  // connector each.
  //
  // wagmi's dedicated `coinbaseWallet` connector is deliberately not used: it now pulls
  // in Coinbase's Base Account SDK, which carries unmet optional dependencies and fails
  // the production build. The extension connects through `injected()` regardless, and
  // Coinbase Wallet mobile connects over WalletConnect below, so nothing is lost.
  injected({shimDisconnect: true}),
  ...(projectId ? [walletConnect({projectId, showQrModal: true, metadata: {
    name: "Tickwise",
    description: "Round-based PONS/WETH prediction on Robinhood Chain",
    url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    icons: [],
  }})] : []),
];

/**
 * Resolves the RPC endpoint.
 *
 * A relative value (the `/rpc` proxy) is turned into an absolute URL against the page's
 * own origin, so the app reaches the chain from whatever host it is served on. On the
 * server there is no origin to resolve against, so a relative value falls back to the
 * local node — which is where the proxy would have sent it anyway.
 */
function resolveRpcUrl(): string {
  const configured = process.env.NEXT_PUBLIC_RPC_URL ?? activeChain.rpcUrls.default.http[0]!;
  if (!configured.startsWith("/")) return configured;
  return typeof window === "undefined" ? "http://127.0.0.1:8545" : `${window.location.origin}${configured}`;
}

export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors,
  transports: {[activeChain.id]: http(resolveRpcUrl())},
  ssr: true,
});

export const explorerTxUrl = (hash: string): string | null => {
  const base = activeChain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : null;
};

export const explorerAddressUrl = (address: string): string | null => {
  const base = activeChain.blockExplorers?.default.url;
  return base ? `${base}/address/${address}` : null;
};

export const hasWalletConnect = Boolean(projectId);

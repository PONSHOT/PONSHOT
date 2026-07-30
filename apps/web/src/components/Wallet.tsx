"use client";

import {formatEth} from "@pons/sdk";
import {useEffect, useState} from "react";
import {useAccount, useBalance, useChainId, useConnect, useDisconnect, useSwitchChain} from "wagmi";
import {activeChain, explorerAddressUrl} from "@/lib/wagmi";
import {getDeployment} from "@/lib/deployment";
import {erc20Abi} from "viem";
import {useReadContract} from "wagmi";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Wallet connection.
 *
 * Handles the states that actually go wrong in the wild: no injected provider, a user
 * who rejects the request, and — the common one for a chain no wallet ships with — being
 * connected to the wrong network. Wrong-network is treated as a blocking banner rather
 * than a silent mismatch, because every write would otherwise fail confusingly.
 */
export function WalletButton() {
  const {address, isConnected} = useAccount();
  const {connectors, connect, isPending, error} = useConnect();
  const {disconnect} = useDisconnect();
  const chainId = useChainId();
  const {switchChain, isPending: switching} = useSwitchChain();
  const {data: balance} = useBalance({address, query: {enabled: Boolean(address), refetchInterval: 10_000}});
  const [open, setOpen] = useState(false);

  const wrongNetwork = isConnected && chainId !== activeChain.id;

  if (!isConnected) {
    return (
      <div className="relative">
        <button className="btn-ghost" onClick={() => setOpen((v) => !v)} disabled={isPending}>
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
        {open && (
          <div className="card absolute right-0 z-30 mt-2 w-64 p-2">
            {connectors.length === 0 && (
              <p className="p-3 text-xs text-mute-500">
                No wallet detected. Install a browser wallet, or open this page inside your wallet&apos;s browser.
              </p>
            )}
            {connectors.map((c) => (
              <button
                key={c.uid}
                className="w-full rounded px-3 py-2 text-left text-sm hover:bg-base-800"
                onClick={() => {
                  connect({connector: c});
                  setOpen(false);
                }}
              >
                {c.name}
              </button>
            ))}
            {error && <p className="px-3 py-2 text-xs text-down-400">{error.message}</p>}
          </div>
        )}
      </div>
    );
  }

  if (wrongNetwork) {
    return (
      <button
        className="rounded-xl bg-down-500 px-4 py-2.5 text-sm font-bold text-white shadow-glow-down
                   transition-colors hover:bg-down-400 disabled:opacity-50"
        onClick={() => switchChain({chainId: activeChain.id})}
        disabled={switching}
      >
        {switching ? "Switching…" : `Switch to ${activeChain.name}`}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right sm:block">
        <div className="num text-sm text-white">{balance ? `${formatEth(balance.value, 4)} ETH` : "—"}</div>
        <PonsBalance />
      </div>
      <button className="btn-ghost" onClick={() => disconnect()} title="Disconnect">
        {address ? short(address) : ""}
      </button>
      {address && explorerAddressUrl(address) && (
        <a className="text-xs text-mute-500 hover:text-up-400" href={explorerAddressUrl(address)!} target="_blank" rel="noreferrer">
          ↗
        </a>
      )}
    </div>
  );
}

function PonsBalance() {
  const {address} = useAccount();
  const d = getDeployment();
  const {data} = useReadContract({
    address: d?.pons,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {enabled: Boolean(address && d?.pons && d.pons !== "0x"), refetchInterval: 30_000},
  });
  if (data === undefined) return null;
  return <div className="num text-[11px] text-mute-500">{formatEth(data as bigint, 2)} PONS</div>;
}

/** Full-width banner for the wrong-network case, so it cannot be missed. */
export function NetworkBanner() {
  const {isConnected} = useAccount();
  const chainId = useChainId();
  const {switchChain} = useSwitchChain();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !isConnected || chainId === activeChain.id) return null;

  return (
    <div className="border-b border-down-500/40 bg-down-500/15 px-4 py-2 text-center text-sm">
      You are connected to chain {chainId}. This market lives on {activeChain.name} ({activeChain.id}).{" "}
      <button className="underline hover:text-white" onClick={() => switchChain({chainId: activeChain.id})}>
        Switch network
      </button>
    </div>
  );
}

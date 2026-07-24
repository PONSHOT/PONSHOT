"use client";

import {formatEth} from "@pons/sdk";
import {formatEther, parseEther} from "viem";
import {useAccount, useBalance} from "wagmi";

const PRESETS = ["0.01", "0.05", "0.1", "0.25"] as const;

/**
 * Quick-stake row.
 *
 * The design's chips are fixed amounts; these are ETH because that is what the contract
 * takes. MAX withholds a small gas reserve — offering the entire balance guarantees a
 * failure at signing time, since the user still has to pay for the call.
 */
export function QuickBet({
  onPick, maximumBet, disabled,
}: {
  onPick: (amount: string) => void;
  maximumBet: bigint;
  disabled?: boolean;
}) {
  const {address, isConnected} = useAccount();
  const {data: balance} = useBalance({address, query: {enabled: Boolean(address), refetchInterval: 12_000}});

  const max = () => {
    if (!balance) return;
    const reserve = parseEther("0.002");
    let usable = balance.value > reserve ? balance.value - reserve : 0n;
    if (maximumBet > 0n && usable > maximumBet) usable = maximumBet;
    onPick(formatEther(usable));
  };

  return (
    <section className="card mt-4 flex flex-wrap items-center gap-2 px-4 py-3">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-up-400">⚡ Quick stake</span>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            className="chip disabled:opacity-40"
            disabled={disabled || (maximumBet > 0n && parseEther(p) > maximumBet)}
            onClick={() => onPick(p)}
          >
            {p} ETH
          </button>
        ))}
        <button className="chip disabled:opacity-40" disabled={disabled || !balance} onClick={max}>
          MAX
        </button>
      </div>

      <div className="ml-auto text-right">
        <div className="label">Your balance</div>
        <div className="num text-sm font-semibold text-white">
          {isConnected && balance ? `${formatEth(balance.value, 4)} ETH` : "—"}
        </div>
      </div>
    </section>
  );
}

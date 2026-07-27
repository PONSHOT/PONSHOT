"use client";

import {PonsPredictionAbi, estimatePayout, formatEth, formatMultiplier} from "@pons/sdk";
import type {Round} from "@pons/sdk";
import {useEffect, useMemo, useState} from "react";
import {formatEther, parseEther} from "viem";
import {useAccount, useBalance, useEstimateGas, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {useCountdown} from "@/hooks/useCountdown";
import {getDeployment} from "@/lib/deployment";
import {explorerTxUrl} from "@/lib/wagmi";

interface Props {
  open: boolean;
  bull: boolean;
  round: Round;
  feeBps: number;
  minimumBet: bigint;
  maximumBet: bigint;
  maximumRoundPool: bigint;
  presetAmount?: string;
  onClose: () => void;
}

const PRESETS = ["0.01", "0.05", "0.1", "0.25"] as const;

/**
 * Entry modal.
 *
 * The rule this screen is built around: **never tell the user something happened until
 * the chain says it did.** A transaction hash means "submitted", nothing more, so the
 * confirmed state waits for a receipt with `status === "success"`. A reverted transaction
 * is reported as a failure even though it has a hash and burned gas.
 */
export function PredictionModal({
  open, bull, round, feeBps, minimumBet, maximumBet, maximumRoundPool, presetAmount, onClose,
}: Props) {
  const d = getDeployment();
  const {address} = useAccount();
  const {data: balance} = useBalance({address, query: {enabled: Boolean(address)}});
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState(bull);
  const {text: countdown, expired} = useCountdown(round.lockTimestamp);

  const {writeContract, data: hash, isPending, error: writeError, reset} = useWriteContract();
  const {data: receipt, isLoading: confirming, error: receiptError} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (open) {
      setAmount(presetAmount ?? "");
      setSide(bull);
      reset();
    }
  }, [open, bull, presetAmount, reset]);

  const parsed = useMemo(() => {
    if (!amount.trim()) return null;
    try {
      const v = parseEther(amount as `${number}`);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount]);

  const sidePool = side ? round.bullAmount : round.bearAmount;
  const otherPool = side ? round.bearAmount : round.bullAmount;
  const estimate = parsed ? estimatePayout(parsed, sidePool, otherPool, feeBps) : null;

  const {data: gasEstimate} = useEstimateGas({
    to: d?.prediction,
    value: parsed ?? undefined,
    query: {enabled: Boolean(d && parsed && address)},
  });

  // Every reason the transaction would fail, checked before the wallet opens, so the user
  // is never asked to sign something that cannot succeed.
  const problem = useMemo(() => {
    if (!address) return "Connect a wallet to enter.";
    if (expired) return "Entries for this round have closed.";
    if (!parsed) return amount.trim() ? "Enter a valid amount." : null;
    if (parsed < minimumBet) return `Minimum stake is ${formatEth(minimumBet, 4)} ETH.`;
    if (maximumBet > 0n && parsed > maximumBet) return `Maximum stake is ${formatEth(maximumBet, 4)} ETH.`;
    if (maximumRoundPool > 0n && round.totalAmount + parsed > maximumRoundPool) {
      return `This round's pool is capped at ${formatEth(maximumRoundPool, 3)} ETH.`;
    }
    if (balance && parsed >= balance.value) return "Not enough ETH — leave room for gas.";
    return null;
  }, [address, expired, parsed, amount, minimumBet, maximumBet, maximumRoundPool, round.totalAmount, balance]);

  if (!open || !d) return null;

  const confirmed = receipt?.status === "success";
  const reverted = receipt?.status === "reverted";
  const stage = confirmed ? "confirmed" : reverted ? "reverted" : confirming ? "confirming"
    : hash ? "submitted" : isPending ? "wallet" : "input";

  const setMax = () => {
    if (!balance) return;
    const reserve = parseEther("0.002");
    let usable = balance.value > reserve ? balance.value - reserve : 0n;
    if (maximumBet > 0n && usable > maximumBet) usable = maximumBet;
    setAmount(formatEther(usable));
  };

  const submit = () => {
    if (!parsed || problem) return;
    writeContract({
      address: d.prediction,
      abi: PonsPredictionAbi,
      functionName: side ? "betBull" : "betBear",
      args: [round.epoch],
      value: parsed,
    });
  };

  const error = writeError ?? receiptError;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
         onClick={onClose}>
      <div className="card w-full max-w-md animate-rise-in rounded-b-none p-5 sm:rounded-2xl"
           onClick={(e) => e.stopPropagation()}>
        <header className="mb-4 flex items-start justify-between">
          <div>
            <div className="label">Round #{round.epoch.toString()}</div>
            <h2 className={`text-2xl font-extrabold ${side ? "text-up-400" : "text-down-400"}`}>
              PONS {side ? "UP ↗" : "DOWN ↓"}
            </h2>
            <p className="mt-0.5 text-[11px] text-mute-500">
              $PONS finishes {side ? "higher" : "lower"} than its locked price
            </p>
          </div>
          <button className="text-mute-500 transition-colors hover:text-white" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {stage === "input" || stage === "wallet" ? (
          <>
            {/* Side can be flipped here so a mis-tap does not mean closing and reopening. */}
            <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-base-850 p-1">
              <button
                onClick={() => setSide(true)}
                className={`rounded-lg py-2 text-sm font-bold transition-colors ${
                  side ? "bg-up-500 text-base-950" : "text-mute-400 hover:text-white"
                }`}
              >
                UP ↗
              </button>
              <button
                onClick={() => setSide(false)}
                className={`rounded-lg py-2 text-sm font-bold transition-colors ${
                  !side ? "bg-down-500 text-white" : "text-mute-400 hover:text-white"
                }`}
              >
                DOWN ↓
              </button>
            </div>

            <label className="label mb-1.5 block" htmlFor="stake">Stake</label>
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-base-600 bg-base-950 px-3 py-2.5
                            focus-within:border-up-500/70">
              <input
                id="stake"
                className="num w-full bg-transparent text-xl text-white outline-none placeholder:text-mute-600"
                inputMode="decimal"
                placeholder="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="text-sm font-semibold text-mute-500">ETH</span>
            </div>

            <div className="mb-4 grid grid-cols-5 gap-1.5">
              {PRESETS.map((p) => (
                <button key={p} className="chip text-center" onClick={() => setAmount(p)}>{p}</button>
              ))}
              <button className="chip text-center" onClick={setMax}>MAX</button>
            </div>

            <dl className="mb-4 space-y-1.5 rounded-xl bg-base-850/70 p-3 text-xs">
              <Line label="Wallet balance" value={balance ? `${formatEth(balance.value, 4)} ETH` : "—"} />
              <Line label="Round pool" value={`${formatEth(round.totalAmount, 3)} ETH`} />
              <Line label="UP / DOWN" value={`${formatEth(round.bullAmount, 3)} / ${formatEth(round.bearAmount, 3)} ETH`} />
              <Line label="Protocol fee" value={`${(feeBps / 100).toFixed(2)}% — bought back and burned`} />
              <Line label="Min / max stake"
                    value={`${formatEth(minimumBet, 3)} / ${maximumBet > 0n ? formatEth(maximumBet, 3) : "—"} ETH`} />
              <Line label="Gas estimate" value={gasEstimate ? `${gasEstimate.toString()} units` : "—"} />
              <Line label="Entries close in" value={countdown} accent />
            </dl>

            <div className={`mb-3 rounded-xl border p-3 ${side ? "border-up-500/30 bg-up-500/8" : "border-down-500/30 bg-down-500/8"}`}>
              <div className="flex items-baseline justify-between">
                <span className="label">Estimated payout</span>
                <span className={`num text-xl font-bold ${side ? "text-up-400" : "text-down-400"}`}>
                  {estimate ? `${formatEth(estimate.payout)} ETH` : "—"}
                </span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between text-[11px] text-mute-500">
                <span>at {estimate ? formatMultiplier(estimate.multiplierX18) : "—"}x</span>
                <span>estimate — others can still enter</span>
              </div>
            </div>

            <BurnRule feeBps={feeBps} />

            {problem && <p className="mb-3 text-xs text-down-400">{problem}</p>}
            {error && <p className="mb-3 break-words text-[11px] text-down-400">{shorten(error.message)}</p>}

            <button
              className={`${side ? "btn-up" : "btn-down"} w-full`}
              disabled={Boolean(problem) || !parsed || isPending}
              onClick={submit}
            >
              {isPending ? "Confirm in your wallet…" : `Confirm ${side ? "UP" : "DOWN"}`}
            </button>
          </>
        ) : (
          <TxProgress stage={stage} hash={hash} onClose={onClose} error={error?.message} />
        )}
      </div>
    </div>
  );
}

function TxProgress({
  stage, hash, onClose, error,
}: {
  stage: string; hash?: `0x${string}`; onClose: () => void; error?: string;
}) {
  const url = hash ? explorerTxUrl(hash) : null;
  const steps = [
    {key: "submitted", label: "Transaction submitted"},
    {key: "confirming", label: "Waiting for confirmation"},
    {key: "confirmed", label: "Prediction confirmed"},
  ];
  const reached = (key: string) =>
    stage === "confirmed" ? true : key === "submitted" || (key === "confirming" && stage === "confirming");

  return (
    <div className="py-2">
      {stage === "reverted" ? (
        <div className="rounded-xl border border-down-500/40 bg-down-500/10 p-4">
          <h3 className="font-bold text-down-400">Transaction reverted</h3>
          <p className="mt-1 text-xs leading-relaxed text-mute-300">
            It was mined but the contract rejected it, so no entry was placed and no stake was taken. Most often
            this means the round closed while the transaction was in flight.
          </p>
        </div>
      ) : (
        <ol className="space-y-3">
          {steps.map((s) => (
            <li key={s.key} className="flex items-center gap-3">
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] ${
                reached(s.key) ? "bg-up-500 text-base-950" : "border border-base-600 text-mute-600"
              }`}>
                {reached(s.key) ? "✓" : "·"}
              </span>
              <span className={`text-sm ${reached(s.key) ? "text-white" : "text-mute-500"}`}>{s.label}</span>
            </li>
          ))}
        </ol>
      )}

      {error && <p className="mt-3 break-words text-[11px] text-down-400">{shorten(error)}</p>}
      {url && (
        <a className="mt-4 block text-xs text-up-400 hover:underline" href={url} target="_blank" rel="noreferrer">
          View on explorer ↗
        </a>
      )}
      <button className="btn-ghost mt-4 w-full" onClick={onClose}>
        {stage === "confirmed" ? "Done" : "Close"}
      </button>
    </div>
  );
}

/**
 * States the two outcomes a user would otherwise have to infer, before they stake.
 *
 * The all-lost rule is the one that can surprise someone: it is the only case where a
 * bettor loses their whole stake to the protocol, and burying it in a docs page would be
 * a choice about who finds out and when.
 */
function BurnRule({feeBps}: {feeBps: number}) {
  const winners = (100 - feeBps / 100).toFixed(0);
  return (
    <div className="mb-3 rounded-xl border border-burn-500/25 bg-burn-500/5 p-3 text-[11px] leading-relaxed text-mute-400">
      <span className="font-semibold text-burn-400">How the pot is split.</span> Winners share{" "}
      <span className="num text-mute-200">{winners}%</span> of everything staked in the round. The other{" "}
      <span className="num text-mute-200">{(feeBps / 100).toFixed(0)}%</span> buys PONS and PONSHOT on the open market
      and burns them.
      <br />
      If <span className="text-mute-200">every</span> entry is on the losing side there is nobody to pay, so the whole
      pot is burned. If nobody takes the other side, nothing was won and every stake is returned in full.
    </div>
  );
}

function Line({label, value, accent}: {label: string; value: string; accent?: boolean}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-mute-500">{label}</dt>
      <dd className={`num ${accent ? "text-up-400" : "text-mute-200"}`}>{value}</dd>
    </div>
  );
}

/** Wallet errors are frequently a wall of text; keep the line a user can act on. */
function shorten(message: string): string {
  if (/user rejected|denied transaction/i.test(message)) return "You rejected the request in your wallet.";
  if (/insufficient funds/i.test(message)) return "Insufficient ETH for the stake plus gas.";
  const first = message.split("\n")[0] ?? message;
  return first.length > 180 ? `${first.slice(0, 180)}…` : first;
}

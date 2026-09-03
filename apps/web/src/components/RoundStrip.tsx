"use client";

import {PHASE_LABEL, Phase, changeBps, formatChangeBps} from "@pons/sdk";
import type {BetInfo, Round} from "@pons/sdk";
import {formatEth, formatWethPerPons} from "@/lib/format";
import {useCountdown} from "@/hooks/useCountdown";

/**
 * Compact previous / live summary beneath the entry panel.
 *
 * Keeps the rolling structure visible — a user should be able to see the round that just
 * resolved and the one running now without leaving the page.
 */
export function RoundStrip({
  previous, live, previousPhase, livePhase, liveBet, currentPrice,
}: {
  previous?: Round;
  live?: Round;
  previousPhase?: number;
  livePhase?: number;
  liveBet?: BetInfo;
  currentPrice?: bigint;
}) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <RoundMini title="Live" round={live} phase={livePhase} bet={liveBet} currentPrice={currentPrice} accent />
      <RoundMini title="Previous" round={previous} phase={previousPhase} />
    </div>
  );
}

function RoundMini({
  title, round, phase, bet, currentPrice, accent,
}: {
  title: string;
  round?: Round;
  phase?: number;
  bet?: BetInfo;
  currentPrice?: bigint;
  accent?: boolean;
}) {
  const {text: countdown} = useCountdown(round?.closeTimestamp);

  if (!round || round.epoch === 0n) {
    return (
      <div className="card flex h-32 items-center justify-center text-xs text-mute-600">
        No {title.toLowerCase()} round
      </div>
    );
  }

  const settled = round.status === 3;
  const compareTo = settled ? round.closePrice : currentPrice;
  const delta = round.lockPrice > 0n && compareTo ? changeBps(round.lockPrice, compareTo) : null;
  const rising = delta !== null && delta > 0n;

  return (
    <div className={`card p-3.5 ${accent ? "border-up-500/25" : ""}`}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">{title}</span>
        <span className="num text-xs text-mute-500">#{round.epoch.toString()}</span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="num text-sm text-white">
          {round.lockPrice > 0n ? formatWethPerPons(round.lockPrice, 5) : "—"}
        </span>
        <span className="text-[10px] text-mute-600">locked</span>
      </div>
      {delta !== null && (
        <div className={`num mt-0.5 text-xs font-semibold ${rising ? "text-up-400" : "text-down-400"}`}>
          {formatChangeBps(delta)} {settled ? "final" : "so far"}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[11px]">
        <span className="text-mute-500">
          {formatEth(round.bullAmount, 3)} / {formatEth(round.bearAmount, 3)} ETH
        </span>
        <StatusPill phase={phase} round={round} countdown={countdown} />
      </div>

      {bet && bet.amount > 0n && (
        <div className="mt-2 rounded-lg bg-base-850 px-2.5 py-1.5 text-[11px] text-mute-400">
          You: <span className={bet.position === 0 ? "text-up-400" : "text-down-400"}>
            {bet.position === 0 ? "UP" : "DOWN"}
          </span>{" "}
          <span className="num text-white">{formatEth(bet.amount)} ETH</span>
        </div>
      )}
    </div>
  );
}

function StatusPill({phase, round, countdown}: {phase?: number; round: Round; countdown: string}) {
  if (phase === Phase.Live) return <span className="num text-up-400">{countdown}</span>;
  if (phase === Phase.Settled) {
    const outcome = round.closePrice > round.lockPrice ? "UP" : round.closePrice < round.lockPrice ? "DOWN" : "TIE";
    const tone = outcome === "UP" ? "text-up-400" : outcome === "DOWN" ? "text-down-400" : "text-mute-400";
    // A settled round with no reward was a refund, not a win for either side.
    const label = round.rewardBaseAmount === 0n ? "REFUNDED" : `${outcome} WON`;
    return <span className={`font-semibold ${round.rewardBaseAmount === 0n ? "text-mute-400" : tone}`}>{label}</span>;
  }
  return <span className="text-mute-500">{PHASE_LABEL[(phase ?? 0) as 0] ?? ""}</span>;
}

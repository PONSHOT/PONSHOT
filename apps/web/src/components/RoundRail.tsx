"use client";

import {Outcome, Phase, changeBps, deriveOutcome, describeOutcome, formatChangeBps} from "@pons/sdk";
import type {BetInfo, Round} from "@pons/sdk";
import {useCountdown} from "@/hooks/useCountdown";
import {formatEth, formatWethPerPons, sharePercent} from "@/lib/format";

/**
 * Previous / Live / Next, side by side above the entry panel.
 *
 * Three rounds overlap by design — one resolving, one running, one taking entries — and
 * that structure is the product. Showing only the round you can bet on hides the thing
 * that makes a late keeper harmless: there is always a future round open, and the one
 * before it is already priced.
 *
 * Each card answers a different question, so they are deliberately not the same card with
 * different data: what happened, what is happening, what you can still join.
 */
export function RoundRail({
  previous, live, next, previousPhase, livePhase, nextPhase, previousBet, liveBet, nextBet, currentPrice,
}: {
  previous?: Round;
  live?: Round;
  next?: Round;
  previousPhase?: number;
  livePhase?: number;
  nextPhase?: number;
  previousBet?: BetInfo;
  liveBet?: BetInfo;
  nextBet?: BetInfo;
  currentPrice?: bigint;
}) {
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-3">
      <PreviousCard round={previous} phase={previousPhase} bet={previousBet} />
      <LiveCard round={live} phase={livePhase} bet={liveBet} currentPrice={currentPrice} />
      <NextCard round={next} phase={nextPhase} bet={nextBet} />
    </div>
  );
}

function Shell({
  kind, epoch, right, accent, children,
}: {
  kind: string;
  epoch?: bigint;
  right?: React.ReactNode;
  accent?: "live" | "next";
  children: React.ReactNode;
}) {
  const ring =
    accent === "next"
      ? "border-up-500/35 shadow-glow-up"
      : accent === "live"
        ? "border-base-600"
        : "border-base-800";
  return (
    <section className={`card border ${ring} p-4`}>
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="label">{kind}</span>
          {epoch !== undefined && epoch > 0n && (
            <span className="num text-xs text-mute-400">#{epoch.toString()}</span>
          )}
        </div>
        <div className="text-right text-[11px]">{right}</div>
      </header>
      {children}
    </section>
  );
}

function Empty({kind}: {kind: string}) {
  return (
    <Shell kind={kind}>
      <div className="flex h-24 items-center justify-center text-xs text-mute-600">Not available yet</div>
    </Shell>
  );
}

function Row({label, value, tone}: {label: string; value: React.ReactNode; tone?: string}) {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-[11px]">
      <span className="text-mute-500">{label}</span>
      <span className={`num ${tone ?? "text-mute-200"}`}>{value}</span>
    </div>
  );
}

/** What happened: the settled result, and what it meant for the user's entry. */
function PreviousCard({round, phase, bet}: {round?: Round; phase?: number; bet?: BetInfo}) {
  if (!round || round.epoch === 0n) return <Empty kind="Previous" />;

  const cancelled = phase === Phase.Cancelled;
  const outcome = cancelled ? null : deriveOutcome(round);
  const {label} = describeOutcome(cancelled ? "CANCELLED" : outcome);
  const bps = changeBps(round.lockPrice, round.closePrice);

  const tone =
    outcome === Outcome.Bull
      ? "text-up-400"
      : outcome === Outcome.Bear
        ? "text-down-400"
        : outcome === Outcome.AllLost
          ? "text-burn-400"
          : "text-mute-400";

  return (
    <Shell kind="Previous" epoch={round.epoch} right={<span className={tone}>{label}</span>}>
      <div className={`num text-2xl font-bold leading-none ${tone}`}>
        {round.closePrice > 0n ? formatChangeBps(bps) : "—"}
      </div>
      <div className="label mt-1 mb-2">Close vs lock</div>

      <Row label="Locked" value={`${formatWethPerPons(round.lockPrice, 5)}`} />
      <Row label="Closed" value={`${formatWethPerPons(round.closePrice, 5)}`} />
      <Row label="Pool" value={`${formatEth(round.totalAmount, 3)} ETH`} />
      {bet && bet.amount > 0n && (
        <Row
          label="Your entry"
          value={`${formatEth(bet.amount, 3)} ETH ${bet.position === 0 ? "UP" : "DOWN"}`}
          tone={bet.position === 0 ? "text-up-400" : "text-down-400"}
        />
      )}
    </Shell>
  );
}

/** What is happening: the running round, priced against its own lock. */
function LiveCard({
  round, phase, bet, currentPrice,
}: {
  round?: Round;
  phase?: number;
  bet?: BetInfo;
  currentPrice?: bigint;
}) {
  const {text, expired} = useCountdown(round?.closeTimestamp);
  if (!round || round.epoch === 0n) return <Empty kind="Live" />;

  const priced = round.lockPrice > 0n;
  const bps = priced && currentPrice !== undefined ? changeBps(round.lockPrice, currentPrice) : null;
  const up = (bps ?? 0) >= 0;
  const tone = bps === null ? "text-mute-400" : up ? "text-up-400" : "text-down-400";

  // "Awaiting" is not a failure state and should not read like one: the pool seals an
  // instant only when a swap moves the tick, so a quiet market delays the price without
  // putting anything at risk.
  const status = !priced
    ? <span className="text-mute-500">awaiting lock price</span>
    : expired
      ? <span className="text-mute-500">{phase === Phase.AwaitingSettle ? "awaiting close price" : "closing"}</span>
      : <span className="num text-mute-300">closes in {text}</span>;

  return (
    <Shell kind="Live" epoch={round.epoch} right={status} accent="live">
      <div className={`num text-2xl font-bold leading-none ${tone}`}>
        {bps === null ? "—" : formatChangeBps(bps)}
      </div>
      <div className="label mt-1 mb-2">Now vs lock</div>

      <Row label="Locked at" value={priced ? formatWethPerPons(round.lockPrice, 5) : "—"} />
      <Row label="Now" value={currentPrice !== undefined ? formatWethPerPons(currentPrice, 5) : "—"} />
      <Row label="Pool" value={`${formatEth(round.totalAmount, 3)} ETH`} />
      {bet && bet.amount > 0n ? (
        <Row
          label="Your entry"
          value={`${formatEth(bet.amount, 3)} ETH ${bet.position === 0 ? "UP" : "DOWN"}`}
          tone={bet.position === 0 ? "text-up-400" : "text-down-400"}
        />
      ) : (
        <Row label="Your entry" value="none" tone="text-mute-600" />
      )}
    </Shell>
  );
}

/** What you can still join: the round the panel below is for. */
function NextCard({round, phase, bet}: {round?: Round; phase?: number; bet?: BetInfo}) {
  const {text, expired} = useCountdown(round?.lockTimestamp);
  if (!round || round.epoch === 0n) return <Empty kind="Entering" />;

  const open = phase === Phase.Open;
  const bullPct = sharePercent(round.bullAmount, round.totalAmount);

  return (
    <Shell
      kind="Entering"
      epoch={round.epoch}
      accent="next"
      right={
        open && !expired ? (
          <span className="num text-up-400">closes in {text}</span>
        ) : (
          <span className="text-mute-500">entries closed</span>
        )
      }
    >
      <div className="num text-2xl font-bold leading-none text-white">{formatEth(round.totalAmount, 3)} ETH</div>
      <div className="label mt-1 mb-2">In the pool</div>

      <div className="mb-2 flex h-1.5 overflow-hidden rounded bg-base-700">
        <div className="bg-up-500" style={{width: `${bullPct}%`}} />
        <div className="bg-down-500" style={{width: `${100 - bullPct}%`}} />
      </div>
      <Row label="UP" value={`${formatEth(round.bullAmount, 3)} ETH`} tone="text-up-400" />
      <Row label="DOWN" value={`${formatEth(round.bearAmount, 3)} ETH`} tone="text-down-400" />
      {bet && bet.amount > 0n ? (
        <Row
          label="Your entry"
          value={`${formatEth(bet.amount, 3)} ETH ${bet.position === 0 ? "UP" : "DOWN"}`}
          tone={bet.position === 0 ? "text-up-400" : "text-down-400"}
        />
      ) : (
        <Row label="Your entry" value="none — enter below" tone="text-mute-600" />
      )}
    </Shell>
  );
}

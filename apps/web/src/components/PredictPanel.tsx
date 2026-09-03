"use client";

import {Phase, formatMultiplier, multiplierX18} from "@pons/sdk";
import type {BetInfo, Round} from "@pons/sdk";
import {formatEth, formatWethPerPons, sharePercent} from "@/lib/format";

interface Props {
  round: Round | undefined;
  phase: number | undefined;
  feeBps: number;
  currentPrice?: bigint;
  userBet?: BetInfo;
  disabled?: boolean;
  onPredict: (bull: boolean) => void;
}

/**
 * The central UP / DOWN panel.
 *
 * The two multipliers are estimates and are labelled as such wherever they appear: anyone
 * may still enter before the round locks, which changes every share. Only the contract
 * sets the final payout, and saying so plainly is the difference between a user feeling
 * informed and feeling cheated when the number moves.
 */
export function PredictPanel({round, phase, feeBps, currentPrice, userBet, disabled, onPredict}: Props) {
  if (!round || round.epoch === 0n) {
    return (
      <section className="card flex h-56 items-center justify-center">
        <span className="text-sm text-mute-500">No round open yet</span>
      </section>
    );
  }

  const bull = round.bullAmount;
  const bear = round.bearAmount;
  const total = round.totalAmount;
  const bullPct = sharePercent(bull, total);
  const bullMult = multiplierX18(bull, bear, feeBps);
  const bearMult = multiplierX18(bear, bull, feeBps);
  const alreadyIn = Boolean(userBet && userBet.amount > 0n);
  const open = phase === Phase.Open;

  return (
    <section className="card p-5">
      <header className="mb-5 text-center">
        <h2 className="text-lg font-bold text-white">
          Will $PONS finish <span className="text-up-400">UP</span> or{" "}
          <span className="text-down-400">DOWN</span>?
        </h2>
        <p className="mt-1 text-xs text-mute-500">
          Round #{round.epoch.toString()} ·{" "}
          {currentPrice !== undefined ? (
            <>Current price <span className="num text-mute-300">{formatWethPerPons(currentPrice, 5)} WETH</span></>
          ) : (
            "price loading"
          )}
        </p>
      </header>

      <div className="mx-auto grid max-w-4xl items-center gap-5 lg:grid-cols-[1fr_auto_1fr]">
        <SideCard
          side="up"
          pool={bull}
          multiplier={bullMult}
          userAmount={userBet && userBet.position === 0 ? userBet.amount : undefined}
          disabled={disabled || !open || alreadyIn}
          onClick={() => onPredict(true)}
        />

        <PoolDonut bullPct={bullPct} total={total} />

        <SideCard
          side="down"
          pool={bear}
          multiplier={bearMult}
          userAmount={userBet && userBet.position === 1 ? userBet.amount : undefined}
          disabled={disabled || !open || alreadyIn}
          onClick={() => onPredict(false)}
        />
      </div>

      {alreadyIn && (
        <p className="mt-4 rounded-xl border border-base-700 bg-base-850 px-4 py-2.5 text-center text-xs text-mute-400">
          You are in this round with{" "}
          <span className="num font-semibold text-white">{formatEth(userBet!.amount)} ETH</span> on{" "}
          <span className={userBet!.position === 0 ? "text-up-400" : "text-down-400"}>
            {userBet!.position === 0 ? "UP" : "DOWN"}
          </span>
          . One entry per wallet per round.
        </p>
      )}
      {!open && !alreadyIn && (
        <p className="mt-4 text-center text-xs text-mute-500">Entries are closed for this round.</p>
      )}
    </section>
  );
}

function SideCard({
  side, pool, multiplier, userAmount, disabled, onClick,
}: {
  side: "up" | "down";
  pool: bigint;
  multiplier: bigint | null;
  userAmount?: bigint;
  disabled?: boolean;
  onClick: () => void;
}) {
  const up = side === "up";
  const tone = up
    ? "border-up-500/35 bg-gradient-to-br from-up-500/12 to-transparent"
    : "border-down-500/35 bg-gradient-to-br from-down-500/12 to-transparent";

  return (
    <div className={`relative overflow-hidden rounded-2xl border p-4 ${tone}`}>
      <div className="mb-3 flex items-start justify-between">
        <span className={`text-lg font-extrabold ${up ? "text-up-400" : "text-down-400"}`}>
          {up ? "UP ↗" : "DOWN ↓"}
        </span>
        <div className="text-right">
          <div className="label">Total pool</div>
          <div className="num text-sm font-semibold text-white">{formatEth(pool)} ETH</div>
        </div>
      </div>

      <div className="mb-1 flex items-end justify-between">
        <div>
          <div className={`num text-[30px] font-bold leading-none ${up ? "text-up-400" : "text-down-400"}`}>
            {formatMultiplier(multiplier)}x
          </div>
          <div className="label mt-1">Est. payout</div>
        </div>
        {userAmount !== undefined && userAmount > 0n && (
          <div className="text-right">
            <div className="label">Your position</div>
            <div className="num text-sm font-semibold text-white">{formatEth(userAmount)} ETH</div>
          </div>
        )}
      </div>

      <button className={`${up ? "btn-up" : "btn-down"} mt-4 w-full`} disabled={disabled} onClick={onClick}>
        Predict {up ? "UP ⬆" : "DOWN ⬇"}
      </button>
    </div>
  );
}

/** Ring showing how the pool is split, with the total in the middle. */
function PoolDonut({bullPct, total}: {bullPct: number; total: bigint}) {
  const size = 176;
  const stroke = 15;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const bullLen = (bullPct / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{width: size, height: size}}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e33f4d" strokeWidth={stroke} />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#12c974" strokeWidth={stroke}
            strokeDasharray={`${bullLen} ${circumference - bullLen}`} strokeLinecap="butt"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="label">Total pool</span>
          <span className="num text-lg font-bold text-white">{formatEth(total, 3)}</span>
          <span className="text-[10px] text-mute-500">ETH</span>
        </div>
      </div>
      <div className="flex w-full justify-between px-1 text-[11px] font-semibold">
        <span className="text-up-400">{bullPct.toFixed(0)}%</span>
        <span className="text-down-400">{(100 - bullPct).toFixed(0)}%</span>
      </div>
    </div>
  );
}

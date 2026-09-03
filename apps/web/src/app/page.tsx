"use client";

import {Phase} from "@pons/sdk";
import type {BetInfo, Round} from "@pons/sdk";
import {useState} from "react";
import {ActivityTabs} from "@/components/ActivityTabs";
import {LogoLockup} from "@/components/Brand";
import {CandleChart} from "@/components/CandleChart";
import {PredictPanel} from "@/components/PredictPanel";
import {PredictionModal} from "@/components/PredictionModal";
import {QuickBet} from "@/components/QuickBet";
import {RoundStrip} from "@/components/RoundStrip";
import {TokenPanel} from "@/components/TokenPanel";
import type {ChartInterval} from "@/components/TokenPanel";
import {useMarketParams, usePonsPrice, useRoundPhase, useUserBet, useVisibleRounds} from "@/hooks/useMarket";
import {useCandles, useStats} from "@/lib/api";
import {getDeployment} from "@/lib/deployment";

export default function PredictPage() {
  const deployment = getDeployment();
  const {data: visible, isLoading} = useVisibleRounds();
  const {params} = useMarketParams();
  const {spot, twap, twapWindowSeconds} = usePonsPrice();
  const [interval, setInterval] = useState<ChartInterval>("1m");
  const {data: candleData, isLoading: candlesLoading} = useCandles(interval, 120);
  const {data: stats} = useStats();

  const [modal, setModal] = useState<{bull: boolean; preset?: string} | null>(null);

  const [previous, live, next] = (visible ?? []) as unknown as [Round, Round, Round];
  const nextPhase = useRoundPhase(next?.epoch);
  const livePhase = useRoundPhase(live?.epoch);
  const prevPhase = useRoundPhase(previous?.epoch);
  const nextBet = useUserBet(next?.epoch);
  const liveBet = useUserBet(live?.epoch);

  if (!deployment) {
    return (
      <div className="card p-10 text-center">
        <LogoLockup size={72} className="mb-6" />
        <h1 className="text-lg font-bold text-white">No market configured</h1>
        <p className="mt-2 text-sm text-mute-500">
          This build has no contract addresses. Set <code>NEXT_PUBLIC_CHAIN_ID</code>,{" "}
          <code>NEXT_PUBLIC_PREDICTION_ADDRESS</code> and <code>NEXT_PUBLIC_ORACLE_ADDRESS</code> from the
          deployment file for your network.
        </p>
      </div>
    );
  }

  return (
    <>
      {params.paused && (
        <div className="mb-4 rounded-xl border border-down-500/40 bg-down-500/10 px-4 py-3 text-sm">
          <strong className="text-down-400">New entries are paused.</strong>{" "}
          <span className="text-mute-400">Open rounds still settle, and claims and refunds remain available.</span>
        </div>
      )}

      <TokenPanel
        spot={spot}
        twap={twap}
        reference={live?.lockPrice}
        twapWindowSeconds={twapWindowSeconds}
        roundEndsAt={next?.lockTimestamp}
        epoch={next?.epoch}
        volume24h={stats ? BigInt(stats.total_volume) : undefined}
        interval={interval}
        onInterval={setInterval}
      />

      {/*
        Chart and entry panel stacked rather than side by side. A candlestick chart wants
        horizontal room -- squeezed into a column it shows a third of the candles and the
        wicks stop being readable -- and the UP / pool / DOWN row reads best spread across
        the full width, which is also how the design lays it out.
      */}
      <div className="mt-4">
        <CandleChart
          candles={candleData?.candles ?? []}
          interval={interval}
          lockPrice={live?.lockPrice}
          loading={candlesLoading}
          height={340}
        />
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="card flex h-56 items-center justify-center text-sm text-mute-500">Loading round…</div>
        ) : (
          <PredictPanel
            round={next}
            phase={nextPhase.data as number | undefined}
            feeBps={params.treasuryFeeBps}
            currentPrice={twap}
            userBet={nextBet.data as BetInfo | undefined}
            disabled={params.paused}
            onPredict={(bull) => setModal({bull})}
          />
        )}

        <QuickBet
          maximumBet={params.maximumBet}
          disabled={params.paused || (nextPhase.data as number) !== Phase.Open}
          onPick={(amount) => setModal({bull: true, preset: amount})}
        />
      </div>

      <RoundStrip
        previous={previous}
        live={live}
        previousPhase={prevPhase.data as number | undefined}
        livePhase={livePhase.data as number | undefined}
        liveBet={liveBet.data as BetInfo | undefined}
        currentPrice={twap}
      />

      <ActivityTabs bullAmount={next?.bullAmount} bearAmount={next?.bearAmount} />

      {modal && next && (
        <PredictionModal
          open
          bull={modal.bull}
          presetAmount={modal.preset}
          round={next}
          feeBps={params.treasuryFeeBps}
          minimumBet={params.minimumBet}
          maximumBet={params.maximumBet}
          maximumRoundPool={params.maximumRoundPool}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

"use client";

import {PonsPredictionAbi, UniswapV3PonsOracleAbi, formatEth} from "@pons/sdk";
import {useState} from "react";
import {parseEther} from "viem";
import {useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {useApiHealth, useOracleHealth} from "@/lib/api";
import {getDeployment} from "@/lib/deployment";
import {explorerTxUrl} from "@/lib/wagmi";

/**
 * Operations dashboard.
 *
 * Authorisation here is **on chain, not in the UI**. Every control is gated on the
 * connected wallet actually holding the relevant role, read live from the contract. A
 * hidden button is a courtesy, not a security boundary — the contract would reject an
 * unauthorised call regardless, and this page never pretends otherwise.
 */
export default function AdminPage() {
  const d = getDeployment();
  const {address, isConnected} = useAccount();

  const base = {address: d?.prediction, abi: PonsPredictionAbi} as const;
  const {data: roles} = useReadContracts({
    contracts: [
      {...base, functionName: "DEFAULT_ADMIN_ROLE"},
      {...base, functionName: "PAUSER_ROLE"},
      {...base, functionName: "CONFIG_ROLE"},
      {...base, functionName: "OPERATOR_ROLE"},
    ],
    query: {enabled: Boolean(d)},
  });

  const roleIds = (roles ?? []).map((r) => r.result as `0x${string}` | undefined);
  const {data: held} = useReadContracts({
    contracts: roleIds.map((id) => ({...base, functionName: "hasRole", args: id && address ? [id, address] : undefined})),
    query: {enabled: Boolean(d && address && roleIds[0])},
  });
  const [isAdmin, isPauser, isConfig] = (held ?? []).map((r) => Boolean(r?.result));

  const {data: state} = useReadContracts({
    contracts: [
      {...base, functionName: "currentEpoch"},
      {...base, functionName: "paused"},
      {...base, functionName: "treasuryAmount"},
      {...base, functionName: "totalLiabilities"},
      {...base, functionName: "solvency"},
      {...base, functionName: "minimumBet"},
      {...base, functionName: "maximumBet"},
      {...base, functionName: "maximumRoundPool"},
      {...base, functionName: "treasuryFeeBps"},
      {...base, functionName: "bufferSeconds"},
      {...base, functionName: "pendingWork"},
    ],
    query: {enabled: Boolean(d), refetchInterval: 8_000},
  });

  const {data: oracleDesc} = useReadContract({
    address: d?.oracle,
    abi: UniswapV3PonsOracleAbi,
    functionName: "description",
    query: {enabled: Boolean(d)},
  });

  const oracleHealth = useOracleHealth();
  const apiHealth = useApiHealth();

  if (!d) return <div className="card p-6 text-sm text-mute-500">No market configured.</div>;

  const currentEpoch = state?.[0]?.result as bigint | undefined;
  const paused = Boolean(state?.[1]?.result);
  const treasury = (state?.[2]?.result as bigint | undefined) ?? 0n;
  const liabilities = (state?.[3]?.result as bigint | undefined) ?? 0n;
  const solvency = state?.[4]?.result as readonly [bigint, bigint, boolean] | undefined;
  const pending = state?.[10]?.result as readonly [bigint[], bigint[], bigint[], boolean] | undefined;

  return (
    <>
      <h1 className="mb-1 text-2xl font-bold text-white">Operations</h1>
      <p className="mb-6 text-sm text-mute-500">
        Every action below is authorised by the contract against your connected wallet&apos;s roles.
      </p>

      {!isConnected && (
        <div className="card mb-6 p-4 text-sm text-mute-500">Connect a wallet to see which controls you hold.</div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Current epoch" value={currentEpoch?.toString() ?? "—"} />
        <Stat label="Entries" value={paused ? "Paused" : "Open"} tone={paused ? "fall" : "rise"} />
        <Stat label="Treasury (unwithdrawn)" value={`${formatEth(treasury)} ETH`} />
        <Stat label="Owed to users" value={`${formatEth(liabilities)} ETH`} />
      </div>

      <section className="card mb-6 p-5">
        <h2 className="mb-3 text-sm font-semibold text-white">Solvency</h2>
        {solvency ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Line label="Contract balance" value={`${formatEth(solvency[0])} ETH`} />
            <Line label="Total obligations" value={`${formatEth(solvency[1])} ETH`} />
            <Line
              label="Invariant"
              value={solvency[2] ? "Holds" : "VIOLATED"}
              tone={solvency[2] ? "rise" : "fall"}
            />
          </div>
        ) : (
          <p className="text-sm text-mute-500">—</p>
        )}
        <p className="mt-3 text-[11px] text-mute-500">
          The contract must always hold at least what it owes: live stakes, unclaimed rewards, unclaimed refunds and
          unwithdrawn fees. A violation here would be a critical incident.
        </p>
      </section>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-white">Oracle and pool</h2>
          <dl className="space-y-2 text-sm">
            <Line label="Feed" value={(oracleDesc as string) ?? "—"} />
            {oracleHealth.data && (
              <>
                <Line label="Pool liquidity" value={oracleHealth.data.poolLiquidity} />
                <Line
                  label="Observation buffer"
                  value={`${oracleHealth.data.observations.cardinality} slots · ${Math.round(
                    oracleHealth.data.observations.historySpanSeconds / 3600
                  )}h of history`}
                />
                <Line
                  label="Last observation"
                  value={`${oracleHealth.data.observations.secondsSinceLastObservation}s ago`}
                  tone={oracleHealth.data.observations.secondsSinceLastObservation > 900 ? "fall" : undefined}
                />
              </>
            )}
            {oracleHealth.error && <p className="text-xs text-down-400">Read API unreachable.</p>}
          </dl>
          <p className="mt-3 text-[11px] text-mute-500">
            A long gap since the last observation is the leading indicator of a stalled round: until the pool records
            one covering a round&apos;s instant, that round cannot be priced.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-white">Unresolved work</h2>
          {pending ? (
            <dl className="space-y-2 text-sm">
              <Line label="Awaiting lock" value={pending[0].length ? pending[0].join(", ") : "none"} />
              <Line label="Awaiting settle" value={pending[1].length ? pending[1].join(", ") : "none"} />
              <Line
                label="Cancellable (stuck)"
                value={pending[2].length ? pending[2].join(", ") : "none"}
                tone={pending[2].length ? "fall" : undefined}
              />
              <Line label="Next round due" value={pending[3] ? "yes" : "no"} />
            </dl>
          ) : (
            <p className="text-sm text-mute-500">—</p>
          )}
          <p className="mt-3 text-[11px] text-mute-500">
            These transitions are permissionless — anyone can execute them, so a stalled keeper delays results but
            cannot hold funds. Indexer lag:{" "}
            {apiHealth.data ? `${apiHealth.data.indexerLagBlocks} blocks` : "unknown"}.
          </p>
        </section>
      </div>

      <RoleControls
        prediction={d.prediction}
        isAdmin={isAdmin}
        isPauser={isPauser}
        isConfig={isConfig}
        paused={paused}
        treasury={treasury}
      />
    </>
  );
}

function RoleControls({
  prediction, isAdmin, isPauser, isConfig, paused, treasury,
}: {
  prediction: `0x${string}`; isAdmin?: boolean; isPauser?: boolean; isConfig?: boolean;
  paused: boolean; treasury: bigint;
}) {
  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {data: receipt} = useWaitForTransactionReceipt({hash});
  const [minBet, setMinBet] = useState("");
  const [maxBet, setMaxBet] = useState("");
  const [maxPool, setMaxPool] = useState("");

  const call = (functionName: string, args: readonly unknown[]) =>
    writeContract({address: prediction, abi: PonsPredictionAbi, functionName: functionName as never, args: args as never});

  const noRoles = !isAdmin && !isPauser && !isConfig;

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">Controls</h2>
      <p className="mb-4 text-[11px] text-mute-500">
        No role here can set a price, change an outcome, alter a placed entry, or withdraw ETH owed to users. Fee and
        oracle changes are timelocked and apply only to rounds created afterwards.
      </p>

      {noRoles ? (
        <p className="text-sm text-mute-500">Your wallet holds no administrative roles on this contract.</p>
      ) : (
        <div className="space-y-4">
          {isPauser && (
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-ghost" disabled={isPending} onClick={() => call(paused ? "unpausePrediction" : "pausePrediction", [])}>
                {paused ? "Resume entries" : "Pause entries"}
              </button>
              <span className="text-[11px] text-mute-500">
                Pausing stops new entries only. Settlement, claims and refunds continue.
              </span>
            </div>
          )}

          {isConfig && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Minimum bet (ETH)" value={minBet} onChange={setMinBet}
                     onApply={() => minBet && call("setMinimumBet", [parseEther(minBet as `${number}`)])} disabled={isPending} />
              <Field label="Maximum bet (ETH, 0 = off)" value={maxBet} onChange={setMaxBet}
                     onApply={() => maxBet && call("setMaximumBet", [parseEther(maxBet as `${number}`)])} disabled={isPending} />
              <Field label="Max round pool (ETH, 0 = off)" value={maxPool} onChange={setMaxPool}
                     onApply={() => maxPool && call("setMaximumRoundPool", [parseEther(maxPool as `${number}`)])} disabled={isPending} />
            </div>
          )}

          {isAdmin && treasury > 0n && (
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-ghost" disabled={isPending} onClick={() => call("claimTreasury", [treasury])}>
                Withdraw {formatEth(treasury)} ETH of fees
              </button>
              <span className="text-[11px] text-mute-500">Bounded by accrued fees; cannot reach user funds.</span>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-xs text-down-400">{error.message.split("\n")[0]}</p>}
      {receipt?.status === "success" && hash && (
        <p className="mt-3 text-sm text-up-400">
          Confirmed.{" "}
          {explorerTxUrl(hash) && (
            <a className="underline" href={explorerTxUrl(hash)!} target="_blank" rel="noreferrer">View ↗</a>
          )}
        </p>
      )}
      {receipt?.status === "reverted" && <p className="mt-3 text-sm text-down-400">Transaction reverted.</p>}
    </section>
  );
}

function Field({
  label, value, onChange, onApply, disabled,
}: {
  label: string; value: string; onChange: (v: string) => void; onApply: () => void; disabled?: boolean;
}) {
  return (
    <div>
      <label className="label mb-1 block">{label}</label>
      <div className="flex gap-2">
        <input
          className="num w-full rounded border border-base-600 bg-base-950 px-2 py-1.5 text-sm text-white outline-none focus:border-up-500"
          value={value}
          inputMode="decimal"
          onChange={(e) => onChange(e.target.value)}
        />
        <button className="btn-ghost px-3 py-1.5 text-xs" disabled={disabled || !value} onClick={onApply}>
          Set
        </button>
      </div>
    </div>
  );
}

function Stat({label, value, tone}: {label: string; value: string; tone?: "rise" | "fall"}) {
  const color = tone === "rise" ? "text-up-400" : tone === "fall" ? "text-down-400" : "text-white";
  return (
    <div className="card p-4">
      <div className="label">{label}</div>
      <div className={`num mt-1 text-xl ${color}`}>{value}</div>
    </div>
  );
}

function Line({label, value, tone}: {label: string; value: string; tone?: "rise" | "fall"}) {
  const color = tone === "rise" ? "text-up-400" : tone === "fall" ? "text-down-400" : "text-white";
  return (
    <div className="flex justify-between gap-3">
      <span className="text-mute-500">{label}</span>
      <span className={`num ${color}`}>{value}</span>
    </div>
  );
}

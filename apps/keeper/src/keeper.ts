import {PonsBuybackBurnerAbi, PonsPredictionAbi} from "@pons/sdk";
import type {Account, Address, Chain, PublicClient, WalletClient} from "viem";
import type {KeeperConfig} from "./config.js";
import type {Lock} from "./lock.js";
import {log} from "./logger.js";
import type {RpcPool} from "./rpc.js";
import type {StateStore} from "./state.js";
import {TxSender, describeRevert, sleep} from "./tx.js";

/**
 * The keeper loop.
 *
 * Worth being explicit about what this process is and is not. It **cannot** choose a
 * price: `PonsPrediction` derives every price from the round's own scheduled timestamps,
 * so a transaction sent now and the same transaction sent ten minutes from now produce
 * identical state. Nor can it censor: the lifecycle calls are permissionless, so if this
 * process dies, anybody — a bettor, a bot, a competitor — can push the market forward.
 *
 * That makes the keeper a *convenience*, and it is why the loop can be this simple: it
 * asks the contract what is actionable, does it, and never reasons about prices itself.
 */
export interface KeeperStatus {
  running: boolean;
  lastTickAt?: string;
  lastTickOk: boolean;
  lastError?: string;
  currentEpoch: string;
  operator: Address;
  operatorBalanceWei: string;
  holdsLock: boolean;
  consecutiveFailures: number;
  pending: {lockable: string[]; settleable: string[]; cancellable: string[]; canStartNext: boolean};
}

export class Keeper {
  private stopped = false;
  private holdsLock = false;
  private consecutiveFailures = 0;
  private status: KeeperStatus;

  constructor(
    private readonly cfg: KeeperConfig,
    private readonly chain: Chain,
    private readonly rpc: RpcPool,
    private readonly publicClient: PublicClient,
    private readonly wallet: WalletClient,
    private readonly account: Account,
    private readonly state: StateStore,
    private readonly lock: Lock,
    private readonly sender: TxSender
  ) {
    this.status = {
      running: false,
      lastTickOk: false,
      currentEpoch: "0",
      operator: account.address,
      operatorBalanceWei: "0",
      holdsLock: false,
      consecutiveFailures: 0,
      pending: {lockable: [], settleable: [], cancellable: [], canStartNext: false},
    };
  }

  getStatus(): KeeperStatus {
    return {...this.status, holdsLock: this.holdsLock, consecutiveFailures: this.consecutiveFailures};
  }

  /** The balance below which this keeper refuses to send. Health checks read it so that
   *  "refusing to send" and "not ready" can never disagree. */
  get minBalanceWei(): bigint {
    return this.cfg.minBalanceWei;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    this.status.running = true;
    log.info("keeper started", {
      chainId: this.cfg.chainId,
      operator: this.account.address,
      prediction: this.cfg.prediction,
      lock: this.lock.kind,
      dryRun: this.cfg.dryRun,
    });

    while (!this.stopped) {
      try {
        await this.tick();
        this.consecutiveFailures = 0;
        this.status.lastTickOk = true;
        this.status.lastError = undefined;
        this.state.update((s) => (s.lastSuccessfulTickAt = new Date().toISOString()));
      } catch (err) {
        this.consecutiveFailures++;
        this.status.lastTickOk = false;
        this.status.lastError = describeRevert(err);
        log.error("tick failed", {err, consecutiveFailures: this.consecutiveFailures});
        // Any failure could be nonce drift, so drop the cached nonce rather than
        // carrying a wrong one into the next tick.
        this.sender.resetNonce();
        if (this.consecutiveFailures >= 3) await this.rpc.probe(this.chain);
      } finally {
        this.status.lastTickAt = new Date().toISOString();
      }
      // Back off after repeated failures so an outage does not turn into a request flood.
      const backoff = Math.min(this.consecutiveFailures, 6) * this.cfg.pollIntervalMs;
      await sleep(this.cfg.pollIntervalMs + backoff);
    }

    await this.lock.release();
    this.status.running = false;
    log.info("keeper stopped");
  }

  private async tick(): Promise<void> {
    this.holdsLock = this.holdsLock ? await this.lock.renew() : await this.lock.acquire();
    if (!this.holdsLock) {
      log.debug("another keeper holds the lock; standing by");
      return;
    }

    const [balance, currentEpoch, paused] = await Promise.all([
      this.publicClient.getBalance({address: this.account.address}),
      this.read("currentEpoch", []) as Promise<bigint>,
      this.read("paused", []) as Promise<boolean>,
    ]);
    this.status.operatorBalanceWei = balance.toString();
    this.status.currentEpoch = currentEpoch.toString();

    if (balance < this.cfg.minBalanceWei) {
      log.error("operator balance below floor", {balance: balance.toString(), floor: this.cfg.minBalanceWei.toString()});
    }

    if (currentEpoch === 0n) {
      log.warn("market has no rounds yet; genesisStartRound must be called by an operator");
      return;
    }

    // Ask the contract what is actionable rather than deciding here. Keeping that
    // judgement on chain is what stops the keeper's view and the contract's from drifting.
    const [lockable, settleable, cancellable, canStartNext] = (await this.read("pendingWork", [])) as [
      bigint[],
      bigint[],
      bigint[],
      boolean,
    ];
    this.status.pending = {
      lockable: lockable.map(String),
      settleable: settleable.map(String),
      cancellable: cancellable.map(String),
      canStartNext,
    };

    if (paused) {
      // Entries are stopped, but settling and refunding still protect users, so keep going.
      log.warn("market is paused; continuing to resolve existing rounds");
    }

    const work = lockable.length + settleable.length + cancellable.length + (canStartNext ? 1 : 0);
    if (work === 0) {
      log.debug("nothing due", {currentEpoch: currentEpoch.toString()});
      return;
    }
    log.info("work due", this.status.pending as unknown as Record<string, unknown>);

    // `executeRound` folds lock, settle and start into one transaction, so try it first
    // and fall back to the granular calls only for what it could not cover.
    if (lockable.length > 0 || settleable.length > 0 || canStartNext) {
      await this.sender.send({
        action: "executeRound",
        address: this.cfg.prediction,
        abi: PonsPredictionAbi,
        functionName: "executeRound",
        args: [],
      });
      this.state.update((s) => (s.lastExecutionAt = new Date().toISOString()));
    }

    // Cancellation is separate: it is not part of the normal cadence, and each round has
    // to be named individually.
    for (const epoch of cancellable) {
      const key = `cancel:${epoch}`;
      if (this.state.isHandled(key)) continue;
      const res = await this.sender.send({
        action: "cancelRound",
        epoch,
        address: this.cfg.prediction,
        abi: PonsPredictionAbi,
        functionName: "cancelRound",
        args: [epoch],
      });
      if (res.status !== "failed") this.state.markHandled(key);
    }

    // Anything executeRound could not reach — usually because a price arrived for an
    // older round after the head had already moved on — is picked up individually.
    const [stillLockable, stillSettleable] = (await this.read("pendingWork", [])) as [bigint[], bigint[]];
    for (const epoch of stillLockable) {
      await this.sender.send({
        action: "lockRound",
        epoch,
        address: this.cfg.prediction,
        abi: PonsPredictionAbi,
        functionName: "lockRound",
        args: [epoch],
      });
    }
    for (const epoch of stillSettleable) {
      await this.sender.send({
        action: "settleRound",
        epoch,
        address: this.cfg.prediction,
        abi: PonsPredictionAbi,
        functionName: "settleRound",
        args: [epoch],
      });
    }

    await this.sweepBurnAllocation();
    await this.runBuybacks();

    this.state.update((s) => (s.lastSeenEpoch = currentEpoch.toString()));
  }

  /**
   * Pushes the settled rounds' burn allocation to the burner.
   *
   * This is the "right after the round ends" half of the tokenomics. It is a separate
   * transaction on purpose — settlement must not contain an external call that can
   * revert, and must not trade in the pools its own oracle reads — so the keeper simply
   * sends it immediately afterwards. The call is permissionless, so a dead keeper delays
   * a buyback rather than stranding it: anyone can sweep.
   */
  private async sweepBurnAllocation(): Promise<void> {
    let allocated: bigint;
    try {
      allocated = (await this.read("burnAllocated", [])) as bigint;
    } catch {
      // Either the read failed, or this is a market deployed before buyback-and-burn and
      // the function does not exist. Both mean "nothing to sweep here": on a v1 market
      // the fee is withdrawn by an admin with `claimTreasury`, which the keeper has no
      // role to call and should not be trying. Never let it disturb the lifecycle loop.
      return;
    }
    if (allocated <= 0n) return;
    await this.sender.send({
      action: "sweepToBurner",
      address: this.cfg.prediction,
      abi: PonsPredictionAbi,
      functionName: "sweepToBurner",
      args: [],
    });
  }

  /**
   * Executes the buybacks the burner is holding ETH for.
   *
   * Passing `minAmountOut: 0` is not a missing slippage guard. The contract derives the
   * real floor from the pool's own TWAP and ignores a caller's minimum unless it is
   * stricter, so zero means "accept the on-chain floor" — which is the floor the keeper
   * would compute anyway, without a race between reading it and sending.
   *
   * Failures here are logged and retried on the next tick. A buyback that cannot execute
   * — a thin pool, a moved price, the rate limit — must never affect the lifecycle, and
   * the call is permissionless, so nothing is stuck if this keeper never runs again.
   */
  private async runBuybacks(): Promise<void> {
    if (this.cfg.burner === "0x0000000000000000000000000000000000000000") return;

    for (const index of [0, 1] as const) {
      let allocated: bigint;
      let target: {token: `0x${string}`};
      try {
        [allocated, target] = (await Promise.all([
          this.publicClient.readContract({
            address: this.cfg.burner,
            abi: PonsBuybackBurnerAbi,
            functionName: "allocated",
            args: [BigInt(index)],
          }),
          this.publicClient.readContract({
            address: this.cfg.burner,
            abi: PonsBuybackBurnerAbi,
            functionName: "target",
            args: [index],
          }),
        ])) as [bigint, {token: `0x${string}`}];
      } catch (err) {
        log.warn("could not read burner state", {index, err});
        continue;
      }

      // An unconfigured target accrues on purpose; it is not an error to skip it.
      if (target.token === "0x0000000000000000000000000000000000000000") continue;
      if (allocated < this.cfg.minBuybackWei) continue;

      await this.sender.send({
        action: `buyAndBurn:${index}`,
        address: this.cfg.burner,
        abi: PonsBuybackBurnerAbi,
        functionName: "buyAndBurn",
        args: [index, 0n, 0n],
      });
    }
  }

  /** Narrow escape hatch: the ABI's literal function-name union is not worth threading
   *  through every call site for what is always a plain read. */
  private read(functionName: string, args: readonly unknown[]): Promise<unknown> {
    return this.publicClient.readContract({
      address: this.cfg.prediction,
      abi: PonsPredictionAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<unknown>;
  }
}

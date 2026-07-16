import type {Account, Address, Chain, Hex, PublicClient, WalletClient} from "viem";
import {log} from "./logger.js";
import type {StateStore} from "./state.js";

/**
 * Transaction submission that survives a real network.
 *
 * The problems this exists to handle, in the order they bite:
 *
 *  - **Nonce drift.** The local nonce and the chain's disagree after a crash, a manual
 *    transaction, or a dropped mempool entry. Rather than trusting a cached counter, the
 *    nonce is re-read from the chain whenever a send fails in a way that suggests drift.
 *  - **Stuck transactions.** A transaction that does not confirm within the timeout is
 *    *replaced* at the same nonce with a higher fee, not re-sent at a new one — resending
 *    at a new nonce is how you end up executing twice.
 *  - **Already-done work.** The contract's lifecycle calls revert when there is nothing
 *    to do. That is a normal outcome for a keeper racing another caller, so it is logged
 *    at info and reported as success, not retried.
 */
export interface SendArgs {
  action: string;
  epoch?: bigint;
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}

export interface SendResult {
  status: "confirmed" | "skipped" | "failed";
  hash?: Hex;
  reason?: string;
  attempts: number;
}

export interface TxSenderOptions {
  confirmations: number;
  timeoutMs: number;
  bumpPercent: number;
  maxAttempts: number;
  minBalanceWei: bigint;
  dryRun: boolean;
}

/** Reverts that mean "someone already did this", which is success from our point of view. */
const BENIGN = [
  "RoundNotOpen",
  "NotYetSettleable",
  "NotYetLockable",
  "AlreadyStarted",
  "RoundNotCancellable",
  "PriceUnavailable",
];

export class TxSender {
  private nonce: number | undefined;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly wallet: WalletClient,
    private readonly account: Account,
    private readonly chain: Chain,
    private readonly state: StateStore,
    private readonly opts: TxSenderOptions
  ) {}

  /** Forces a nonce re-read on the next send. Used after any suspicion of drift. */
  resetNonce(): void {
    this.nonce = undefined;
  }

  private async nextNonce(): Promise<number> {
    if (this.nonce === undefined) {
      // "pending" so queued-but-unmined transactions of ours are counted.
      this.nonce = await this.publicClient.getTransactionCount({address: this.account.address, blockTag: "pending"});
      log.debug("nonce resynced from chain", {nonce: this.nonce});
    }
    return this.nonce;
  }

  async send(args: SendArgs): Promise<SendResult> {
    const logger = log.child({action: args.action, epoch: args.epoch?.toString()});

    const balance = await this.publicClient.getBalance({address: this.account.address});
    if (balance < this.opts.minBalanceWei) {
      logger.error("operator balance below floor; refusing to send", {
        balance: balance.toString(),
        floor: this.opts.minBalanceWei.toString(),
      });
      return {status: "failed", reason: "OPERATOR_BALANCE_LOW", attempts: 0};
    }

    // Simulate first. This is what turns "nothing to do" into a cheap skip instead of a
    // reverted transaction that still costs gas.
    try {
      await this.publicClient.simulateContract({
        address: args.address,
        abi: args.abi as never,
        functionName: args.functionName,
        args: args.args as never,
        account: this.account,
      });
    } catch (err) {
      const reason = describeRevert(err);
      if (BENIGN.some((b) => reason.includes(b))) {
        logger.info("nothing to do", {reason});
        return {status: "skipped", reason, attempts: 0};
      }
      logger.warn("simulation failed; not sending", {reason});
      return {status: "failed", reason, attempts: 0};
    }

    if (this.opts.dryRun) {
      logger.info("dry run: would have sent");
      return {status: "skipped", reason: "DRY_RUN", attempts: 0};
    }

    let attempts = 0;
    let nonce = await this.nextNonce();
    // Robinhood Chain reports `baseFeePerGas`, so fees are EIP-1559 throughout.
    let fees: FeeSettings = await this.publicClient.estimateFeesPerGas();

    while (attempts < this.opts.maxAttempts) {
      attempts++;
      try {
        const gas = await this.publicClient.estimateContractGas({
          address: args.address,
          abi: args.abi as never,
          functionName: args.functionName,
          args: args.args as never,
          account: this.account,
        });

        const hash = await this.wallet.writeContract({
          address: args.address,
          abi: args.abi as never,
          functionName: args.functionName,
          args: args.args as never,
          account: this.account,
          chain: this.chain,
          nonce,
          // Headroom: gas use can rise between estimate and inclusion if another caller
          // changes the round's state in between.
          gas: (gas * 130n) / 100n,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });

        this.state.update((s) => {
          s.totals.sent++;
          s.recentTxs.push({
            hash,
            action: args.action,
            epoch: args.epoch?.toString(),
            nonce,
            submittedAt: new Date().toISOString(),
            status: "pending",
          });
        });
        logger.info("transaction submitted", {hash, nonce, attempt: attempts});

        try {
          const receipt = await this.publicClient.waitForTransactionReceipt({
            hash,
            confirmations: this.opts.confirmations,
            timeout: this.opts.timeoutMs,
          });
          this.nonce = nonce + 1;
          const ok = receipt.status === "success";
          // Real gas paid, not an estimate: runway is only useful if it is measured, and
          // a failed transaction still costs gas, so both are counted.
          const gasPaid = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
          this.state.update((s) => {
            s.gasSpentWei = (BigInt(s.gasSpentWei ?? "0") + gasPaid).toString();
            if (ok) s.totals.confirmed++;
            else s.totals.failed++;
            const rec = s.recentTxs.find((t) => t.hash === hash);
            if (rec) {
              rec.status = ok ? "confirmed" : "failed";
              rec.confirmedAt = new Date().toISOString();
            }
          });
          if (!ok) {
            logger.error("transaction reverted on chain", {hash});
            return {status: "failed", reason: "REVERTED", hash, attempts};
          }
          logger.info("transaction confirmed", {hash, block: receipt.blockNumber});
          return {status: "confirmed", hash, attempts};
        } catch (waitErr) {
          // Not confirmed in time. Replace at the *same* nonce with a higher fee; using a
          // fresh nonce here is what would cause a double execution.
          logger.warn("transaction not confirmed in time; replacing", {hash, nonce, err: waitErr});
          this.state.update((s) => {
            s.totals.replaced++;
            const rec = s.recentTxs.find((t) => t.hash === hash);
            if (rec) rec.status = "replaced";
          });
          fees = bumpFees(fees, this.opts.bumpPercent);
          continue;
        }
      } catch (err) {
        const reason = describeRevert(err);
        if (/nonce|already known|replacement transaction underpriced/i.test(reason)) {
          // Any of these mean our idea of the nonce is wrong or our fee is too low to
          // replace. Re-read the nonce and raise the fee before trying again.
          logger.warn("nonce or replacement conflict; resyncing", {reason, nonce});
          this.resetNonce();
          nonce = await this.nextNonce();
          fees = bumpFees(fees, this.opts.bumpPercent);
          continue;
        }
        if (BENIGN.some((b) => reason.includes(b))) {
          logger.info("became unnecessary while sending", {reason});
          return {status: "skipped", reason, attempts};
        }
        logger.error("send failed", {reason, attempt: attempts});
        this.resetNonce();
        await sleep(500 * attempts);
      }
    }

    this.state.update((s) => s.totals.failed++);
    return {status: "failed", reason: "MAX_ATTEMPTS", attempts};
  }
}

interface FeeSettings {
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
}

/**
 * Raises both fee fields by `percent`.
 *
 * A replacement must beat the original on *priority* fee as well as max fee, or nodes
 * reject it as underpriced and the original stays stuck — which is the failure this
 * whole path exists to escape.
 */
function bumpFees(fees: FeeSettings, percent: number): FeeSettings {
  const factor = BigInt(100 + percent);
  const scale = (v?: bigint) => (v === undefined ? undefined : (v * factor) / 100n);
  return {maxFeePerGas: scale(fees.maxFeePerGas), maxPriorityFeePerGas: scale(fees.maxPriorityFeePerGas)};
}

/** Digs a usable reason out of viem's nested error shapes. */
export function describeRevert(err: unknown): string {
  if (!err) return "unknown";
  const anyErr = err as {shortMessage?: string; details?: string; message?: string; cause?: unknown; metaMessages?: string[]};
  const parts = [anyErr.shortMessage, anyErr.details, anyErr.message, anyErr.metaMessages?.join(" ")].filter(Boolean);
  let text = parts.join(" | ");
  let cause = anyErr.cause;
  let depth = 0;
  while (cause && depth++ < 5) {
    const c = cause as {shortMessage?: string; message?: string; cause?: unknown};
    text += ` <- ${c.shortMessage ?? c.message ?? ""}`;
    cause = c.cause;
  }
  return text.trim() || String(err);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

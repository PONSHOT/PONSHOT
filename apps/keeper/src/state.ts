import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {log} from "./logger.js";

/**
 * Durable keeper state.
 *
 * The keeper is designed so that losing this file is survivable — every decision it
 * makes is re-derivable from chain state, which is the point of keeping the contract's
 * lifecycle idempotent. The file exists to make restarts *quiet* (no duplicate
 * transactions, no re-reporting of work already done) and to give operators a record.
 *
 * Written via write-then-rename so a crash mid-write cannot leave a truncated file that
 * fails to parse on the next boot.
 */
export interface SentTx {
  hash: string;
  action: string;
  epoch?: string;
  nonce: number;
  submittedAt: string;
  confirmedAt?: string;
  status?: "pending" | "confirmed" | "replaced" | "failed";
}

export interface KeeperState {
  lastSeenEpoch: string;
  lastSuccessfulTickAt?: string;
  lastExecutionAt?: string;
  handled: Record<string, string>;
  recentTxs: SentTx[];
  totals: {sent: number; confirmed: number; failed: number; replaced: number};
}

const EMPTY: KeeperState = {
  lastSeenEpoch: "0",
  handled: {},
  recentTxs: [],
  totals: {sent: 0, confirmed: 0, failed: 0, replaced: 0},
};

export class StateStore {
  private state: KeeperState = structuredClone(EMPTY);

  constructor(private readonly path: string) {}

  load(): KeeperState {
    try {
      if (existsSync(this.path)) {
        this.state = {...structuredClone(EMPTY), ...JSON.parse(readFileSync(this.path, "utf8"))};
        log.info("keeper state restored", {path: this.path, lastSeenEpoch: this.state.lastSeenEpoch});
      }
    } catch (err) {
      // A corrupt state file must not stop the keeper: everything in it is recoverable
      // from chain state, so starting clean is strictly better than refusing to run.
      log.warn("keeper state unreadable, starting clean", {path: this.path, err});
      this.state = structuredClone(EMPTY);
    }
    return this.state;
  }

  get(): KeeperState {
    return this.state;
  }

  update(fn: (s: KeeperState) => void): void {
    fn(this.state);
    this.state.recentTxs = this.state.recentTxs.slice(-100);
    this.flush();
  }

  /** Marks an action as done so a restart does not re-send it. */
  markHandled(key: string): void {
    this.update((s) => {
      s.handled[key] = new Date().toISOString();
      const keys = Object.keys(s.handled);
      if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete s.handled[k];
    });
  }

  isHandled(key: string): boolean {
    return this.state.handled[key] !== undefined;
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), {recursive: true});
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      log.error("could not persist keeper state", {path: this.path, err});
    }
  }
}

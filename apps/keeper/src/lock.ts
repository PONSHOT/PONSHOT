import {log} from "./logger.js";

/**
 * Single-writer lock, so two keeper replicas cannot both send the same transaction.
 *
 * Duplicate execution is not a correctness problem here — the contract rejects the
 * second lock or settle, and the price would be identical anyway — but it wastes gas and
 * fills the logs with confusing reverts. The lock is therefore a cost and clarity
 * measure, deliberately not a safety one; the system stays correct if it fails open.
 */
export interface Lock {
  acquire(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
  readonly kind: string;
}

/** Single-process fallback used when no Redis is configured. */
export class NoopLock implements Lock {
  readonly kind = "none";
  async acquire(): Promise<boolean> {
    return true;
  }
  async renew(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {}
}

export class RedisLock implements Lock {
  readonly kind = "redis";
  private redis: import("ioredis").Redis | undefined;
  private readonly token = `${process.pid}-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly ttlMs: number
  ) {}

  private async client(): Promise<import("ioredis").Redis> {
    if (!this.redis) {
      const {default: Redis} = await import("ioredis");
      this.redis = new Redis(this.url, {maxRetriesPerRequest: 2, lazyConnect: true});
      await this.redis.connect();
    }
    return this.redis;
  }

  async acquire(): Promise<boolean> {
    try {
      const r = await this.client();
      const res = await r.set(this.key, this.token, "PX", this.ttlMs, "NX");
      return res === "OK";
    } catch (err) {
      // Failing open is the deliberate choice: a Redis outage must not stop rounds from
      // being settled, and duplicate execution is harmless here.
      log.warn("lock unavailable, proceeding without it", {err});
      return true;
    }
  }

  /** Renews only if we still hold it, so a paused process cannot steal it back. */
  async renew(): Promise<boolean> {
    try {
      const r = await this.client();
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
      const res = (await r.eval(script, 1, this.key, this.token, String(this.ttlMs))) as number;
      return res === 1;
    } catch (err) {
      log.warn("lock renew failed, proceeding", {err});
      return true;
    }
  }

  async release(): Promise<void> {
    try {
      const r = await this.client();
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
      await r.eval(script, 1, this.key, this.token);
    } catch (err) {
      log.warn("lock release failed", {err});
    }
  }
}

export function createLock(url: string | undefined, key: string, ttlMs: number): Lock {
  return url ? new RedisLock(url, key, ttlMs) : new NoopLock();
}

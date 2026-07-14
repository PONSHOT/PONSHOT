import {createPublicClient, fallback} from "viem";
import type {Chain, PublicClient, Transport} from "viem";
import {log} from "./logger.js";
import {nodeHttp} from "@pons/sdk/node-rpc";

/**
 * RPC access with failover.
 *
 * viem's `fallback` transport already rotates on error, but it will not tell an operator
 * *which* endpoint is currently serving or how often it has switched — and during an
 * outage that is the first thing anyone wants to know. So health is tracked alongside it
 * and exposed through the health endpoint.
 */
export interface RpcHealth {
  url: string;
  ok: boolean;
  lastError?: string;
  lastCheckedAt?: string;
  latencyMs?: number;
}

export class RpcPool {
  readonly transport: Transport;
  private readonly health = new Map<string, RpcHealth>();

  constructor(private readonly urls: string[]) {
    for (const url of urls) this.health.set(url, {url, ok: true});
    this.transport = fallback(
      urls.map((url) => nodeHttp(url, {timeoutMs: 15_000})),
      {rank: false}
    );
  }

  client(chain: Chain): PublicClient {
    return createPublicClient({chain, transport: this.transport});
  }

  /** Probes every endpoint so the health endpoint reports the truth, not a guess. */
  async probe(chain: Chain): Promise<RpcHealth[]> {
    await Promise.all(
      this.urls.map(async (url) => {
        const started = Date.now();
        try {
          const c = createPublicClient({chain, transport: nodeHttp(url, {timeoutMs: 8_000})});
          await c.getBlockNumber();
          this.health.set(url, {url, ok: true, lastCheckedAt: new Date().toISOString(), latencyMs: Date.now() - started});
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.health.set(url, {url, ok: false, lastError: message, lastCheckedAt: new Date().toISOString()});
          log.warn("rpc endpoint unhealthy", {url, err: message});
        }
      })
    );
    return this.snapshot();
  }

  snapshot(): RpcHealth[] {
    return [...this.health.values()];
  }

  get anyHealthy(): boolean {
    return this.snapshot().some((h) => h.ok);
  }
}

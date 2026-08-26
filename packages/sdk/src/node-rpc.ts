/**
 * JSON-RPC over `node:https`, and a viem transport built on it.
 *
 * **Node-only.** Never import this from `@pons/sdk`'s main entry: it pulls in `node:https`
 * and would break any browser bundle that touches the SDK. It is a separate export
 * (`@pons/sdk/node-rpc`) for exactly that reason.
 *
 * ## Why this exists
 *
 * The Robinhood Chain RPC sits behind Cloudflare, which began challenging Node's built-in
 * `fetch` (undici). Measured against the live endpoint, repeatedly:
 *
 *   undici `fetch`   → 403, a Cloudflare "Just a moment..." interstitial
 *   `node:https`     → 200, every time
 *   `curl`, `cast`   → 200
 *
 * It is not the headers. undici's extra `sec-fetch-mode`, `accept-language: *` and
 * `user-agent: node` were all overridden to browser values and to curl's, and forcing
 * ALPN to http/1.1 made no difference either; the challenge is on something lower down.
 * Rather than keep guessing at a fingerprint we do not control, this routes through the
 * standard library client that the endpoint accepts.
 *
 * viem's `http()` transport calls global `fetch` internally with no way to substitute it,
 * so the fix has to be a transport rather than a fetch option.
 */
import {custom} from "viem";
import type {Transport} from "viem";
import http from "node:http";
import https from "node:https";

export interface NodeRpcOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** POSTs a JSON-RPC payload (single or batch) and returns the parsed response. */
export function postJsonRpc(url: string, payload: unknown, options: NodeRpcOptions = {}): Promise<unknown> {
  const {timeoutMs = 20_000, headers = {}} = options;
  const target = new URL(url);
  const client = target.protocol === "http:" ? http : https;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            // Surface the status and a slice of the body: an HTML interstitial here is a
            // very different problem from a node error, and truncating it to a generic
            // "request failed" is what made this take an hour to identify.
            reject(new Error(`RPC ${res.statusCode} from ${target.host}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`RPC returned non-JSON from ${target.host}: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`RPC timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

type RpcResponse = {result?: unknown; error?: {code?: number; message?: string}};

/** A viem transport that speaks JSON-RPC over `node:https` instead of `fetch`. */
export function nodeHttp(url: string, options: NodeRpcOptions = {}): Transport {
  let id = 0;
  return custom({
    async request({method, params}) {
      const response = (await postJsonRpc(url, {jsonrpc: "2.0", id: ++id, method, params}, options)) as RpcResponse;
      if (response.error) {
        const err = new Error(response.error.message ?? "RPC error") as Error & {code?: number};
        err.code = response.error.code;
        throw err;
      }
      return response.result;
    },
  });
}

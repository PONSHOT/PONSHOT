import {NextResponse} from "next/server";

/**
 * Same-origin JSON-RPC proxy.
 *
 * This is a route handler rather than a `next.config.mjs` rewrite because rewrites are
 * **baked into the routes manifest at build time**. Pointing one at an RPC URL supplied
 * through the runtime environment silently keeps whatever value was present during the
 * build — which is how a production deploy ended up proxying to a local devnet that no
 * longer existed, returning 500 for every read while every other check looked healthy.
 *
 * Reading the target per request costs nothing and cannot drift from the environment the
 * process is actually running in.
 */
export const dynamic = "force-dynamic";

const UPSTREAM = () =>
  process.env.RPC_PROXY_TARGET ?? process.env.NEXT_PUBLIC_UPSTREAM_RPC ?? "http://127.0.0.1:8545";

/**
 * Read-only method allowlist.
 *
 * The browser needs this proxy for *reads*; transactions are signed and broadcast by the
 * user's own wallet, which talks to its own provider and never comes through here. So
 * there is no reason to forward anything that writes, and every reason not to — an
 * unrestricted proxy is an open relay for whoever finds the URL.
 */
const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_getLogs",
  "eth_getStorageAt",
  "net_version",
  "web3_clientVersion",
]);

interface RpcCall {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

function rejected(id: RpcCall["id"], method: string | undefined) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {code: -32601, message: `method not proxied: ${method ?? "(none)"}`},
  };
}

export async function POST(request: Request) {
  let body: RpcCall | RpcCall[];
  try {
    body = (await request.json()) as RpcCall | RpcCall[];
  } catch {
    return NextResponse.json({jsonrpc: "2.0", id: null, error: {code: -32700, message: "parse error"}}, {status: 400});
  }

  // Batches are normal for viem's multicall path, so they have to be handled — and every
  // member checked, not just the first.
  const calls = Array.isArray(body) ? body : [body];
  const blocked = calls.filter((c) => !c.method || !ALLOWED.has(c.method));
  if (blocked.length > 0) {
    const errors = blocked.map((c) => rejected(c.id, c.method));
    return NextResponse.json(Array.isArray(body) ? errors : errors[0], {status: 200});
  }

  try {
    const upstream = await fetch(UPSTREAM(), {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body),
      // Long enough for a slow archival read, short enough that a hung node does not
      // pin a connection indefinitely.
      signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {"content-type": "application/json"},
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream request failed";
    return NextResponse.json(
      {jsonrpc: "2.0", id: null, error: {code: -32603, message: `upstream unreachable: ${message}`}},
      {status: 502}
    );
  }
}

/** A plain GET is a person checking the endpoint by hand; say what it is. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    note: "JSON-RPC proxy. POST read-only calls here; transactions go through your wallet.",
  });
}

import type {IncomingMessage, ServerResponse} from "node:http";

/**
 * Tiny path router.
 *
 * Deliberately dependency-free: this service only ever reads, so a framework would add
 * supply-chain surface for routing that fits in fifty lines.
 */
export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  req: IncomingMessage;
}

type Handler = (ctx: Ctx) => Promise<unknown>;

interface Route {
  pattern: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  get(pattern: string, handler: Handler): this {
    this.routes.push({pattern: pattern.split("/").filter(Boolean), handler});
    return this;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const segments = url.pathname.split("/").filter(Boolean);

    res.setHeader("access-control-allow-origin", process.env.CORS_ORIGIN ?? "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET") {
      // Read model only: there is no write path here by design, so a non-GET is a
      // client mistake rather than an unimplemented feature.
      send(res, 405, {error: "this API is read-only"});
      return;
    }

    for (const route of this.routes) {
      const params = match(route.pattern, segments);
      if (!params) continue;
      try {
        const body = await route.handler({params, query: url.searchParams, req});
        send(res, 200, body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = /not found/i.test(message) ? 404 : /invalid|bad /i.test(message) ? 400 : 500;
        if (status === 500) console.error(JSON.stringify({level: "error", msg: "request failed", path: url.pathname, err: message}));
        send(res, status, {error: message});
      }
      return;
    }
    send(res, 404, {error: "not found"});
  }
}

function match(pattern: string[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const seg = segments[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(seg);
    else if (p !== seg) return null;
  }
  return params;
}

/** BigInt is serialised as a string; a JSON number would lose wei precision. */
export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {"content-type": "application/json; charset=utf-8"});
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

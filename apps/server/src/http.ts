import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { ZodError, z } from 'zod';
import { HermesError, redact, redactString, errorMessage } from '@hermes/core';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;
/** WebSocket upgrade handler: authenticates the request itself (browsers cannot send Authorization). */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly upgrades = new Map<string, UpgradeHandler>();

  ws(path: string, handler: UpgradeHandler): this {
    this.upgrades.set(path, handler);
    return this;
  }

  matchUpgrade(path: string): UpgradeHandler | null {
    return this.upgrades.get(path) ?? null;
  }

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (m)
        return {
          handler: r.handler,
          params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])),
        };
    }
    return null;
  }
}

/** Marker for handlers that wrote the response themselves (SSE, files). */
export const HANDLED = Symbol('handled');

const STATUS: Record<string, number> = {
  VALIDATION: 400,
  CONFIG: 400,
  PLAN_INVALID: 422,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  COLLISION: 409,
  POLICY_DENIED: 403,
  APPROVAL_MISMATCH: 409,
  EMERGENCY_STOP: 423,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(redact(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HermesError('VALIDATION', 'Corps de requête trop volumineux');
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HermesError('VALIDATION', 'JSON invalide');
  }
}

function tokenOk(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Ends a refused upgrade with a plain HTTP status (no WebSocket is opened). */
export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message } });
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Forbidden'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

export function createHttpServer(
  router: Router,
  opts: { token: string; allowedOrigins: string[]; onError: (err: unknown) => void },
) {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const originAllowed = origin !== undefined && opts.allowedOrigins.includes(origin);
    if (originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(originAllowed ? 204 : 403).end();
      return;
    }
    // DNS-rebinding protection: only loopback host names are served.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host))
      return send(res, 403, { error: { code: 'FORBIDDEN', message: 'Hôte refusé' } });
    if (origin && !originAllowed)
      return send(res, 403, { error: { code: 'FORBIDDEN', message: 'Origine refusée' } });
    if (!tokenOk(req.headers.authorization, opts.token))
      return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Jeton de session invalide' } });

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = router.match(req.method ?? 'GET', url.pathname);
    if (!match)
      return send(res, 404, {
        error: { code: 'NOT_FOUND', message: `Route inconnue : ${req.method} ${url.pathname}` },
      });
    try {
      const body = await readBody(req);
      const out = await match.handler({ req, res, params: match.params, query: url.searchParams, body });
      if (out === HANDLED) return;
      send(res, 200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof ZodError)
        return send(res, 400, { error: { code: 'VALIDATION', message: z.prettifyError(err) } });
      const code = err instanceof HermesError ? err.code : 'INTERNAL';
      const status = STATUS[code] ?? (code === 'PROVIDER' ? 502 : 500);
      if (status >= 500) opts.onError(err);
      if (!res.headersSent) send(res, status, { error: { code, message: redactString(errorMessage(err)) } });
    }
  });
  // Same host and origin rules as HTTP; the route then checks its own single-use ticket.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return rejectUpgrade(socket, 403, 'Hôte refusé');
    const origin = req.headers.origin;
    if (origin !== undefined && !opts.allowedOrigins.includes(origin))
      return rejectUpgrade(socket, 403, 'Origine refusée');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handler = router.matchUpgrade(url.pathname);
    if (!handler) return rejectUpgrade(socket, 404, 'Route inconnue');
    try {
      handler(req, socket, head, url);
    } catch (err) {
      opts.onError(err);
      socket.destroy();
    }
  });
  return server;
}

/**
 * SIMULATED Gemini Live (BidiGenerateContent) for automated tests. It reproduces the documented wire
 * format (setup / setupComplete / realtimeInput / serverContent / toolCall / toolResponse / goAway);
 * it proves nothing about the real service, its voices or its latency.
 */
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { WebSocketFactory, WebSocketLike } from '@hermes/core';

// ------------------------------------------------------------------ in-memory socket (unit tests)

export class FakeLiveSocket implements WebSocketLike {
  readyState = 0;
  binaryType = 'blob';
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  /** Server → client frame; Google sends JSON in binary frames, so that is the default here. */
  emit(msg: unknown, binary = true): void {
    const text = JSON.stringify(msg);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  of<K extends string>(kind: K): Record<string, unknown>[] {
    return this.sent.filter((m) => kind in m).map((m) => m[kind] as Record<string, unknown>);
  }
}

export type SetupReply = 'complete' | { close: number; reason: string } | 'silent';

/** Factory whose sockets open asynchronously and answer `setup` according to `reply(attempt)`. */
export function fakeLiveFactory(reply: (attempt: number) => SetupReply = () => 'complete') {
  const sockets: FakeLiveSocket[] = [];
  const factory: WebSocketFactory = (url, headers) => {
    const s = new FakeLiveSocket(url, headers);
    const attempt = sockets.length;
    sockets.push(s);
    const send = s.send.bind(s);
    s.send = (data: string) => {
      send(data);
      const msg = JSON.parse(data) as Record<string, unknown>;
      if (!('setup' in msg)) return;
      const r = reply(attempt);
      setTimeout(() => {
        if (r === 'complete') s.emit({ setupComplete: {} });
        else if (r !== 'silent') s.serverClose(r.close, r.reason);
      }, 0);
    };
    setTimeout(() => {
      s.readyState = 1;
      s.onopen?.({});
    }, 0);
    return s;
  };
  return { factory, sockets, last: () => sockets.at(-1)! };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ real WebSocket server (integration / E2E)

export interface LiveScript {
  /** Called for every client frame after setup; `reply` sends a server frame on that connection. */
  onMessage?: (
    msg: Record<string, unknown>,
    reply: (m: unknown) => void,
    state: { audioChunks: number },
  ) => void;
  /** Rejects connections whose x-goog-api-key differs (as the real API does with code 1007). */
  expectedKey?: string;
}

export async function startMockLiveServer(script: LiveScript = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const received: Record<string, unknown>[] = [];
  const headers: Record<string, string | undefined>[] = [];
  wss.on('connection', (ws: WsSocket, req) => {
    headers.push({ key: req.headers['x-goog-api-key'] as string | undefined, url: req.url });
    const state = { audioChunks: 0 };
    const reply = (m: unknown) => ws.send(Buffer.from(JSON.stringify(m)));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(msg);
      if ('setup' in msg) {
        if (script.expectedKey && req.headers['x-goog-api-key'] !== script.expectedKey)
          return ws.close(1007, 'API key not valid. Please pass a valid API key.');
        return reply({ setupComplete: {} });
      }
      if ((msg.realtimeInput as { audio?: unknown } | undefined)?.audio) state.audioChunks++;
      script.onMessage?.(msg, reply, state);
    });
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
    received,
    headers,
    close: () =>
      new Promise<void>((r) => {
        // ws ≥ 8 keeps existing connections open on close(): end them so the server can stop.
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}

/** A short 24 kHz PCM16 sine tone, base64-encoded as the Live API returns audio. */
export function toneBase64(ms = 100, hz = 440): string {
  const n = Math.round((24_000 * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 24_000) * 8000), i * 2);
  return buf.toString('base64');
}

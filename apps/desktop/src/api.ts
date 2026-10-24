import { invoke } from '@tauri-apps/api/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Backend {
  url: string;
  token: string | null;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let backend: Promise<Backend> | null = null;

/**
 * Desktop: the Tauri shell owns the local server and hands out its URL and session token.
 * Development in a browser: requests go through the Vite proxy, which adds the token itself.
 */
function getBackend(): Promise<Backend> {
  if (!backend) {
    backend = isTauri ? invoke<Backend>('backend_info') : Promise.resolve({ url: '', token: null });
    backend.catch(() => (backend = null));
  }
  return backend;
}

async function headers(json: boolean): Promise<{ url: string; headers: Record<string, string> }> {
  const b = await getBackend();
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (b.token) h.Authorization = `Bearer ${b.token}`;
  return { url: b.url, headers: h };
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { url, headers: h } = await headers(init.body !== undefined);
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: h,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    throw new ApiError(
      0,
      'UNREACHABLE',
      `Service local HERMES injoignable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, e?.error?.code ?? 'HTTP', e?.error?.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

/** Downloads an authenticated resource (images, reports) as an object URL. */
export async function apiBlobUrl(path: string): Promise<string> {
  const { url, headers: h } = await headers(false);
  const res = await fetch(`${url}${path}`, { headers: h });
  if (!res.ok) throw new ApiError(res.status, 'HTTP', res.statusText);
  return URL.createObjectURL(await res.blob());
}

export async function downloadFile(path: string, filename: string): Promise<void> {
  const href = await apiBlobUrl(path);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export function downloadJson(data: unknown, filename: string): void {
  const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export type StreamMessage = { event: string; data: unknown };

/** Server-sent events over fetch (EventSource cannot send the Authorization header). Reconnects. */
export function subscribe(
  onMessage: (m: StreamMessage) => void,
  onState: (connected: boolean) => void,
): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const { url, headers: h } = await headers(false);
        const res = await fetch(`${url}/api/stream`, { headers: h, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onState(true);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (data) {
              try {
                onMessage({ event, data: JSON.parse(data) });
              } catch {
                /* malformed frame: ignored, the next refresh resynchronises state */
              }
            }
          }
        }
      } catch {
        /* reconnect below */
      }
      onState(false);
      if (!stopped) await new Promise((r) => setTimeout(r, 2000));
    }
  };
  void run();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

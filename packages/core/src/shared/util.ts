import { createHash, randomUUID } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export const nowIso = (): string => new Date().toISOString();

/** Trusted clock facts given to models: they cannot know today's date by themselves. */
export function clockContext(d = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    d,
  );
  const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(d);
  return `Date locale du système (fiable) : ${date}, ${time}, fuseau ${tz}`;
}

/** Stable JSON (sorted keys) so equal inputs always hash identically. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const hashInput = (toolId: string, input: unknown): string =>
  sha256(`${toolId}\n${stableStringify(input)}`);

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

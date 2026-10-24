// Uses a SIMULATED OpenRouter (mockFetch): validates HERMES' client logic, not the real API.
import { describe, expect, it } from 'vitest';
import {
  OpenRouterProvider,
  ProviderError,
  backoffMs,
  classifyHttpError,
  validateBaseUrl,
} from '@hermes/core';
import { chatCompletion, mockFetch, toSse, type MockReply } from '../helpers/mock-openrouter';
import { TEST_KEY } from '../helpers/runtime';

const provider = (
  handler: (path: string, body: unknown) => MockReply | Promise<MockReply>,
  over: Partial<ConstructorParameters<typeof OpenRouterProvider>[0]> = {},
) => {
  const m = mockFetch(handler);
  return {
    p: new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      getApiKey: async () => TEST_KEY,
      timeoutMs: 2000,
      maxRetries: 2,
      fetchImpl: m.fetchImpl,
      ...over,
    }),
    calls: m.calls,
  };
};
const ok = (body: unknown): MockReply => ({
  json: chatCompletion((body as { model: string }).model, { content: 'bonjour' }),
});
const msg = [{ role: 'user' as const, content: 'salut' }];

describe('validation de l’URL de base', () => {
  it('n’accepte que https://openrouter.ai/api/v1', () => {
    expect(validateBaseUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
    expect(() => validateBaseUrl('https://evil.example/api/v1')).toThrow(/non autorisé/);
    expect(() => validateBaseUrl('http://openrouter.ai/api/v1')).toThrow(/HTTPS/);
    expect(() => validateBaseUrl('https://openrouter.ai.evil.net/api/v1')).toThrow();
    expect(() => validateBaseUrl('https://user:pw@openrouter.ai/api/v1')).toThrow();
    expect(() => validateBaseUrl('https://openrouter.ai/other')).toThrow();
    expect(() => validateBaseUrl('http://127.0.0.1:9999/api/v1')).toThrow();
    expect(validateBaseUrl('http://127.0.0.1:9999/api/v1', { allowLoopbackForTests: true })).toBe(
      'http://127.0.0.1:9999/api/v1',
    );
  });
});

describe('classification des erreurs', () => {
  it.each([
    [401, 'auth_invalid', false],
    [402, 'insufficient_credits', false],
    [403, 'forbidden', false],
    [404, 'model_unavailable', false],
    [408, 'timeout', true],
    [429, 'rate_limited', true],
    [500, 'provider_error', true],
    [502, 'provider_error', true],
    [503, 'model_unavailable', false],
    [400, 'bad_request', false],
  ])('HTTP %i → %s', (status, kind, retryable) => {
    const e = classifyHttpError(status, { error: { message: 'x' } });
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
  });
  it('lit Retry-After et borne la temporisation', () => {
    expect(classifyHttpError(429, null, '3').retryAfterMs).toBe(3000);
    expect(backoffMs(0, null, () => 0)).toBe(250);
    expect(backoffMs(10, null, () => 1)).toBe(8000);
  });
});

describe('client OpenRouter (simulé)', () => {
  it('envoie la clé uniquement à OpenRouter et lit l’usage', async () => {
    const { p, calls } = provider((_, b) => ok(b));
    const r = await p.chat({ model: 'a/b', messages: msg });
    expect(r.content).toBe('bonjour');
    expect(r.usage.costUsd).toBe(0.0001);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]!.authorization).toBe(`Bearer ${TEST_KEY}`);
  });
  it('erreur de configuration sans clé, sans appel réseau', async () => {
    const { p, calls } = provider((_, b) => ok(b), { getApiKey: async () => null });
    await expect(p.chat({ model: 'a/b', messages: msg })).rejects.toMatchObject({ kind: 'config_missing' });
    expect(calls).toHaveLength(0);
  });
  it('réessaie les erreurs récupérables (429 puis succès)', async () => {
    let n = 0;
    const { p } = provider((_, b) =>
      n++ === 0
        ? { status: 429, json: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } }
        : ok(b),
    );
    const r = await p.chat({ model: 'a/b', messages: msg });
    expect(r.attempts).toBe(2);
  });
  it('ne réessaie pas 401/402 et ne bascule pas sur un modèle de secours', async () => {
    for (const status of [401, 402]) {
      const { p, calls } = provider(() => ({ status, json: { error: { message: 'non' } } }));
      await expect(p.chat({ model: 'a/b', fallbackModels: ['c/d'], messages: msg })).rejects.toBeInstanceOf(
        ProviderError,
      );
      expect(calls).toHaveLength(1);
    }
  });
  it('bascule sur le modèle de secours si le modèle est indisponible', async () => {
    const { p, calls } = provider((_, b) =>
      (b as { model: string }).model === 'a/b'
        ? { status: 404, json: { error: { message: 'No endpoints found' } } }
        : ok(b),
    );
    const r = await p.chat({ model: 'a/b', fallbackModels: ['c/d'], messages: msg });
    expect(r.model).toBe('c/d');
    expect(calls.map((c) => (c.body as { model: string }).model)).toEqual(['a/b', 'c/d']);
  });
  it('limite le nombre de tentatives', async () => {
    const { p, calls } = provider(
      () => ({ status: 502, json: { error: { message: 'down' } }, headers: { 'retry-after': '0' } }),
      { maxRetries: 1 },
    );
    await expect(p.chat({ model: 'a/b', messages: msg })).rejects.toMatchObject({ kind: 'provider_error' });
    expect(calls).toHaveLength(2);
  });
  it('gère le délai maximal et l’annulation', async () => {
    const slow = () => new Promise<MockReply>((r) => setTimeout(() => r({ json: {} }), 5000));
    const { p } = provider(slow, { timeoutMs: 100, maxRetries: 0, fetchImpl: undefined });
    void p;
    const m = mockFetch(slow);
    const timed = new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      getApiKey: async () => TEST_KEY,
      timeoutMs: 100,
      maxRetries: 0,
      fetchImpl: ((u: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          void m.fetchImpl(u, init).then(resolve, reject);
        })) as typeof fetch,
    });
    await expect(timed.chat({ model: 'a/b', messages: msg })).rejects.toMatchObject({ kind: 'timeout' });
    const ctrl = new AbortController();
    const pending = timed.chat({ model: 'a/b', messages: msg }, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
  });
  it('rejette une réponse mal formée', async () => {
    const { p } = provider(() => ({ json: { nothing: true } }), { maxRetries: 0 });
    await expect(p.chat({ model: 'a/b', messages: msg })).rejects.toMatchObject({
      kind: 'malformed_response',
    });
  });
  it('lit un flux SSE avec contenu et appels d’outils fragmentés', async () => {
    const completion = chatCompletion(
      'a/b',
      {
        content: 'Je vais chercher.',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'files__search', arguments: '{"root":"C:\\\\x"}' },
          },
        ],
      },
      'tool_calls',
    );
    const { p } = provider(() => ({ sse: toSse(completion) }));
    const deltas: string[] = [];
    const r = await p.chat({ model: 'a/b', messages: msg }, { stream: true, onDelta: (d) => deltas.push(d) });
    expect(deltas.join('')).toBe('Je vais chercher.');
    expect(r.toolCalls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'files__search', arguments: '{"root":"C:\\\\x"}' } },
    ]);
    expect(r.incomplete).toBe(false);
    expect(r.usage.promptTokens).toBe(100);
  });
  it('signale un flux interrompu comme incomplet et une erreur en cours de flux', async () => {
    const { p } = provider(() => ({
      sse: 'data: {"choices":[{"index":0,"delta":{"content":"début"}}]}\n\n',
    }));
    const r = await p.chat({ model: 'a/b', messages: msg }, { stream: true });
    expect(r.incomplete).toBe(true);
    const { p: p2 } = provider(() => ({
      sse: 'data: {"error":{"code":402,"message":"no credits"},"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\n',
    }));
    await expect(p2.chat({ model: 'a/b', messages: msg }, { stream: true })).rejects.toMatchObject({
      kind: 'insufficient_credits',
    });
  });
  it('extrait les citations Web', async () => {
    const { p } = provider((_, b) => ({
      json: chatCompletion((b as { model: string }).model, {
        content: 'r',
        annotations: [
          {
            type: 'url_citation',
            url_citation: { url: 'https://src.example', title: 'Source', content: 'extrait' },
          },
        ],
      }),
    }));
    const r = await p.chat({ model: 'a/b', messages: msg, plugins: [{ id: 'web' }] });
    expect(r.citations).toEqual([{ url: 'https://src.example', title: 'Source', content: 'extrait' }]);
  });
});

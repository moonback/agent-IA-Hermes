// SIMULATED Tavily and Brave APIs (documented request/response formats). Real calls were not
// possible from the development environment (hosts blocked); nothing here proves the live APIs.
import { describe, expect, it } from 'vitest';
import {
  BraveSearchProvider,
  SearchError,
  SearchProviderRegistry,
  SearchSettings,
  TavilySearchProvider,
  type SearchProvider,
} from '@hermes/core';

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
function mock(handler: (url: URL, init: RequestInit) => Reply) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const signal = () => new AbortController().signal;
const key = (k: string | null) => async () => k;

describe('Tavily (simulé)', () => {
  it('envoie la requête documentée (Bearer) et lit sources et réponse', async () => {
    const m = mock(() => ({
      json: {
        answer: 'Le BTC vaut environ 1 €.',
        results: [
          { url: 'https://a.example', title: 'A', content: 'extrait A', score: 0.9 },
          { url: 'https://b.example', title: 'B', content: 'extrait B' },
          { title: 'sans url' },
        ],
      },
    }));
    const p = new TavilySearchProvider({ getKey: key('tvly-test-0123456789'), fetchImpl: m.fetchImpl });
    const r = await p.search('cours du bitcoin', 3, signal());
    expect(m.calls[0]!.url.href).toBe('https://api.tavily.com/search');
    expect(new Headers(m.calls[0]!.init.headers).get('authorization')).toBe('Bearer tvly-test-0123456789');
    expect(JSON.parse(String(m.calls[0]!.init.body))).toEqual({
      query: 'cours du bitcoin',
      max_results: 3,
      search_depth: 'basic',
      include_answer: true,
    });
    expect(r).toEqual({
      provider: 'tavily',
      answer: 'Le BTC vaut environ 1 €.',
      answerIsModelSynthesis: true,
      sources: [
        { url: 'https://a.example', title: 'A', snippet: 'extrait A' },
        { url: 'https://b.example', title: 'B', snippet: 'extrait B' },
      ],
    });
  });
  it.each([
    [401, 'auth'],
    [432, 'quota'],
    [433, 'quota'],
    [429, 'rate_limited'],
    [500, 'provider'],
    [400, 'bad_request'],
  ])('HTTP %i → %s', async (status, kind) => {
    const m = mock(() => ({ status, json: { detail: { error: 'x' } } }));
    const p = new TavilySearchProvider({ getKey: key('tvly-k'), fetchImpl: m.fetchImpl });
    await expect(p.search('q', 3, signal())).rejects.toMatchObject({ kind, provider: 'tavily' });
  });
  it('sans clé : indisponible, sans appel réseau', async () => {
    const m = mock(() => ({}));
    const p = new TavilySearchProvider({ getKey: key(null), fetchImpl: m.fetchImpl });
    expect(await p.availability()).toEqual({ available: false, reason: 'Clé Tavily absente' });
    await expect(p.search('q', 3, signal())).rejects.toMatchObject({ kind: 'auth' });
    expect(m.calls).toHaveLength(0);
  });
});

describe('Brave Search (simulé)', () => {
  it('envoie la requête documentée (X-Subscription-Token) ; résultats bruts, sans synthèse', async () => {
    const m = mock(() => ({
      json: { web: { results: [{ url: 'https://c.example', title: 'C', description: 'desc C' }] } },
    }));
    const p = new BraveSearchProvider({ getKey: key('BSA-test'), fetchImpl: m.fetchImpl });
    const r = await p.search('météo Lyon', 5, signal());
    expect(m.calls[0]!.url.origin + m.calls[0]!.url.pathname).toBe(
      'https://api.search.brave.com/res/v1/web/search',
    );
    expect(m.calls[0]!.url.searchParams.get('q')).toBe('météo Lyon');
    expect(m.calls[0]!.url.searchParams.get('count')).toBe('5');
    expect(new Headers(m.calls[0]!.init.headers).get('x-subscription-token')).toBe('BSA-test');
    expect(r).toMatchObject({
      provider: 'brave',
      answerIsModelSynthesis: false,
      sources: [{ url: 'https://c.example', title: 'C', snippet: 'desc C' }],
    });
  });
  it('distingue limite de débit et quota mensuel épuisé (en-têtes Brave)', async () => {
    const rate = mock(() => ({
      status: 429,
      headers: { 'x-ratelimit-remaining': '0, 1500', 'retry-after': '2' },
    }));
    const e1 = await new BraveSearchProvider({ getKey: key('k'), fetchImpl: rate.fetchImpl })
      .search('q', 3, signal())
      .catch((e: SearchError) => e);
    expect(e1).toMatchObject({ kind: 'rate_limited', retryAfterMs: 2000 });
    const quota = mock(() => ({ status: 429, headers: { 'x-ratelimit-remaining': '0, 0' } }));
    const e2 = await new BraveSearchProvider({ getKey: key('k'), fetchImpl: quota.fetchImpl })
      .search('q', 3, signal())
      .catch((e: SearchError) => e);
    expect(e2).toMatchObject({ kind: 'quota' });
  });
});

describe('SearchProviderRegistry', () => {
  const fake = (
    id: string,
    behaviour: () => Promise<unknown>,
    avail = true,
  ): SearchProvider & { calls: number } => {
    const p = {
      id,
      calls: 0,
      availability: async () =>
        avail ? { available: true } : { available: false, reason: `${id} sans clé` },
      search: async () => {
        p.calls++;
        await behaviour();
        return {
          provider: id,
          answer: '',
          answerIsModelSynthesis: false,
          sources: [{ url: `https://${id}.example`, title: null, snippet: null }],
        };
      },
    };
    return p;
  };
  const ok = () => Promise.resolve();
  const fail =
    (kind: ConstructorParameters<typeof SearchError>[0], id: string, retry: number | null = null) =>
    () =>
      Promise.reject(new SearchError(kind, id, 'échec', retry));

  it('mode auto : saute un fournisseur sans clé et respecte l’ordre', async () => {
    const tavily = fake('tavily', ok, false);
    const brave = fake('brave', ok);
    const reg = new SearchProviderRegistry(
      new Map([
        ['tavily', tavily],
        ['brave', brave],
      ]),
      () => SearchSettings.parse({ provider: 'auto' }),
    );
    expect((await reg.search('q', 3, signal())).provider).toBe('brave');
    expect(tavily.calls).toBe(0);
  });
  it('bascule sur le suivant en cas de quota, puis met le premier en pause jusqu’à expiration', async () => {
    let now = 1_000_000;
    let tavilyDown = true;
    const tavily = fake('tavily', () => (tavilyDown ? fail('quota', 'tavily')() : ok()));
    const brave = fake('brave', ok);
    const reg = new SearchProviderRegistry(
      new Map([
        ['tavily', tavily],
        ['brave', brave],
      ]),
      () => SearchSettings.parse({ provider: 'auto' }),
      () => now,
    );
    expect((await reg.search('q', 3, signal())).provider).toBe('brave');
    expect((await reg.search('q', 3, signal())).provider).toBe('brave');
    expect(tavily.calls).toBe(1); // cooling down: not retried
    const st = await reg.states();
    expect(st.find((s) => s.id === 'tavily')).toMatchObject({
      available: false,
      cooldownUntil: expect.any(String),
    });
    now += 6 * 3_600_000 + 1;
    tavilyDown = false;
    expect((await reg.search('q', 3, signal())).provider).toBe('tavily');
  });
  it('utilise Retry-After pour une limite de débit', async () => {
    let now = 0;
    const tavily = fake('tavily', fail('rate_limited', 'tavily', 5_000));
    const reg = new SearchProviderRegistry(
      new Map([['tavily', tavily]]),
      () => SearchSettings.parse({ provider: 'tavily' }),
      () => now,
    );
    await expect(reg.search('q', 3, signal())).rejects.toThrow(/Aucun fournisseur de recherche n’a répondu/);
    expect((await reg.availability()).available).toBe(false);
    now = 5_001;
    expect((await reg.availability()).available).toBe(true);
  });
  it('fournisseur fixé : pas de bascule ; requête invalide : erreur immédiate ; aucun : indisponible', async () => {
    const tavily = fake('tavily', fail('provider', 'tavily'));
    const brave = fake('brave', ok);
    const fixed = new SearchProviderRegistry(
      new Map([
        ['tavily', tavily],
        ['brave', brave],
      ]),
      () => SearchSettings.parse({ provider: 'tavily' }),
    );
    await expect(fixed.search('q', 3, signal())).rejects.toThrow();
    expect(brave.calls).toBe(0);
    const bad = new SearchProviderRegistry(
      new Map([
        ['tavily', fake('tavily', fail('bad_request', 'tavily'))],
        ['brave', brave],
      ]),
      () => SearchSettings.parse({ provider: 'auto' }),
    );
    await expect(bad.search('q', 3, signal())).rejects.toMatchObject({ kind: 'bad_request' });
    expect(brave.calls).toBe(0);
    const none = new SearchProviderRegistry(new Map(), () => SearchSettings.parse({}));
    expect(await none.availability()).toMatchObject({ available: false, reason: /Aucun fournisseur/ });
  });
});

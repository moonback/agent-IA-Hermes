import { z } from 'zod';
import { HermesError, errorMessage } from '../shared/errors';
import { redactString } from '../shared/redact';
import type { Availability } from './types';
import type { SearchProvider, SearchResult } from './web-search';

/**
 * Web search APIs (Tavily, Brave) and the registry that picks one: by preference, availability
 * (key present) and quota (providers that hit a rate or plan limit cool down, then come back).
 */

export const TAVILY_KEY_NAME = 'TAVILY_API_KEY';
export const BRAVE_KEY_NAME = 'BRAVE_API_KEY';
const TAVILY_URL = 'https://api.tavily.com/search';
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';

export type SearchErrorKind = 'auth' | 'quota' | 'rate_limited' | 'network' | 'provider' | 'bad_request';

export class SearchError extends HermesError {
  constructor(
    readonly kind: SearchErrorKind,
    readonly provider: string,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super('TOOL_FAILED', redactString(`${provider} : ${message}`), { kind, provider });
    this.name = 'SearchError';
  }
  /** Worth trying another provider (the query itself is not at fault). */
  get fallback(): boolean {
    return this.kind !== 'bad_request';
  }
}

interface HttpDeps {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function request(id: string, deps: HttpDeps, url: string, init: RequestInit, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 30_000);
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.any([signal, timeout]) });
  } catch (err) {
    if (signal.aborted) throw new HermesError('CANCELLED', 'Recherche annulée');
    throw new SearchError(
      'network',
      id,
      timeout.aborted ? 'délai dépassé' : `erreur réseau (${errorMessage(err)})`,
    );
  }
}

function retryAfter(res: Response): number | null {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 3_600_000) : null;
}

async function classify(id: string, res: Response): Promise<SearchError> {
  const body = (await res.text().catch(() => '')).slice(0, 300);
  const detail = body ? ` — ${body}` : '';
  if (res.status === 401 || res.status === 403)
    return new SearchError('auth', id, `clé refusée (${res.status})${detail}`);
  // Tavily: 432 = plan limit, 433 = pay-as-you-go limit. Brave: 429 with an exhausted monthly quota.
  if (res.status === 432 || res.status === 433 || res.status === 402)
    return new SearchError('quota', id, `quota du forfait épuisé (${res.status})${detail}`);
  if (res.status === 429) {
    const monthly = res.headers.get('x-ratelimit-remaining')?.split(',')[1]?.trim();
    if (monthly === '0') return new SearchError('quota', id, 'quota mensuel épuisé (429)', retryAfter(res));
    return new SearchError('rate_limited', id, `limite de débit (429)${detail}`, retryAfter(res));
  }
  if (res.status >= 500) return new SearchError('provider', id, `erreur du service (${res.status})`);
  return new SearchError('bad_request', id, `requête refusée (${res.status})${detail}`);
}

/** Tavily: search API built for agents; returns sources and an answer written by Tavily's model. */
export class TavilySearchProvider implements SearchProvider {
  readonly id = 'tavily';
  constructor(private readonly deps: HttpDeps) {}

  async availability(): Promise<Availability> {
    return (await this.deps.getKey())
      ? { available: true }
      : { available: false, reason: 'Clé Tavily absente' };
  }

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult> {
    const key = await this.deps.getKey();
    if (!key) throw new SearchError('auth', this.id, 'clé absente');
    const res = await request(
      this.id,
      this.deps,
      TAVILY_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: true }),
      },
      signal,
    );
    if (!res.ok) throw await classify(this.id, res);
    const data = (await res.json().catch(() => null)) as {
      answer?: unknown;
      results?: { url?: unknown; title?: unknown; content?: unknown }[];
    } | null;
    if (!data || !Array.isArray(data.results))
      throw new SearchError('provider', this.id, 'réponse illisible');
    return {
      provider: this.id,
      answer: typeof data.answer === 'string' ? data.answer : '',
      answerIsModelSynthesis: typeof data.answer === 'string' && data.answer.length > 0,
      sources: data.results.flatMap((r) =>
        typeof r.url === 'string'
          ? [
              {
                url: r.url,
                title: typeof r.title === 'string' ? r.title : null,
                snippet: typeof r.content === 'string' ? r.content.slice(0, 500) : null,
              },
            ]
          : [],
      ),
    };
  }
}

/** Brave Search: an independent web index; raw results, no generated answer. */
export class BraveSearchProvider implements SearchProvider {
  readonly id = 'brave';
  constructor(private readonly deps: HttpDeps) {}

  async availability(): Promise<Availability> {
    return (await this.deps.getKey())
      ? { available: true }
      : { available: false, reason: 'Clé Brave Search absente' };
  }

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult> {
    const key = await this.deps.getKey();
    if (!key) throw new SearchError('auth', this.id, 'clé absente');
    const url = `${BRAVE_URL}?${new URLSearchParams({ q: query, count: String(Math.min(maxResults, 20)), text_decorations: 'false' })}`;
    const res = await request(
      this.id,
      this.deps,
      url,
      { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } },
      signal,
    );
    if (!res.ok) throw await classify(this.id, res);
    const data = (await res.json().catch(() => null)) as {
      web?: { results?: { url?: unknown; title?: unknown; description?: unknown }[] };
    } | null;
    if (!data) throw new SearchError('provider', this.id, 'réponse illisible');
    const sources = (data.web?.results ?? []).flatMap((r) =>
      typeof r.url === 'string'
        ? [
            {
              url: r.url,
              title: typeof r.title === 'string' ? r.title : null,
              snippet: typeof r.description === 'string' ? r.description.slice(0, 500) : null,
            },
          ]
        : [],
    );
    return {
      provider: this.id,
      // No synthesis: the "answer" only lists what was found, so nothing reads as a verified conclusion.
      answer: sources.length ? `${sources.length} résultat(s) Brave Search (pas de synthèse).` : '',
      answerIsModelSynthesis: false,
      sources,
    };
  }
}

export const SEARCH_PROVIDER_IDS = ['tavily', 'brave', 'openrouter-web'] as const;
export const SearchSettings = z.object({
  /** 'auto' tries, in order, every provider that is configured and not cooling down. */
  provider: z.enum(['auto', 'none', ...SEARCH_PROVIDER_IDS]).default('none'),
  order: z.array(z.enum(SEARCH_PROVIDER_IDS)).default(['tavily', 'brave', 'openrouter-web']),
});
export type SearchSettings = z.infer<typeof SearchSettings>;

export interface ProviderState {
  id: string;
  available: boolean;
  reason: string | null;
  cooldownUntil: string | null;
  lastError: string | null;
}

const COOLDOWN_MS: Record<SearchErrorKind, number> = {
  rate_limited: 60_000,
  quota: 6 * 3_600_000,
  auth: 15 * 60_000,
  network: 30_000,
  provider: 120_000,
  bad_request: 0,
};

/**
 * Chooses the search backend: a fixed one, or 'auto' with fallback. A provider that fails for a
 * reason other than the query itself cools down (rate limit: Retry-After or 1 min, exhausted quota:
 * 6 h, refused key: 15 min) and the next one is tried; the result names the provider that answered.
 */
export class SearchProviderRegistry implements SearchProvider {
  private readonly cooldown = new Map<string, { until: number; error: string }>();

  constructor(
    private readonly providers: ReadonlyMap<string, SearchProvider>,
    private readonly settings: () => SearchSettings,
    private readonly now: () => number = Date.now,
  ) {}

  get id(): string {
    return this.settings().provider;
  }

  private candidates(): string[] {
    const s = this.settings();
    if (s.provider === 'none') return [];
    if (s.provider === 'auto') return [...new Set(s.order)];
    return [s.provider];
  }

  private cooling(id: string): { until: number; error: string } | null {
    const c = this.cooldown.get(id);
    return c && c.until > this.now() ? c : null;
  }

  async states(): Promise<ProviderState[]> {
    return Promise.all(
      [...this.providers.keys()].map(async (id) => {
        const a = await this.providers.get(id)!.availability();
        const c = this.cooling(id);
        return {
          id,
          available: a.available && !c,
          reason: c
            ? `en pause jusqu’à ${new Date(c.until).toLocaleTimeString('fr-FR')} (${c.error})`
            : (a.reason ?? null),
          cooldownUntil: c ? new Date(c.until).toISOString() : null,
          lastError: this.cooldown.get(id)?.error ?? null,
        };
      }),
    );
  }

  async availability(): Promise<Availability> {
    const ids = this.candidates();
    if (!ids.length)
      return {
        available: false,
        reason: 'Aucun fournisseur de recherche Web configuré (Outils et permissions → Recherche Web)',
      };
    const reasons: string[] = [];
    for (const id of ids) {
      const p = this.providers.get(id);
      if (!p) continue;
      const c = this.cooling(id);
      if (c) {
        reasons.push(`${id} en pause (${c.error})`);
        continue;
      }
      const a = await p.availability();
      if (a.available) return { available: true };
      reasons.push(`${id} : ${a.reason ?? 'indisponible'}`);
    }
    return { available: false, reason: reasons.join(' ; ') || 'aucun fournisseur disponible' };
  }

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult> {
    const errors: string[] = [];
    for (const id of this.candidates()) {
      const p = this.providers.get(id);
      if (!p || this.cooling(id) || !(await p.availability()).available) continue;
      try {
        const r = await p.search(query, maxResults, signal);
        this.cooldown.delete(id);
        return r;
      } catch (err) {
        if (err instanceof SearchError) {
          if (!err.fallback) throw err;
          this.cooldown.set(id, {
            until: this.now() + (err.retryAfterMs ?? COOLDOWN_MS[err.kind]),
            error: err.message,
          });
          errors.push(err.message);
          continue;
        }
        if (signal.aborted) throw err;
        errors.push(`${id} : ${errorMessage(err)}`);
      }
    }
    throw new HermesError(
      'TOOL_UNAVAILABLE',
      errors.length
        ? `Aucun fournisseur de recherche n’a répondu : ${errors.join(' ; ')}`
        : 'Aucun fournisseur de recherche disponible',
    );
  }
}

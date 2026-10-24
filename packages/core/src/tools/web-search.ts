import { z } from 'zod';
import type { ModelProvider } from '../model-providers/types';
import { defineTool, type Availability } from './types';

export interface SearchSource {
  url: string;
  title: string | null;
  snippet: string | null;
}

export interface SearchResult {
  provider: string;
  answer: string;
  sources: SearchSource[];
}

/** Replaceable web search backend. */
export interface SearchProvider {
  readonly id: string;
  availability(): Promise<Availability>;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult>;
}

export class NoSearchProvider implements SearchProvider {
  readonly id = 'none';
  async availability(): Promise<Availability> {
    return {
      available: false,
      reason: 'Aucun fournisseur de recherche Web configuré (Outils et permissions → Recherche Web)',
    };
  }
  async search(): Promise<SearchResult> {
    throw new Error('Aucun fournisseur de recherche Web configuré');
  }
}

/**
 * Live web search through OpenRouter's "web" plugin. Sources are the url_citation annotations
 * returned by the API; nothing is invented when the API returns none. Billed by OpenRouter per request.
 */
export class OpenRouterWebSearchProvider implements SearchProvider {
  readonly id = 'openrouter-web';
  constructor(
    private readonly provider: ModelProvider,
    private readonly getModel: () => string | null,
  ) {}

  async availability(): Promise<Availability> {
    if (!(await this.provider.hasKey())) return { available: false, reason: 'Clé OpenRouter absente' };
    if (!this.getModel()) return { available: false, reason: 'Aucun modèle principal configuré' };
    return { available: true };
  }

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult> {
    const model = this.getModel();
    if (!model) throw new Error('Aucun modèle configuré pour la recherche');
    const res = await this.provider.chat(
      {
        model,
        plugins: [{ id: 'web', max_results: maxResults }],
        messages: [
          {
            role: 'system',
            content:
              'Résume factuellement les résultats de recherche Web trouvés, en citant les sources. Signale les contradictions.',
          },
          { role: 'user', content: query },
        ],
        maxTokens: 800,
      },
      { signal },
    );
    return {
      provider: this.id,
      answer: res.content,
      sources: res.citations.map((c) => ({
        url: c.url,
        title: c.title,
        snippet: c.content?.slice(0, 500) ?? null,
      })),
    };
  }
}

export const webSearch = defineTool({
  id: 'web.search',
  description:
    'Recherche Web en direct via le fournisseur configuré. Retourne une synthèse ET la liste des sources (URL, titre). Seules les sources retournées comptent comme preuves.',
  input: z.object({
    query: z.string().min(2).max(500),
    maxResults: z.number().int().min(1).max(10).default(5),
  }),
  output: z.object({
    provider: z.string(),
    query: z.string(),
    answer: z.string(),
    answerIsModelSynthesis: z.literal(true),
    sources: z.array(
      z.object({ url: z.string(), title: z.string().nullable(), snippet: z.string().nullable() }),
    ),
    retrievedAt: z.string(),
    warning: z.string().nullable(),
  }),
  allowedAgents: ['research'],
  permissions: ['network.search'],
  risk: 'low',
  timeoutMs: 90_000,
  reversible: true,
  idempotent: true,
  verification:
    'Les sources proviennent des annotations url_citation renvoyées par l’API ; une réponse sans source est signalée.',
  confirmation: 'Aucune (requête de recherche, facturée par le fournisseur).',
  availability: (s) => s.search.availability(),
  resources: () => ({}),
  async run(i, ctx) {
    const r = await ctx.services.search.search(i.query, i.maxResults, ctx.signal);
    return {
      provider: r.provider,
      query: i.query,
      answer: r.answer,
      answerIsModelSynthesis: true as const,
      sources: r.sources,
      retrievedAt: new Date().toISOString(),
      warning:
        r.sources.length === 0
          ? 'Aucune source retournée : la synthèse ne doit pas être considérée comme vérifiée.'
          : null,
    };
  },
  async verify(_i, o) {
    return {
      verified: o.sources.length > 0,
      detail: `${o.sources.length} source(s) retournée(s) par ${o.provider}`,
    };
  },
});

import { HermesError } from '../shared/errors';
import { redactString } from '../shared/redact';
import { sleep } from '../shared/util';
import type { Logger } from '../observability/telemetry';
import type {
  ChatOptions,
  ChatRequest,
  ChatResponse,
  ChatToolCall,
  ConnectionTestResult,
  KeyInfo,
  ModelInfo,
  ModelProvider,
  UrlCitation,
} from './types';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const ALLOWED_HOSTS = new Set(['openrouter.ai']);

export type ProviderErrorKind =
  | 'config_missing'
  | 'auth_invalid'
  | 'forbidden'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'model_unavailable'
  | 'bad_request'
  | 'provider_error'
  | 'timeout'
  | 'network'
  | 'malformed_response'
  | 'cancelled';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limited',
  'provider_error',
  'timeout',
  'network',
  'malformed_response',
]);
/** Only these justify switching to a fallback model; account/config errors never do. */
const FALLBACK_ON: ReadonlySet<ProviderErrorKind> = new Set(['model_unavailable', 'provider_error']);

export class ProviderError extends HermesError {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super('PROVIDER', redactString(message), { kind, status });
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/**
 * Rejects any base URL that could leak the API key to a third party. Only https://openrouter.ai/api/v1
 * is accepted, except plain-http loopback when explicitly enabled for automated tests.
 */
export function validateBaseUrl(raw: string, opts: { allowLoopbackForTests?: boolean } = {}): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HermesError('CONFIG', `URL de base OpenRouter invalide : ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HermesError(
      'CONFIG',
      "L'URL de base ne doit contenir ni identifiants, ni paramètres, ni fragment",
    );
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (opts.allowLoopbackForTests && loopback && url.protocol === 'http:')
    return url.toString().replace(/\/$/, '');
  if (url.protocol !== 'https:') throw new HermesError('CONFIG', "L'URL de base doit utiliser HTTPS");
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new HermesError('CONFIG', `Hôte non autorisé pour la clé OpenRouter : ${url.hostname}`);
  }
  if (url.port && url.port !== '443') throw new HermesError('CONFIG', 'Port non autorisé');
  if (!url.pathname.startsWith('/api/v1'))
    throw new HermesError('CONFIG', 'Le chemin doit commencer par /api/v1');
  return url.toString().replace(/\/$/, '');
}

export function classifyHttpError(
  status: number,
  body: unknown,
  retryAfterHeader: string | null = null,
): ProviderError {
  const err = (
    body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : null
  ) as { message?: unknown; code?: unknown; metadata?: unknown } | null;
  const msg = typeof err?.message === 'string' ? err.message : `HTTP ${status}`;
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  const lower = msg.toLowerCase();
  switch (status) {
    case 400:
      if (/(not a valid model|model.*(not found|does not exist|unavailable))/.test(lower))
        return new ProviderError('model_unavailable', msg, status);
      return new ProviderError('bad_request', msg, status);
    case 401:
      return new ProviderError('auth_invalid', `Clé API invalide ou révoquée : ${msg}`, status);
    case 402:
      return new ProviderError('insufficient_credits', `Crédits OpenRouter insuffisants : ${msg}`, status);
    case 403:
      return new ProviderError('forbidden', `Accès refusé par OpenRouter : ${msg}`, status);
    case 404:
      return new ProviderError('model_unavailable', `Modèle introuvable : ${msg}`, status);
    case 408:
      return new ProviderError('timeout', `Délai dépassé côté OpenRouter : ${msg}`, status, retryAfterMs);
    case 429:
      return new ProviderError('rate_limited', `Limite de débit atteinte : ${msg}`, status, retryAfterMs);
    case 503:
      return new ProviderError(
        'model_unavailable',
        `Aucun fournisseur disponible pour ce modèle : ${msg}`,
        status,
        retryAfterMs,
      );
    default:
      if (status >= 500)
        return new ProviderError(
          'provider_error',
          `Erreur du fournisseur (${status}) : ${msg}`,
          status,
          retryAfterMs,
        );
      return new ProviderError('bad_request', msg, status);
  }
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(s * 1000, 30_000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.min(Math.max(d - Date.now(), 0), 30_000) : null;
}

export function backoffMs(attempt: number, retryAfterMs: number | null, random = Math.random): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const base = Math.min(500 * 2 ** attempt, 8000);
  return Math.round(base / 2 + random() * (base / 2));
}

export interface OpenRouterConfig {
  baseUrl: string;
  getApiKey: () => Promise<string | null>;
  timeoutMs: number;
  maxRetries: number;
  allowLoopbackForTests?: boolean;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export class OpenRouterProvider implements ModelProvider {
  readonly id = 'openrouter';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OpenRouterConfig) {
    this.baseUrl = validateBaseUrl(cfg.baseUrl, { allowLoopbackForTests: cfg.allowLoopbackForTests });
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async hasKey(): Promise<boolean> {
    return Boolean(await this.cfg.getApiKey());
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.cfg.getApiKey();
    if (!key) throw new ProviderError('config_missing', 'Aucune clé OpenRouter configurée');
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'HERMES' };
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: combined });
    } catch (err) {
      if (signal?.aborted) throw new ProviderError('cancelled', 'Requête annulée');
      if (timeout.aborted)
        throw new ProviderError('timeout', `Pas de réponse d'OpenRouter après ${this.cfg.timeoutMs} ms`);
      throw new ProviderError(
        'network',
        `Erreur réseau vers OpenRouter : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async chat(req: ChatRequest, opts: ChatOptions = {}): Promise<ChatResponse> {
    const models = [req.model, ...(req.fallbackModels ?? []).filter((m) => m !== req.model)];
    let lastError: ProviderError | null = null;
    for (const model of models) {
      try {
        return await this.chatWithRetries({ ...req, model }, opts);
      } catch (err) {
        if (!(err instanceof ProviderError) || !FALLBACK_ON.has(err.kind)) throw err;
        lastError = err;
        this.cfg.logger?.log({
          level: 'warn',
          category: 'provider',
          message: `Modèle ${model} indisponible, essai du modèle suivant`,
          errorCode: err.kind,
        });
      }
    }
    throw lastError ?? new ProviderError('model_unavailable', 'Aucun modèle disponible');
  }

  private async chatWithRetries(req: ChatRequest, opts: ChatOptions): Promise<ChatResponse> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.chatOnce(req, opts);
        this.cfg.logger?.log({
          level: 'info',
          category: 'provider',
          message: `chat ${req.model} ok`,
          data: {
            latencyMs: Date.now() - started,
            attempts: attempt + 1,
            usage: res.usage,
            finishReason: res.finishReason,
          },
        });
        return { ...res, latencyMs: Date.now() - started, attempts: attempt + 1 };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError('malformed_response', String(err));
        this.cfg.logger?.log({
          level: 'warn',
          category: 'provider',
          message: `chat ${req.model} échec : ${pe.message}`,
          errorCode: pe.kind,
        });
        if (!pe.retryable || attempt >= this.cfg.maxRetries || opts.signal?.aborted) throw pe;
        opts.onRetry?.(pe.kind);
        await sleep(backoffMs(attempt, pe.retryAfterMs), opts.signal).catch(() => {
          throw new ProviderError('cancelled', 'Requête annulée');
        });
      }
    }
  }

  private async chatOnce(
    req: ChatRequest,
    opts: ChatOptions,
  ): Promise<Omit<ChatResponse, 'latencyMs' | 'attempts'>> {
    const stream = Boolean(opts.stream);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream,
      usage: { include: true },
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? 'auto';
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (req.plugins?.length) body.plugins = req.plugins;

    const res = await this.request(
      '/chat/completions',
      { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) },
      opts.signal,
    );
    if (!res.ok)
      throw classifyHttpError(res.status, await res.json().catch(() => null), res.headers.get('retry-after'));
    return stream ? this.readStream(res, req.model, opts) : this.readJson(res, req.model);
  }

  private async readJson(
    res: Response,
    model: string,
  ): Promise<Omit<ChatResponse, 'latencyMs' | 'attempts'>> {
    const data = (await res.json().catch(() => {
      throw new ProviderError('malformed_response', 'Réponse JSON illisible');
    })) as Record<string, unknown>;
    if (data.error)
      throw classifyHttpError(Number((data.error as { code?: unknown }).code) || 502, data, null);
    const choice = (data.choices as unknown[] | undefined)?.[0] as
      | {
          message?: { content?: unknown; tool_calls?: unknown; annotations?: unknown };
          finish_reason?: unknown;
        }
      | undefined;
    if (!choice?.message) throw new ProviderError('malformed_response', 'Réponse sans choix ni message');
    const toolCalls = parseToolCalls(choice.message.tool_calls);
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
    return {
      id: typeof data.id === 'string' ? data.id : null,
      model: typeof data.model === 'string' ? data.model : model,
      content: typeof choice.message.content === 'string' ? choice.message.content : '',
      toolCalls,
      finishReason,
      incomplete: finishReason === 'length',
      usage: toUsage(data.usage as RawUsage | undefined),
      citations: parseCitations(choice.message.annotations),
    };
  }

  private async readStream(
    res: Response,
    model: string,
    opts: ChatOptions,
  ): Promise<Omit<ChatResponse, 'latencyMs' | 'attempts'>> {
    if (!res.body) throw new ProviderError('malformed_response', 'Flux de réponse vide');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason: string | null = null;
    let usage: RawUsage | undefined;
    let id: string | null = null;
    let servedModel = model;
    let done = false;
    const citations: UrlCitation[] = [];
    const calls = new Map<number, { id: string; name: string; args: string }>();

    const handle = (payload: string) => {
      if (payload === '[DONE]') {
        done = true;
        return;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        throw new ProviderError('malformed_response', 'Fragment de flux illisible');
      }
      if (chunk.error) {
        const e = chunk.error as { code?: unknown; message?: unknown };
        throw classifyHttpError(Number(e.code) || 502, chunk, null);
      }
      if (typeof chunk.id === 'string') id = chunk.id;
      if (typeof chunk.model === 'string') servedModel = chunk.model;
      if (chunk.usage) usage = chunk.usage as RawUsage;
      const choice = (chunk.choices as unknown[] | undefined)?.[0] as
        | {
            delta?: { content?: unknown; tool_calls?: unknown; annotations?: unknown };
            finish_reason?: unknown;
          }
        | undefined;
      if (!choice) return;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (typeof delta?.content === 'string' && delta.content) {
        content += delta.content;
        opts.onDelta?.(delta.content);
      }
      citations.push(...parseCitations(delta?.annotations));
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls as {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[]) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
      }
    };

    try {
      while (!done) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          // Lines starting with ':' are SSE comments (OpenRouter keep-alive).
          if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (opts.signal?.aborted) throw new ProviderError('cancelled', 'Requête annulée');
      throw new ProviderError(
        'network',
        `Flux interrompu : ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      reader.releaseLock();
    }
    const toolCalls: ChatToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({
        id: c.id || `call_${i}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args || '{}' },
      }));
    return {
      id,
      model: servedModel,
      content,
      toolCalls,
      finishReason,
      // A stream that ends without [DONE] or finish_reason is treated as incomplete, never as success.
      incomplete: finishReason === 'length' || (!done && finishReason === null),
      usage: toUsage(usage),
      citations,
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.request(
      '/models',
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      signal,
    );
    if (!res.ok) throw classifyHttpError(res.status, await res.json().catch(() => null), null);
    const data = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!data || !Array.isArray(data.data))
      throw new ProviderError('malformed_response', 'Catalogue de modèles illisible');
    return data.data.flatMap((m) => {
      const parsed = parseModel(m);
      return parsed ? [parsed] : [];
    });
  }

  async getKeyInfo(signal?: AbortSignal): Promise<KeyInfo> {
    const res = await this.request('/key', { method: 'GET', headers: await this.headers() }, signal);
    if (!res.ok) throw classifyHttpError(res.status, await res.json().catch(() => null), null);
    const body = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
    const d = body?.data;
    if (!d) throw new ProviderError('malformed_response', 'Réponse /key illisible');
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    return {
      label: typeof d.label === 'string' ? d.label : null,
      usageUsd: n(d.usage),
      limitUsd: n(d.limit),
      limitRemainingUsd: n(d.limit_remaining),
      isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
    };
  }

  /** Real API round-trip: key check, then a minimal completion with the selected model. */
  async testConnection(model: string | null): Promise<ConnectionTestResult> {
    const testedAt = new Date().toISOString();
    const started = Date.now();
    const fail = (
      status: ConnectionTestResult['status'],
      message: string,
      key: KeyInfo | null = null,
    ): ConnectionTestResult => ({
      status,
      ok: false,
      message: redactString(message),
      model,
      latencyMs: Date.now() - started,
      key,
      testedAt,
    });
    if (!(await this.hasKey())) return fail('config_missing', 'Aucune clé API OpenRouter configurée.');
    let key: KeyInfo;
    try {
      key = await this.getKeyInfo();
    } catch (err) {
      return fail(statusOf(err), err instanceof Error ? err.message : String(err));
    }
    if (!model) return fail('model_unavailable', 'Clé valide, mais aucun modèle principal sélectionné.', key);
    try {
      await this.chatWithRetries(
        {
          model,
          messages: [{ role: 'user', content: 'Réponds uniquement: OK' }],
          maxTokens: 5,
          temperature: 0,
        },
        {},
      );
    } catch (err) {
      return fail(statusOf(err), err instanceof Error ? err.message : String(err), key);
    }
    return {
      status: 'ok',
      ok: true,
      message: `Connexion réussie avec ${model}.`,
      model,
      latencyMs: Date.now() - started,
      key,
      testedAt,
    };
  }
}

function statusOf(err: unknown): ConnectionTestResult['status'] {
  if (!(err instanceof ProviderError)) return 'provider_error';
  switch (err.kind) {
    case 'config_missing':
      return 'config_missing';
    case 'auth_invalid':
    case 'forbidden':
      return 'auth_invalid';
    case 'network':
    case 'timeout':
      return 'network';
    case 'model_unavailable':
    case 'bad_request':
      return 'model_unavailable';
    case 'insufficient_credits':
      return 'insufficient_credits';
    case 'rate_limited':
      return 'rate_limited';
    default:
      return 'provider_error';
  }
}

function toUsage(u: RawUsage | undefined) {
  const promptTokens = u?.prompt_tokens ?? 0;
  const completionTokens = u?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u?.total_tokens ?? promptTokens + completionTokens,
    costUsd: typeof u?.cost === 'number' ? u.cost : null,
  };
}

function parseToolCalls(raw: unknown): ChatToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((tc: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }, i) =>
    typeof tc?.function?.name === 'string'
      ? [
          {
            id: typeof tc.id === 'string' ? tc.id : `call_${i}`,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : '{}',
            },
          },
        ]
      : [],
  );
}

function parseCitations(raw: unknown): UrlCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(
    (a: { type?: unknown; url_citation?: { url?: unknown; title?: unknown; content?: unknown } }) =>
      a?.type === 'url_citation' && typeof a.url_citation?.url === 'string'
        ? [
            {
              url: a.url_citation.url,
              title: typeof a.url_citation.title === 'string' ? a.url_citation.title : null,
              content: typeof a.url_citation.content === 'string' ? a.url_citation.content : null,
            },
          ]
        : [],
  );
}

function perMTok(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
}

export function parseModel(m: unknown): ModelInfo | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const arch = (o.architecture ?? {}) as Record<string, unknown>;
  const pricing = (o.pricing ?? {}) as Record<string, unknown>;
  const top = (o.top_provider ?? {}) as Record<string, unknown>;
  const params = Array.isArray(o.supported_parameters)
    ? o.supported_parameters.filter((p): p is string => typeof p === 'string')
    : [];
  const input = Array.isArray(arch.input_modalities)
    ? arch.input_modalities.filter((p): p is string => typeof p === 'string')
    : [];
  const output = Array.isArray(arch.output_modalities)
    ? arch.output_modalities.filter((p): p is string => typeof p === 'string')
    : [];
  const request = typeof pricing.request === 'string' ? Number(pricing.request) : null;
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : o.id,
    provider: o.id.split('/')[0] ?? 'inconnu',
    description: typeof o.description === 'string' ? o.description.slice(0, 500) : null,
    contextLength: typeof o.context_length === 'number' ? o.context_length : null,
    maxCompletionTokens: typeof top.max_completion_tokens === 'number' ? top.max_completion_tokens : null,
    inputModalities: input,
    outputModalities: output,
    supportedParameters: params,
    supportsTools: params.includes('tools'),
    supportsStructuredOutputs: params.includes('structured_outputs') || params.includes('response_format'),
    supportsImages: input.includes('image'),
    pricing: {
      promptPerMTok: perMTok(pricing.prompt),
      completionPerMTok: perMTok(pricing.completion),
      request: Number.isFinite(request) ? request : null,
    },
  };
}

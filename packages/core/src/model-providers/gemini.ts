import { HermesError } from '../shared/errors';
import { redactString } from '../shared/redact';
import { sleep } from '../shared/util';
import type { Logger } from '../observability/telemetry';
import { ProviderError, backoffMs, connectionStatusOf, type ProviderErrorKind } from './openrouter';
import type {
  ChatContentPart,
  ChatMessage,
  ChatOptions,
  ChatRequest,
  ChatResponse,
  ChatToolCall,
  ChatToolSpec,
  ChatUsage,
  ConnectionTestResult,
  ModelInfo,
  ModelProvider,
  UrlCitation,
} from './types';

/** Google AI Studio (Gemini API) REST base. */
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Gemini Live (BidiGenerateContent) WebSocket endpoint. */
export const GEMINI_LIVE_DEFAULT_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const AI_STUDIO_HOST = 'generativelanguage.googleapis.com';
/** aiplatform.googleapis.com (global) or LOCATION-aiplatform.googleapis.com (regional). */
const VERTEX_HOST = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?aiplatform\.googleapis\.com$/;

/**
 * Rejects any Gemini endpoint that could leak the Google key to a third party: only HTTPS/WSS on
 * generativelanguage.googleapis.com or (LOCATION-)aiplatform.googleapis.com is accepted, except
 * plain loopback when explicitly enabled for automated tests.
 */
export function validateGeminiBaseUrl(
  raw: string,
  opts: { allowLoopbackForTests?: boolean; websocket?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HermesError('CONFIG', `URL Gemini invalide : ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash)
    throw new HermesError(
      'CONFIG',
      "L'URL Gemini ne doit contenir ni identifiants, ni paramètres, ni fragment",
    );
  const secure = opts.websocket ? 'wss:' : 'https:';
  const plain = opts.websocket ? 'ws:' : 'http:';
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (opts.allowLoopbackForTests && loopback && url.protocol === plain)
    return url.toString().replace(/\/$/, '');
  if (url.protocol !== secure)
    throw new HermesError('CONFIG', `L'URL Gemini doit utiliser ${secure.replace(':', '').toUpperCase()}`);
  if (url.hostname !== AI_STUDIO_HOST && !VERTEX_HOST.test(url.hostname))
    throw new HermesError('CONFIG', `Hôte non autorisé pour la clé Gemini : ${url.hostname}`);
  if (url.port && url.port !== '443') throw new HermesError('CONFIG', 'Port non autorisé');
  const path = opts.websocket ? /^\/ws\// : /^\/v1(?:beta1?|alpha)?(?:\/|$)/;
  if (!path.test(url.pathname))
    throw new HermesError(
      'CONFIG',
      opts.websocket
        ? 'Le chemin Live doit commencer par /ws/'
        : 'Le chemin doit commencer par /v1, /v1beta ou /v1beta1',
    );
  return url.toString().replace(/\/$/, '');
}

const VERTEX_PROJECT = /^[a-z][a-z0-9-]{4,29}$/;
const VERTEX_LOCATION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Vertex AI publisher-model base for a project and location ('global' uses the non-regional host). */
export function vertexBaseUrl(project: string, location: string): string {
  if (!VERTEX_PROJECT.test(project))
    throw new HermesError('CONFIG', `Projet Google Cloud invalide : ${project}`);
  if (!VERTEX_LOCATION.test(location) || location.length > 30)
    throw new HermesError('CONFIG', `Région Vertex AI invalide : ${location}`);
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return validateGeminiBaseUrl(
    `https://${host}/v1/projects/${project}/locations/${location}/publishers/google`,
  );
}

/** Model ids end up in the URL path: no slash, no dot-dot, nothing but the documented charset. */
export function normalizeGeminiModel(id: string): string {
  const m = id.replace(/^models\//, '');
  if (!/^[a-z0-9][\w.-]{1,100}$/i.test(m) || m.includes('..'))
    throw new HermesError('CONFIG', `Identifiant de modèle Gemini invalide : ${id}`);
  return m;
}

// ------------------------------------------------------------------ errors

interface GoogleErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    details?: { '@type'?: string; reason?: string; retryDelay?: string }[];
  };
}

function retryDelayMs(body: GoogleErrorBody | null, header: string | null): number | null {
  const fromDetails = body?.error?.details?.find((d) => typeof d.retryDelay === 'string')?.retryDelay;
  const raw = fromDetails ?? header;
  if (!raw) return null;
  const s = Number(raw.replace(/s$/, ''));
  return Number.isFinite(s) ? Math.min(Math.max(s, 0) * 1000, 30_000) : null;
}

/**
 * Maps Google API errors (google.rpc.Status) to the same kinds as OpenRouter. Note that Google
 * reports an invalid key as 400 INVALID_ARGUMENT / API_KEY_INVALID, not 401.
 */
export function classifyGeminiError(
  status: number,
  body: unknown,
  retryAfterHeader: string | null = null,
): ProviderError {
  const b = (body && typeof body === 'object' ? body : null) as GoogleErrorBody | null;
  const msg = typeof b?.error?.message === 'string' ? b.error.message : `HTTP ${status}`;
  const rpc = typeof b?.error?.status === 'string' ? b.error.status : '';
  const reasons = (b?.error?.details ?? []).map((d) => d.reason ?? '').filter(Boolean);
  const lower = msg.toLowerCase();
  const retry = retryDelayMs(b, retryAfterHeader);
  const err = (kind: ProviderErrorKind, text: string, retryAfter: number | null = null) =>
    new ProviderError(kind, text, status, retryAfter);

  if (reasons.some((r) => r.startsWith('API_KEY_')) || /api key (not valid|expired|invalid)/.test(lower))
    return err('auth_invalid', `Clé API Gemini invalide ou révoquée : ${msg}`);
  if (/billing|prepayment|credits? (are )?depleted/.test(lower))
    return err('insufficient_credits', `Facturation Google requise ou crédits épuisés : ${msg}`);
  switch (status) {
    case 400:
      if (/model.*(not found|is not supported|does not exist)|not found for api version/.test(lower))
        return err('model_unavailable', `Modèle Gemini indisponible : ${msg}`);
      if (rpc === 'FAILED_PRECONDITION') return err('forbidden', `Accès Gemini impossible : ${msg}`);
      return err('bad_request', msg);
    case 401:
      return err('auth_invalid', `Authentification Google refusée : ${msg}`);
    case 403:
      return err('forbidden', `Accès refusé par Google : ${msg}`);
    case 404:
      return err('model_unavailable', `Modèle Gemini introuvable : ${msg}`);
    case 408:
    case 504:
      return err('timeout', `Délai dépassé côté Gemini : ${msg}`, retry);
    case 429:
      return err('rate_limited', `Quota ou limite de débit Gemini atteint : ${msg}`, retry);
    default:
      if (status >= 500) return err('provider_error', `Erreur du service Gemini (${status}) : ${msg}`, retry);
      return err('bad_request', msg);
  }
}

// ------------------------------------------------------------------ request conversion

type GeminiPart = Record<string, unknown>;
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { content: raw };
  }
}

function userParts(content: string | ChatContentPart[]): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((p) => {
    if (p.type === 'text') return { text: p.text };
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(p.image_url.url);
    // Gemini only accepts inline bytes or uploaded files; remote URLs are described instead of fetched.
    return m
      ? { inlineData: { mimeType: m[1], data: m[2] } }
      : { text: `[image non transmise : ${p.image_url.url}]` };
  });
}

/**
 * OpenAI-style messages → Gemini `contents` + `systemInstruction`. Consecutive turns of the same
 * role are merged, and tool results are sent as `functionResponse` parts named after their call.
 */
export function toGeminiContents(messages: ChatMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
} {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const callNames = new Map<string, string>();
  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        system.push(m.content);
        break;
      case 'user':
        push('user', userParts(m.content));
        break;
      case 'assistant': {
        const parts: GeminiPart[] = m.content ? [{ text: m.content }] : [];
        for (const tc of m.tool_calls ?? []) {
          callNames.set(tc.id, tc.function.name);
          parts.push({
            functionCall: { name: tc.function.name, args: parseJsonObject(tc.function.arguments || '{}') },
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          });
        }
        push('model', parts);
        break;
      }
      case 'tool':
        push('user', [
          {
            functionResponse: {
              name: callNames.get(m.tool_call_id) ?? 'unknown_tool',
              response: parseJsonObject(m.content),
            },
          },
        ]);
        break;
    }
  }
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}),
  };
}

/** JSON-Schema keywords Gemini's parametersJsonSchema rejects or ignores. */
function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) if (k !== '$schema' && k !== '$id') out[k] = cleanSchema(v);
  return out;
}

/** HERMES tool spec (already derived from AnyTool by toChatToolSpec) → Gemini FunctionDeclaration. */
export function toFunctionDeclaration(
  spec: ChatToolSpec,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: spec.function.name,
    description: spec.function.description,
    parametersJsonSchema: cleanSchema(spec.function.parameters),
    ...extra,
  };
}

export function toGeminiBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { ...toGeminiContents(req.messages) };
  const tools: Record<string, unknown>[] = [];
  if (req.tools?.length) tools.push({ functionDeclarations: req.tools.map((t) => toFunctionDeclaration(t)) });
  // OpenRouter's "web" plugin maps to Gemini's built-in Google Search grounding.
  if (req.plugins?.some((p) => p.id === 'web')) tools.push({ googleSearch: {} });
  if (tools.length) body.tools = tools;
  if (req.tools?.length && req.toolChoice)
    body.toolConfig = {
      functionCallingConfig: { mode: { auto: 'AUTO', none: 'NONE', required: 'ANY' }[req.toolChoice] },
    };
  const gen: Record<string, unknown> = {};
  if (req.temperature !== undefined) gen.temperature = req.temperature;
  if (req.maxTokens !== undefined) gen.maxOutputTokens = req.maxTokens;
  if (req.jsonMode) gen.responseMimeType = 'application/json';
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

// ------------------------------------------------------------------ response parsing

interface RawCandidate {
  content?: { parts?: Record<string, unknown>[] };
  finishReason?: string;
  groundingMetadata?: { groundingChunks?: { web?: { uri?: unknown; title?: unknown } }[] };
}
interface RawResponse {
  candidates?: RawCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
}

const BLOCKED_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'LANGUAGE',
]);

function toUsage(u: RawResponse['usageMetadata']): ChatUsage {
  const promptTokens = u?.promptTokenCount ?? 0;
  // Thinking tokens are billed as output tokens.
  const completionTokens = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: u?.totalTokenCount ?? promptTokens + completionTokens,
    costUsd: null,
  };
}

function citationsOf(c: RawCandidate | undefined): UrlCitation[] {
  return (c?.groundingMetadata?.groundingChunks ?? []).flatMap((g) =>
    typeof g.web?.uri === 'string'
      ? [{ url: g.web.uri, title: typeof g.web.title === 'string' ? g.web.title : null, content: null }]
      : [],
  );
}

/** Accumulates one response (JSON) or many stream chunks (SSE) into a ChatResponse. */
class ResponseAccumulator {
  content = '';
  toolCalls: ChatToolCall[] = [];
  finish: string | null = null;
  usage: RawResponse['usageMetadata'];
  citations: UrlCitation[] = [];
  model: string;
  id: string | null = null;

  constructor(model: string) {
    this.model = model;
  }

  add(r: RawResponse, onDelta?: (t: string) => void): void {
    if (r.promptFeedback?.blockReason)
      throw new ProviderError('bad_request', `Requête bloquée par Gemini (${r.promptFeedback.blockReason})`);
    if (r.usageMetadata) this.usage = r.usageMetadata;
    if (typeof r.modelVersion === 'string') this.model = r.modelVersion;
    if (typeof r.responseId === 'string') this.id = r.responseId;
    const c = r.candidates?.[0];
    if (!c) return;
    for (const part of c.content?.parts ?? []) {
      // Thought summaries are internal reasoning, never shown as the answer.
      if (typeof part.text === 'string' && part.thought !== true && part.text) {
        this.content += part.text;
        onDelta?.(part.text);
      }
      const fc = part.functionCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
      if (fc && typeof fc.name === 'string') {
        this.toolCalls.push({
          id: typeof fc.id === 'string' && fc.id ? fc.id : `gemini_call_${this.toolCalls.length}`,
          type: 'function',
          function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
          ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
    }
    this.citations.push(...citationsOf(c));
    if (typeof c.finishReason === 'string' && c.finishReason !== 'FINISH_REASON_UNSPECIFIED')
      this.finish = c.finishReason;
  }

  result(streamEnded: boolean): Omit<ChatResponse, 'latencyMs' | 'attempts'> {
    const finishReason =
      this.finish === null
        ? null
        : this.finish === 'MAX_TOKENS'
          ? 'length'
          : this.finish === 'STOP' && this.toolCalls.length
            ? 'tool_calls'
            : this.finish.toLowerCase();
    const seen = new Set<string>();
    return {
      id: this.id,
      model: this.model,
      content: this.content,
      toolCalls: this.toolCalls,
      finishReason,
      // Truncated, safety-blocked or cut streams are never treated as a complete answer.
      incomplete:
        this.finish === 'MAX_TOKENS' ||
        (this.finish !== null && BLOCKED_FINISH.has(this.finish)) ||
        (streamEnded && this.finish === null),
      usage: toUsage(this.usage),
      citations: this.citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))),
    };
  }
}

// ------------------------------------------------------------------ provider

export type GeminiBackend = 'ai-studio' | 'vertex';

export interface GeminiConfig {
  backend?: GeminiBackend;
  /** AI Studio base URL (default GEMINI_DEFAULT_BASE_URL). Ignored for Vertex. */
  baseUrl?: string;
  vertex?: { project: string; location: string };
  getApiKey: () => Promise<string | null>;
  timeoutMs: number;
  maxRetries: number;
  allowLoopbackForTests?: boolean;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

const FALLBACK_ON: ReadonlySet<ProviderErrorKind> = new Set(['model_unavailable', 'provider_error']);

/**
 * Gemini over REST: Google AI Studio (API key) or Vertex AI (express-mode API key, or an OAuth
 * access token "ya29.…" sent as Bearer). The key only ever goes in a header, never in the URL.
 */
export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini';
  readonly backend: GeminiBackend;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GeminiConfig) {
    this.backend = cfg.backend ?? 'ai-studio';
    if (this.backend === 'vertex') {
      if (!cfg.vertex) throw new HermesError('CONFIG', 'Projet et région Vertex AI requis');
      this.base = vertexBaseUrl(cfg.vertex.project, cfg.vertex.location);
    } else {
      this.base = validateGeminiBaseUrl(cfg.baseUrl ?? GEMINI_DEFAULT_BASE_URL, {
        allowLoopbackForTests: cfg.allowLoopbackForTests,
      });
    }
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async hasKey(): Promise<boolean> {
    return Boolean(await this.cfg.getApiKey());
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.cfg.getApiKey();
    if (!key) throw new ProviderError('config_missing', 'Aucune clé Gemini configurée');
    const auth: Record<string, string> = key.startsWith('ya29.')
      ? { Authorization: `Bearer ${key}` }
      : { 'x-goog-api-key': key };
    return { ...auth, 'Content-Type': 'application/json' };
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(url, { ...init, signal: combined });
    } catch (err) {
      if (signal?.aborted) throw new ProviderError('cancelled', 'Requête annulée');
      if (timeout.aborted)
        throw new ProviderError('timeout', `Pas de réponse de Gemini après ${this.cfg.timeoutMs} ms`);
      throw new ProviderError(
        'network',
        `Erreur réseau vers Gemini : ${err instanceof Error ? err.message : String(err)}`,
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
          message: `Modèle Gemini ${model} indisponible, essai du modèle suivant`,
          errorCode: err.kind,
        });
      }
    }
    throw lastError ?? new ProviderError('model_unavailable', 'Aucun modèle Gemini disponible');
  }

  private async chatWithRetries(req: ChatRequest, opts: ChatOptions): Promise<ChatResponse> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.chatOnce(req, opts);
        return { ...res, latencyMs: Date.now() - started, attempts: attempt + 1 };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError('malformed_response', String(err));
        this.cfg.logger?.log({
          level: 'warn',
          category: 'provider',
          message: `Gemini ${req.model} échec : ${pe.message}`,
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
    const model = normalizeGeminiModel(req.model);
    const stream = Boolean(opts.stream);
    const url = `${this.base}/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    const res = await this.request(
      url,
      { method: 'POST', headers: await this.headers(), body: JSON.stringify(toGeminiBody(req)) },
      opts.signal,
    );
    if (!res.ok)
      throw classifyGeminiError(
        res.status,
        await res.json().catch(() => null),
        res.headers.get('retry-after'),
      );
    const acc = new ResponseAccumulator(model);
    if (!stream) {
      const data = (await res.json().catch(() => {
        throw new ProviderError('malformed_response', 'Réponse JSON Gemini illisible');
      })) as RawResponse & GoogleErrorBody;
      if (data.error) throw classifyGeminiError(Number(data.error.code) || 502, data);
      if (!data.candidates?.length && !data.promptFeedback?.blockReason)
        throw new ProviderError('malformed_response', 'Réponse Gemini sans candidat');
      acc.add(data);
      return acc.result(false);
    }
    return this.readStream(res, acc, opts);
  }

  private async readStream(
    res: Response,
    acc: ResponseAccumulator,
    opts: ChatOptions,
  ): Promise<Omit<ChatResponse, 'latencyMs' | 'attempts'>> {
    if (!res.body) throw new ProviderError('malformed_response', 'Flux de réponse Gemini vide');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (payload: string) => {
      if (!payload) return;
      let chunk: RawResponse & GoogleErrorBody;
      try {
        chunk = JSON.parse(payload) as RawResponse & GoogleErrorBody;
      } catch {
        throw new ProviderError('malformed_response', 'Fragment de flux Gemini illisible');
      }
      if (chunk.error) throw classifyGeminiError(Number(chunk.error.code) || 502, chunk);
      acc.add(chunk, opts.onDelta);
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
      }
      if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (opts.signal?.aborted) throw new ProviderError('cancelled', 'Requête annulée');
      throw new ProviderError(
        'network',
        `Flux Gemini interrompu : ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      reader.releaseLock();
    }
    return acc.result(true);
  }

  /** AI Studio model catalog. Vertex has no equivalent list for API keys: an empty list is returned. */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (this.backend === 'vertex') return [];
    const models: ModelInfo[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const res = await this.request(
        `${this.base}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
        { method: 'GET', headers: await this.headers() },
        signal,
      );
      if (!res.ok) throw classifyGeminiError(res.status, await res.json().catch(() => null));
      const data = (await res.json().catch(() => null)) as {
        models?: unknown;
        nextPageToken?: unknown;
      } | null;
      if (!data || !Array.isArray(data.models))
        throw new ProviderError('malformed_response', 'Catalogue Gemini illisible');
      models.push(...data.models.flatMap((m) => parseGeminiModel(m) ?? []));
      if (typeof data.nextPageToken !== 'string' || !data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return models;
  }

  /** Real round-trip: key check through the catalog (AI Studio), then a minimal generation. */
  async testConnection(model: string | null): Promise<ConnectionTestResult> {
    const testedAt = new Date().toISOString();
    const started = Date.now();
    const fail = (status: ConnectionTestResult['status'], message: string): ConnectionTestResult => ({
      status,
      ok: false,
      message: redactString(message),
      model,
      latencyMs: Date.now() - started,
      key: null,
      testedAt,
    });
    if (!(await this.hasKey())) return fail('config_missing', 'Aucune clé API Gemini configurée.');
    try {
      if (this.backend === 'ai-studio') await this.listModels();
    } catch (err) {
      return fail(connectionStatusOf(err), err instanceof Error ? err.message : String(err));
    }
    if (!model) return fail('model_unavailable', 'Clé valide, mais aucun modèle Gemini sélectionné.');
    try {
      await this.chatWithRetries(
        {
          model,
          messages: [{ role: 'user', content: 'Réponds uniquement: OK' }],
          maxTokens: 16,
          temperature: 0,
        },
        {},
      );
    } catch (err) {
      return fail(connectionStatusOf(err), err instanceof Error ? err.message : String(err));
    }
    return {
      status: 'ok',
      ok: true,
      message: `Connexion Gemini réussie avec ${model}.`,
      model,
      latencyMs: Date.now() - started,
      key: null,
      testedAt,
    };
  }
}

export function parseGeminiModel(m: unknown): ModelInfo | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (typeof o.name !== 'string') return null;
  const id = o.name.replace(/^models\//, '');
  const methods = Array.isArray(o.supportedGenerationMethods)
    ? o.supportedGenerationMethods.filter((x): x is string => typeof x === 'string')
    : [];
  const live = methods.includes('bidiGenerateContent');
  const gemini = id.startsWith('gemini');
  return {
    id,
    name: typeof o.displayName === 'string' ? o.displayName : id,
    provider: 'google',
    description: typeof o.description === 'string' ? o.description.slice(0, 500) : null,
    contextLength: typeof o.inputTokenLimit === 'number' ? o.inputTokenLimit : null,
    maxCompletionTokens: typeof o.outputTokenLimit === 'number' ? o.outputTokenLimit : null,
    // The catalog does not publish modalities: Gemini models are documented as multimodal.
    inputModalities: gemini ? ['text', 'image', ...(live ? ['audio'] : [])] : ['text'],
    outputModalities: live ? ['text', 'audio'] : ['text'],
    // Unknown per-parameter support: an empty list lets the gateway send standard parameters.
    supportedParameters: [],
    supportsTools: gemini && methods.some((x) => x === 'generateContent' || x === 'bidiGenerateContent'),
    supportsStructuredOutputs: gemini && methods.includes('generateContent'),
    supportsImages: gemini,
    // Google does not publish prices through the API: cost stays unknown rather than guessed.
    pricing: { promptPerMTok: null, completionPerMTok: null, request: null },
  };
}

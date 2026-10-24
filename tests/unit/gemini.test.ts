// Uses a SIMULATED Gemini REST API (mock fetch): validates HERMES' client logic, not the real API.
// The invalid-key body below was captured from the real API (24/10/2026) with a fake key.
import { describe, expect, it } from 'vitest';
import {
  GeminiProvider,
  ProviderError,
  classifyGeminiError,
  normalizeGeminiModel,
  parseGeminiModel,
  toGeminiBody,
  toGeminiContents,
  toChatToolSpec,
  ALL_TOOLS,
  validateGeminiBaseUrl,
  vertexBaseUrl,
  type ChatMessage,
} from '@hermes/core';

// Same shape as a real key (AIza + 35 characters), so the redaction pattern applies.
const KEY = `AIzaSy${'T'.repeat(33)}`;
const REAL_INVALID_KEY = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
        metadata: { service: 'generativelanguage.googleapis.com' },
      },
    ],
  },
};

type Reply = { status?: number; json?: unknown; sse?: string; headers?: Record<string, string> };
interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

function mock(
  handler: (url: URL, body: Record<string, unknown> | undefined, n: number) => Reply | Promise<Reply>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, headers: new Headers(init?.headers), body });
    if (init?.signal?.aborted) throw init.signal.reason;
    const r = await handler(new URL(url), body, calls.length - 1);
    if (r.sse !== undefined)
      return new Response(r.sse, {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...r.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const answer = (
  parts: Record<string, unknown>[],
  finishReason = 'STOP',
  extra: Record<string, unknown> = {},
) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason, ...extra }],
  usageMetadata: {
    promptTokenCount: 50,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 5,
    totalTokenCount: 65,
  },
  modelVersion: 'gemini-3.8-flash',
  responseId: 'resp-1',
});

const provider = (
  handler: Parameters<typeof mock>[0],
  over: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {},
) => {
  const m = mock(handler);
  return {
    p: new GeminiProvider({
      getApiKey: async () => KEY,
      timeoutMs: 2000,
      maxRetries: 2,
      fetchImpl: m.fetchImpl,
      ...over,
    }),
    calls: m.calls,
  };
};
const msg: ChatMessage[] = [{ role: 'user', content: 'salut' }];
/** Never answers, but honours its abort signal like the real fetch (including an already-aborted one). */
const hangingFetch = ((_u: string, init?: RequestInit) =>
  new Promise((_r, reject) => {
    if (init?.signal?.aborted) return reject(init.signal.reason);
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as typeof fetch;

describe('validation des URL Gemini', () => {
  it('n’accepte que generativelanguage.googleapis.com et (région-)aiplatform.googleapis.com', () => {
    expect(validateGeminiBaseUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
    expect(validateGeminiBaseUrl('https://europe-west4-aiplatform.googleapis.com/v1/projects/p')).toContain(
      'europe-west4-aiplatform',
    );
    expect(() => validateGeminiBaseUrl('https://evil.example/v1beta')).toThrow(/non autorisé/);
    expect(() =>
      validateGeminiBaseUrl('https://generativelanguage.googleapis.com.evil.net/v1beta'),
    ).toThrow();
    expect(() => validateGeminiBaseUrl('https://evil-googleapis.com/v1beta')).toThrow();
    expect(() => validateGeminiBaseUrl('https://storage.googleapis.com/v1')).toThrow(/non autorisé/);
    expect(() => validateGeminiBaseUrl('http://generativelanguage.googleapis.com/v1beta')).toThrow(/HTTPS/);
    expect(() => validateGeminiBaseUrl('https://u:p@generativelanguage.googleapis.com/v1beta')).toThrow();
    expect(() => validateGeminiBaseUrl('https://generativelanguage.googleapis.com/v1beta?key=x')).toThrow();
    expect(() => validateGeminiBaseUrl('https://generativelanguage.googleapis.com/upload')).toThrow();
    expect(() => validateGeminiBaseUrl('http://127.0.0.1:9/v1beta')).toThrow();
    expect(validateGeminiBaseUrl('http://127.0.0.1:9/v1beta', { allowLoopbackForTests: true })).toBe(
      'http://127.0.0.1:9/v1beta',
    );
  });
  it('valide le WebSocket Live et construit l’URL Vertex', () => {
    expect(() =>
      validateGeminiBaseUrl(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
        { websocket: true },
      ),
    ).not.toThrow();
    expect(() =>
      validateGeminiBaseUrl('ws://generativelanguage.googleapis.com/ws/x', { websocket: true }),
    ).toThrow();
    expect(vertexBaseUrl('mon-projet', 'europe-west1')).toBe(
      'https://europe-west1-aiplatform.googleapis.com/v1/projects/mon-projet/locations/europe-west1/publishers/google',
    );
    expect(vertexBaseUrl('mon-projet', 'global')).toMatch(/^https:\/\/aiplatform\.googleapis\.com\//);
    expect(() => vertexBaseUrl('../evil', 'us-central1')).toThrow();
    expect(() => vertexBaseUrl('mon-projet', 'evil.com/x')).toThrow();
  });
  it('refuse les identifiants de modèle qui sortiraient du chemin', () => {
    expect(normalizeGeminiModel('models/gemini-3.8-flash')).toBe('gemini-3.8-flash');
    for (const bad of ['../keys', 'a/b', 'gemini?x=1', 'g', 'gemini..x'])
      expect(() => normalizeGeminiModel(bad)).toThrow();
  });
});

describe('classification des erreurs Gemini', () => {
  it.each([
    [400, { error: { message: 'Invalid JSON payload', status: 'INVALID_ARGUMENT' } }, 'bad_request', false],
    [
      400,
      { error: { message: 'models/x is not found for API version v1beta', status: 'NOT_FOUND' } },
      'model_unavailable',
      false,
    ],
    [
      400,
      { error: { message: 'User location is not supported', status: 'FAILED_PRECONDITION' } },
      'forbidden',
      false,
    ],
    [
      401,
      { error: { message: 'Request had invalid authentication credentials', status: 'UNAUTHENTICATED' } },
      'auth_invalid',
      false,
    ],
    [
      403,
      { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } },
      'forbidden',
      false,
    ],
    [404, { error: { message: 'not found', status: 'NOT_FOUND' } }, 'model_unavailable', false],
    [
      429,
      { error: { message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } },
      'rate_limited',
      true,
    ],
    [500, { error: { message: 'Internal error', status: 'INTERNAL' } }, 'provider_error', true],
    [503, { error: { message: 'The model is overloaded', status: 'UNAVAILABLE' } }, 'provider_error', true],
    [504, { error: { message: 'Deadline exceeded', status: 'DEADLINE_EXCEEDED' } }, 'timeout', true],
  ])('HTTP %i %j → %s', (status, body, kind, retryable) => {
    const e = classifyGeminiError(status, body);
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
  });
  it('reconnaît la clé invalide (réponse réelle : 400 API_KEY_INVALID) et la facturation', () => {
    expect(classifyGeminiError(400, REAL_INVALID_KEY).kind).toBe('auth_invalid');
    expect(
      classifyGeminiError(400, {
        error: { message: 'Billing account not enabled', status: 'FAILED_PRECONDITION' },
      }).kind,
    ).toBe('insufficient_credits');
  });
  it('lit RetryInfo.retryDelay et le borne', () => {
    const e = classifyGeminiError(429, {
      error: {
        message: 'quota',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
      },
    });
    expect(e.retryAfterMs).toBe(7000);
    expect(classifyGeminiError(429, { error: { details: [{ retryDelay: '900s' }] } }).retryAfterMs).toBe(
      30_000,
    );
  });
});

describe('conversion des messages et des outils', () => {
  it('sépare l’instruction système, fusionne les tours et nomme les réponses d’outils', () => {
    const { contents, systemInstruction } = toGeminiContents([
      { role: 'system', content: 'Tu es HERMES.' },
      { role: 'user', content: 'Liste le dossier' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'files__search', arguments: '{"root":"C:/x"}' },
            thoughtSignature: 'sig-1',
          },
          { id: 'c2', type: 'function', function: { name: 'files__read', arguments: 'pas du json' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"files":["a.txt"]}' },
      { role: 'tool', tool_call_id: 'c2', content: 'texte brut' },
    ]);
    expect(systemInstruction).toEqual({ parts: [{ text: 'Tu es HERMES.' }] });
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[1]!.parts[0]).toEqual({
      functionCall: { name: 'files__search', args: { root: 'C:/x' } },
      thoughtSignature: 'sig-1',
    });
    expect(contents[1]!.parts[1]).toEqual({
      functionCall: { name: 'files__read', args: { content: 'pas du json' } },
    });
    expect(contents[2]!.parts).toEqual([
      { functionResponse: { name: 'files__search', response: { files: ['a.txt'] } } },
      { functionResponse: { name: 'files__read', response: { content: 'texte brut' } } },
    ]);
  });
  it('transmet les images en ligne et décrit les URL distantes', () => {
    const { contents } = toGeminiContents([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Que vois-tu ?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      },
    ]);
    expect(contents[0]!.parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
    expect(contents[0]!.parts[2]).toEqual({ text: '[image non transmise : https://example.com/a.png]' });
  });
  it('convertit les outils HERMES (AnyTool) en FunctionDeclaration, avec recherche Google et mode JSON', () => {
    const spec = toChatToolSpec(ALL_TOOLS.find((t) => t.id === 'files.write')!);
    const body = toGeminiBody({
      model: 'gemini-3.8-flash',
      messages: msg,
      tools: [spec],
      toolChoice: 'required',
      temperature: 0.2,
      maxTokens: 100,
      jsonMode: true,
      plugins: [{ id: 'web' }],
    });
    const decl = (body.tools as { functionDeclarations?: Record<string, unknown>[] }[])[0]!
      .functionDeclarations![0]!;
    expect(decl.name).toBe('files__write');
    expect(JSON.stringify(decl.parametersJsonSchema)).not.toContain('$schema');
    expect((decl.parametersJsonSchema as { properties: object }).properties).toHaveProperty('path');
    expect(body.tools).toContainEqual({ googleSearch: {} });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(body.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 100,
      responseMimeType: 'application/json',
    });
  });
});

describe('client Gemini (simulé)', () => {
  it('envoie la clé en en-tête uniquement, jamais dans l’URL, et lit l’usage', async () => {
    const { p, calls } = provider(() => ({ json: answer([{ text: 'bonjour' }]) }));
    const r = await p.chat({ model: 'gemini-3.8-flash', messages: msg });
    expect(r.content).toBe('bonjour');
    expect(r.finishReason).toBe('stop');
    expect(r.incomplete).toBe(false);
    expect(r.usage).toEqual({ promptTokens: 50, completionTokens: 15, totalTokens: 65, costUsd: null });
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    expect(calls[0]!.url).not.toContain(KEY);
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe(KEY);
    expect(calls[0]!.headers.get('authorization')).toBeNull();
  });
  it('utilise Vertex AI avec un jeton OAuth en Bearer', async () => {
    const { p, calls } = provider(() => ({ json: answer([{ text: 'ok' }]) }), {
      backend: 'vertex',
      vertex: { project: 'hermes-prod', location: 'europe-west4' },
      getApiKey: async () => 'ya29.a0AfH6SMBexampleexampleexample',
    });
    await p.chat({ model: 'gemini-3.8-flash', messages: msg });
    expect(calls[0]!.url).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/hermes-prod/locations/europe-west4/publishers/google/models/gemini-3.8-flash:generateContent',
    );
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer ya29.a0AfH6SMBexampleexampleexample');
    expect(calls[0]!.headers.get('x-goog-api-key')).toBeNull();
  });
  it('erreur de configuration sans clé, sans appel réseau', async () => {
    const { p, calls } = provider(() => ({ json: answer([]) }), { getApiKey: async () => null });
    await expect(p.chat({ model: 'gemini-3.8-flash', messages: msg })).rejects.toMatchObject({
      kind: 'config_missing',
    });
    expect(calls).toHaveLength(0);
  });
  it('retourne les appels de fonction avec leur signature de pensée', async () => {
    const { p } = provider(() => ({
      json: answer([
        { text: 'réflexion', thought: true },
        { functionCall: { name: 'files__search', args: { root: 'C:/w' } }, thoughtSignature: 'c2lnbmF0dXJl' },
      ]),
    }));
    const r = await p.chat({ model: 'gemini-3.8-flash', messages: msg, tools: [] });
    expect(r.content).toBe('');
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls).toEqual([
      {
        id: 'gemini_call_0',
        type: 'function',
        function: { name: 'files__search', arguments: '{"root":"C:/w"}' },
        thoughtSignature: 'c2lnbmF0dXJl',
      },
    ]);
  });
  it('réessaie les erreurs récupérables (429 puis succès) et respecte retryDelay', async () => {
    const { p, calls } = provider((_u, _b, n) =>
      n === 0
        ? { status: 429, json: { error: { message: 'quota', details: [{ retryDelay: '0.01s' }] } } }
        : { json: answer([{ text: 'ok' }]) },
    );
    const r = await p.chat({ model: 'gemini-3.8-flash', messages: msg });
    expect(r.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });
  it('ne réessaie pas une clé invalide et ne bascule pas sur le modèle de secours', async () => {
    const { p, calls } = provider(() => ({ status: 400, json: REAL_INVALID_KEY }));
    await expect(
      p.chat({ model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.8-pro'], messages: msg }),
    ).rejects.toMatchObject({ kind: 'auth_invalid' });
    expect(calls).toHaveLength(1);
  });
  it('bascule sur le modèle de secours si le modèle est introuvable', async () => {
    const { p, calls } = provider((u) =>
      u.pathname.includes('gemini-old')
        ? { status: 404, json: { error: { message: 'not found' } } }
        : { json: answer([{ text: 'ok' }]) },
    );
    const r = await p.chat({ model: 'gemini-old', fallbackModels: ['gemini-3.8-flash'], messages: msg });
    expect(r.content).toBe('ok');
    expect(calls.map((c) => new URL(c.url).pathname.split('/').at(-1))).toEqual([
      'gemini-old:generateContent',
      'gemini-3.8-flash:generateContent',
    ]);
  });
  it('limite le nombre de tentatives', async () => {
    const { p, calls } = provider(() => ({ status: 500, json: { error: { message: 'boom' } } }), {
      maxRetries: 1,
    });
    await expect(p.chat({ model: 'gemini-3.8-flash', messages: msg })).rejects.toMatchObject({
      kind: 'provider_error',
    });
    expect(calls).toHaveLength(2);
  });
  it('gère le délai maximal et l’annulation', async () => {
    // A fetch honouring the abort signal, like the real one.
    const hanging = new GeminiProvider({
      getApiKey: async () => KEY,
      timeoutMs: 50,
      maxRetries: 0,
      fetchImpl: hangingFetch,
    });
    await expect(hanging.chat({ model: 'gemini-3.8-flash', messages: msg })).rejects.toMatchObject({
      kind: 'timeout',
    });
    const ctrl = new AbortController();
    const cancelled = new GeminiProvider({
      getApiKey: async () => KEY,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: hangingFetch,
    });
    const pending = cancelled.chat({ model: 'gemini-3.8-flash', messages: msg }, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
  });
  it('rejette une réponse mal formée et signale une requête bloquée', async () => {
    const empty = provider(() => ({ json: { usageMetadata: {} } }), { maxRetries: 0 });
    await expect(empty.p.chat({ model: 'gemini-3.8-flash', messages: msg })).rejects.toMatchObject({
      kind: 'malformed_response',
    });
    const blocked = provider(() => ({ json: { promptFeedback: { blockReason: 'SAFETY' } } }));
    await expect(blocked.p.chat({ model: 'gemini-3.8-flash', messages: msg })).rejects.toThrow(
      /bloquée par Gemini \(SAFETY\)/,
    );
  });
  it('marque comme incomplète une réponse tronquée ou filtrée', async () => {
    const trunc = provider(() => ({ json: answer([{ text: 'début' }], 'MAX_TOKENS') }));
    const r = await trunc.p.chat({ model: 'gemini-3.8-flash', messages: msg });
    expect(r).toMatchObject({ finishReason: 'length', incomplete: true });
    const safety = provider(() => ({ json: answer([], 'SAFETY') }));
    expect((await safety.p.chat({ model: 'gemini-3.8-flash', messages: msg })).incomplete).toBe(true);
  });
  it('lit un flux SSE streamGenerateContent avec texte et appel de fonction', async () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: 'Bon' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'jour' }] } }] },
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'web__search', args: { query: 'q' } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      },
    ];
    const { p, calls } = provider(() => ({
      sse: chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''),
    }));
    const deltas: string[] = [];
    const r = await p.chat(
      { model: 'gemini-3.8-flash', messages: msg },
      { stream: true, onDelta: (t) => deltas.push(t) },
    );
    expect(calls[0]!.url).toContain(':streamGenerateContent?alt=sse');
    expect(deltas).toEqual(['Bon', 'jour']);
    expect(r).toMatchObject({ content: 'Bonjour', finishReason: 'tool_calls', incomplete: false });
    expect(r.toolCalls[0]!.function).toEqual({ name: 'web__search', arguments: '{"query":"q"}' });
    expect(r.usage.totalTokens).toBe(7);
  });
  it('signale un flux coupé comme incomplet et une erreur en cours de flux', async () => {
    const cut = provider(() => ({
      sse: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }] } }] })}\n\n`,
    }));
    expect(
      (await cut.p.chat({ model: 'gemini-3.8-flash', messages: msg }, { stream: true })).incomplete,
    ).toBe(true);
    const err = provider(
      () => ({ sse: `data: ${JSON.stringify({ error: { code: 429, message: 'quota' } })}\n\n` }),
      { maxRetries: 0 },
    );
    await expect(
      err.p.chat({ model: 'gemini-3.8-flash', messages: msg }, { stream: true }),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });
  it('extrait les citations de l’ancrage Google Search (sans doublon)', async () => {
    const web = (uri: string, title: string) => ({ web: { uri, title } });
    const { p } = provider(() => ({
      json: answer([{ text: 'BTC à 1 €' }], 'STOP', {
        groundingMetadata: {
          groundingChunks: [
            web('https://a.example', 'A'),
            web('https://a.example', 'A'),
            web('https://b.example', 'B'),
          ],
        },
      }),
    }));
    const r = await p.chat({ model: 'gemini-3.8-flash', messages: msg, plugins: [{ id: 'web' }] });
    expect(r.citations).toEqual([
      { url: 'https://a.example', title: 'A', content: null },
      { url: 'https://b.example', title: 'B', content: null },
    ]);
  });
});

describe('catalogue et test de connexion Gemini (simulé)', () => {
  const models = {
    models: [
      {
        name: 'models/gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      },
      {
        name: 'models/gemini-3.8-live',
        displayName: 'Gemini 3.8 Live',
        supportedGenerationMethods: ['bidiGenerateContent'],
      },
      { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
    ],
  };
  it('liste les modèles et déduit les capacités annoncées', async () => {
    const { p, calls } = provider(() => ({ json: models }));
    const list = await p.listModels();
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(list.map((m) => m.id)).toEqual(['gemini-3.8-flash', 'gemini-3.8-live', 'text-embedding-005']);
    expect(list[0]).toMatchObject({
      contextLength: 1048576,
      supportsTools: true,
      supportsImages: true,
      pricing: { promptPerMTok: null },
    });
    expect(list[1]!.outputModalities).toContain('audio');
    expect(list[2]!.supportsTools).toBe(false);
    expect(parseGeminiModel({ nope: 1 })).toBeNull();
  });
  it('test de connexion : clé absente, clé invalide, réussite', async () => {
    const none = provider(() => ({ json: models }), { getApiKey: async () => null });
    expect((await none.p.testConnection('gemini-3.8-flash')).status).toBe('config_missing');
    const bad = provider(() => ({ status: 400, json: REAL_INVALID_KEY }));
    const r1 = await bad.p.testConnection('gemini-3.8-flash');
    expect(r1).toMatchObject({ ok: false, status: 'auth_invalid' });
    const good = provider((u) =>
      u.pathname.endsWith('/models') ? { json: models } : { json: answer([{ text: 'OK' }]) },
    );
    const r2 = await good.p.testConnection('gemini-3.8-flash');
    expect(r2).toMatchObject({ ok: true, status: 'ok', model: 'gemini-3.8-flash' });
    expect(good.calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/v1beta/models',
      '/v1beta/models/gemini-3.8-flash:generateContent',
    ]);
  });
  it('ProviderError masque la clé dans les messages', () => {
    expect(new ProviderError('bad_request', `échec avec ${KEY}`).message).not.toContain(KEY);
  });
});

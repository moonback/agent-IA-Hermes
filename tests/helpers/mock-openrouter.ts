/**
 * SIMULATED OpenRouter API for automated tests. Nothing here proves that the real API works:
 * it reproduces the documented wire format (JSON, SSE stream, errors) so HERMES logic can be tested offline.
 */
import { createServer, type Server } from 'node:http';

export interface MockReply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Raw SSE body (overrides automatic streaming of `json`). */
  sse?: string;
}

export interface ChatBody {
  model: string;
  stream?: boolean;
  messages: { role: string; content: unknown; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[];
  plugins?: unknown[];
}

export type ToolCallSpec = { name: string; args: unknown };
export type AgentStep =
  | { call: ToolCallSpec }
  | { complete: { summary: string; outputs?: Record<string, unknown> } }
  | { text: string };
type VerdictSpec = { verdict: 'pass' | 'partial' | 'fail'; reasons: string[] };

export interface Scenario {
  /** Plan returned to the planner (object is serialised as JSON); a function receives the request text. */
  plan?: unknown | ((request: string) => unknown);
  /** Scripted agent turns, indexed by the number of assistant messages already in the conversation. */
  agent?: AgentStep[] | ((body: ChatBody, turn: number) => AgentStep);
  verdict?: VerdictSpec | ((body: ChatBody) => VerdictSpec);
  /** Per-model HTTP failures, e.g. { 'mock/no-credit': 402 }. */
  modelErrors?: Record<string, number>;
  keyStatus?: number;
  models?: unknown[];
  usageCost?: number;
}

export const chatCompletion = (
  model: string,
  message: Record<string, unknown>,
  finish = 'stop',
  cost = 0.0001,
) => ({
  id: 'gen-mock',
  model,
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost },
});

export function toSse(completion: ReturnType<typeof chatCompletion>): string {
  const choice = completion.choices[0]!;
  const msg = choice.message as {
    content?: string | null;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  };
  const frames: unknown[] = [];
  if (msg.content) {
    for (const part of msg.content.match(/.{1,40}/gs) ?? [])
      frames.push({
        id: completion.id,
        model: completion.model,
        choices: [{ index: 0, delta: { content: part } }],
      });
  }
  msg.tool_calls?.forEach((tc, index) => {
    frames.push({
      id: completion.id,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } },
            ],
          },
        },
      ],
    });
    frames.push({
      id: completion.id,
      choices: [
        { index: 0, delta: { tool_calls: [{ index, function: { arguments: tc.function.arguments } }] } },
      ],
    });
  });
  frames.push({
    id: completion.id,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
    usage: completion.usage,
  });
  return `: OPENROUTER PROCESSING\n\n${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
}

const textOf = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));

/** Scenario router: planner / verifier / executing agents are recognised from their system prompt. */
export function scenarioHandler(sc: Scenario): (path: string, body: unknown) => MockReply {
  return (path, raw) => {
    if (path.endsWith('/models'))
      return { json: { data: sc.models ?? [mockModel('mock/model'), mockModel('mock/no-tools', false)] } };
    if (path.endsWith('/key')) {
      if (sc.keyStatus && sc.keyStatus !== 200)
        return {
          status: sc.keyStatus,
          json: { error: { code: sc.keyStatus, message: 'Invalid credentials' } },
        };
      return {
        json: {
          data: { label: 'test-key', usage: 0.12, limit: 5, limit_remaining: 4.88, is_free_tier: false },
        },
      };
    }
    const body = raw as ChatBody;
    const status = sc.modelErrors?.[body.model];
    if (status) return { status, json: { error: { code: status, message: `simulated error ${status}` } } };
    const system = textOf(body.messages[0]?.content ?? '');
    let completion;
    if (system.includes('planificateur')) {
      const plan =
        typeof sc.plan === 'function'
          ? (sc.plan as (r: string) => unknown)(textOf(body.messages[1]?.content ?? ''))
          : sc.plan;
      completion = chatCompletion(body.model, { content: JSON.stringify(plan) }, 'stop', sc.usageCost);
    } else if (system.includes('vérificateur')) {
      const v =
        typeof sc.verdict === 'function'
          ? sc.verdict(body)
          : (sc.verdict ?? { verdict: 'pass', reasons: ['Preuves conformes (simulation)'] });
      completion = chatCompletion(body.model, { content: JSON.stringify(v) }, 'stop', sc.usageCost);
    } else if (system.startsWith('Tu es l')) {
      const turn = body.messages.filter((m) => m.role === 'assistant').length;
      const step =
        typeof sc.agent === 'function'
          ? sc.agent(body, turn)
          : (sc.agent?.[turn] ?? { complete: { summary: 'Fin du scénario simulé' } });
      if ('call' in step) {
        completion = chatCompletion(
          body.model,
          {
            content: null,
            tool_calls: [
              {
                id: `call_${turn}`,
                type: 'function',
                function: {
                  name: step.call.name.replace(/\./g, '__'),
                  arguments: JSON.stringify(step.call.args),
                },
              },
            ],
          },
          'tool_calls',
          sc.usageCost,
        );
      } else if ('complete' in step) {
        completion = chatCompletion(
          body.model,
          {
            content: null,
            tool_calls: [
              {
                id: `call_${turn}`,
                type: 'function',
                function: { name: 'task__complete', arguments: JSON.stringify(step.complete) },
              },
            ],
          },
          'tool_calls',
          sc.usageCost,
        );
      } else completion = chatCompletion(body.model, { content: step.text }, 'stop', sc.usageCost);
    } else {
      completion = chatCompletion(body.model, { content: 'OK' }, 'stop', sc.usageCost);
    }
    return body.stream ? { sse: toSse(completion) } : { json: completion };
  };
}

export function mockModel(id: string, tools = true) {
  return {
    id,
    name: id,
    context_length: 128000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { max_completion_tokens: 4096 },
    supported_parameters: tools ? ['tools', 'temperature', 'response_format'] : ['temperature'],
  };
}

function toResponse(r: MockReply): Response {
  if (r.sse !== undefined)
    return new Response(r.sse, {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'text/event-stream', ...r.headers },
    });
  return new Response(JSON.stringify(r.json ?? {}), {
    status: r.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...r.headers },
  });
}

export interface RecordedCall {
  url: string;
  authorization: string | null;
  body: unknown;
}

/** In-process fetch replacement; records every call (to assert on headers and payloads). */
export function mockFetch(handler: (path: string, body: unknown) => MockReply | Promise<MockReply>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization'), body });
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    return toResponse(await handler(new URL(url).pathname, body));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Same simulation over real HTTP, for end-to-end tests of the running service. */
export function startMockServer(
  handler: (path: string, body: unknown) => MockReply,
): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const r = handler(new URL(req.url ?? '/', 'http://x').pathname, raw ? JSON.parse(raw) : undefined);
    if (r.sse !== undefined) {
      res.writeHead(r.status ?? 200, { 'Content-Type': 'text/event-stream' });
      res.end(r.sse);
    } else {
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.json ?? {}));
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/v1` });
    }),
  );
}

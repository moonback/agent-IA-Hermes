import { HermesError } from '../shared/errors';
import { redactString } from '../shared/redact';
import type { Logger, Telemetry } from '../observability/telemetry';
import {
  GEMINI_LIVE_DEFAULT_URL,
  normalizeGeminiModel,
  toFunctionDeclaration,
  validateGeminiBaseUrl,
} from './gemini';
import { ProviderError, backoffMs, type ProviderErrorKind } from './openrouter';
import type { ChatToolCall, ChatToolSpec, ConnectionTestResult } from './types';

/**
 * Gemini Live (BidiGenerateContent) client. Wire format as documented for the Live API:
 * client → `setup`, `realtimeInput`, `clientContent`, `toolResponse`;
 * server → `setupComplete`, `serverContent`, `toolCall`, `toolCallCancellation`, `goAway`,
 * `sessionResumptionUpdate`, `usageMetadata`. Every server frame is JSON (text or binary frame).
 */

/** Minimal WHATWG WebSocket surface used here (Node's global WebSocket satisfies it). */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

/** Node ≥ 22 global WebSocket (undici), which accepts request headers: the key never goes in the URL. */
export const nativeWebSocketFactory: WebSocketFactory = (url, headers) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string, init: unknown) => WebSocketLike }).WebSocket;
  if (!Ctor)
    throw new HermesError('CONFIG', 'WebSocket indisponible dans ce Node.js (version 22 ou plus requise)');
  return new Ctor(url, { headers });
};

const OPEN = 1;

export type LiveSpeaker = 'user' | 'agent';
export type LiveState = 'connecting' | 'ready' | 'reconnecting' | 'closed';

export interface LiveSessionConfig {
  /** e.g. 'gemini-3.8-live'. */
  model: string;
  voiceName?: string;
  languageCode?: string;
  systemInstruction?: string;
  tools?: ChatToolSpec[];
  /** Emotion-aware replies; enabled by default. */
  affectiveDialogue?: boolean;
  responseModalities?: ('AUDIO' | 'TEXT')[];
  /** Declares tools NON_BLOCKING: the model keeps talking while HERMES runs them. Default true. */
  nonBlockingTools?: boolean;
}

export interface LiveTurn {
  speaker: LiveSpeaker;
  text: string;
}

export interface LiveUsage {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
}

export interface GeminiLiveSession {
  readonly state: LiveState;
  readonly usage: LiveUsage;
  /** Last utterances (user and agent), used to restore context after a reconnection. */
  readonly history: readonly LiveTurn[];
  sendAudioChunk(pcm16: Buffer): void;
  /** Tells the server the microphone stream paused (client-side VAD detected silence). */
  endAudioStream(): void;
  sendText(text: string): void;
  sendToolResult(callId: string, result: unknown): void;
  /** Stops the current answer locally at once; its remaining audio is dropped. */
  interrupt(): void;
  close(): void;
  onAudioChunk: (pcm24: Buffer) => void;
  onTranscript: (text: string, final: boolean, speaker: LiveSpeaker) => void;
  onToolCall: (call: ChatToolCall) => void;
  onToolCallCancelled: (ids: string[]) => void;
  onTurnEnd: () => void;
  onInterrupted: (by: 'user' | 'server') => void;
  onStateChange: (state: LiveState, detail?: string) => void;
  onError: (err: ProviderError) => void;
}

export interface GeminiLiveOptions {
  getApiKey: () => Promise<string | null>;
  url?: string;
  webSocketFactory?: WebSocketFactory;
  allowLoopbackForTests?: boolean;
  telemetry?: Pick<Telemetry, 'live'>;
  logger?: Logger;
  maxReconnectAttempts?: number;
  /** Google caps a Live session at about 30 minutes: renewed transparently before that. */
  sessionMaxMs?: number;
  renewMarginMs?: number;
  setupTimeoutMs?: number;
  /** Utterances kept for context replay: 20 turns = 20 user + 20 agent utterances. */
  historyTurns?: number;
  backoff?: (attempt: number) => number;
}

// ------------------------------------------------------------------ helpers

/** Close codes: 1007/1008 carry auth and policy failures, which a reconnection cannot fix. */
export function classifyLiveClose(code: number, reason: string): ProviderError {
  const lower = reason.toLowerCase();
  let kind: ProviderErrorKind;
  if (/api key|unauthenticated|credential|permission/.test(lower)) kind = 'auth_invalid';
  else if (/quota|resource.?exhausted|rate/.test(lower)) kind = 'rate_limited';
  else if (/billing/.test(lower)) kind = 'insufficient_credits';
  else if (/model.*(not found|not supported)|unsupported model/.test(lower)) kind = 'model_unavailable';
  else if (code === 1008) kind = 'forbidden';
  else if (code === 1007) kind = 'bad_request';
  else if (code === 1011 || code === 1013 || code === 1000 || code === 1001) kind = 'provider_error';
  else kind = 'network';
  return new ProviderError(kind, `Session Gemini Live fermée (${code}${reason ? ` : ${reason}` : ''})`);
}

/** Converts little-endian signed 24-bit PCM to 16-bit (keeps the 16 most significant bits). */
export function pcm24To16(buf: Buffer): Buffer {
  const n = Math.floor(buf.length / 3);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = buf[i * 3 + 1]!;
    out[i * 2 + 1] = buf[i * 3 + 2]!;
  }
  return out;
}

async function frameText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (data && typeof (data as { text?: unknown }).text === 'function')
    return (data as { text(): Promise<string> }).text();
  return String(data);
}

const noop = () => undefined;

// ------------------------------------------------------------------ session

class LiveSession implements GeminiLiveSession {
  state: LiveState = 'connecting';
  usage: LiveUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
  history: LiveTurn[] = [];

  onAudioChunk: GeminiLiveSession['onAudioChunk'] = noop;
  onTranscript: GeminiLiveSession['onTranscript'] = noop;
  onToolCall: GeminiLiveSession['onToolCall'] = noop;
  onToolCallCancelled: GeminiLiveSession['onToolCallCancelled'] = noop;
  onTurnEnd: GeminiLiveSession['onTurnEnd'] = noop;
  onInterrupted: GeminiLiveSession['onInterrupted'] = noop;
  onStateChange: GeminiLiveSession['onStateChange'] = noop;
  onError: GeminiLiveSession['onError'] = noop;

  private ws: WebSocketLike | null = null;
  /** Socket confirmed by setupComplete but not yet swapped in: its frames are already handled. */
  private incoming: WebSocketLike | null = null;
  private resumeHandle: string | null = null;
  private closedByClient = false;
  private suppressAudio = false;
  private userText = '';
  private agentText = '';
  private readonly pendingCalls = new Map<string, string>();
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewing = false;

  constructor(
    private readonly provider: GeminiLiveProvider,
    private readonly cfg: LiveSessionConfig,
  ) {}

  // ---------------------------------------------------------------- connection

  setupMessage(): Record<string, unknown> {
    const c = this.cfg;
    const speechConfig: Record<string, unknown> = {};
    if (c.voiceName) speechConfig.voiceConfig = { prebuiltVoiceConfig: { voiceName: c.voiceName } };
    if (c.languageCode) speechConfig.languageCode = c.languageCode;
    const setup: Record<string, unknown> = {
      model: `models/${normalizeGeminiModel(c.model)}`,
      generationConfig: {
        responseModalities: c.responseModalities ?? ['AUDIO'],
        ...(Object.keys(speechConfig).length ? { speechConfig } : {}),
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // A resumption handle lets a new connection continue the same conversation.
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    };
    if (c.systemInstruction) setup.systemInstruction = { parts: [{ text: c.systemInstruction }] };
    if (c.tools?.length)
      setup.tools = [
        {
          functionDeclarations: c.tools.map((t) =>
            toFunctionDeclaration(t, c.nonBlockingTools === false ? {} : { behavior: 'NON_BLOCKING' }),
          ),
        },
      ];
    return { setup };
  }

  /** Opens one socket and resolves after `setupComplete`. Rejects with a classified ProviderError. */
  async connect(): Promise<WebSocketLike> {
    const key = await this.provider.opts.getApiKey();
    if (!key) throw new ProviderError('config_missing', 'Aucune clé Gemini configurée');
    const ws = this.provider.factory(this.provider.url, { 'x-goog-api-key': key });
    ws.binaryType = 'arraybuffer';
    return new Promise<WebSocketLike>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        ws.onclose = null;
        ws.close(1000, 'setup timeout');
        reject(new ProviderError('timeout', 'Gemini Live n’a pas confirmé la session à temps'));
      }, this.provider.setupTimeoutMs);
      ws.onopen = () => ws.send(JSON.stringify(this.setupMessage()));
      ws.onerror = noop; // a close event always follows and carries the reason
      ws.onmessage = (ev) => {
        void frameText(ev.data).then((text) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(text) as Record<string, unknown>;
          } catch {
            this.provider.log('warn', 'Trame Gemini Live illisible ignorée');
            return;
          }
          if (!ready && 'setupComplete' in msg) {
            ready = true;
            clearTimeout(timer);
            this.incoming = ws;
            resolve(ws);
            return;
          }
          // Frames from a socket being replaced are ignored once the swap happened.
          if (ready && (ws === this.ws || ws === this.incoming)) this.handle(msg);
        });
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!ready) reject(classifyLiveClose(ev.code, ev.reason));
        else if (ws === this.ws) this.onSocketLost(ev.code, ev.reason);
      };
    });
  }

  async start(): Promise<void> {
    this.ws = await this.connect();
    this.setState('ready');
    this.scheduleRenew();
  }

  private setState(state: LiveState, detail?: string) {
    this.state = state;
    this.onStateChange(state, detail);
  }

  private scheduleRenew() {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    const delay = Math.max(this.provider.sessionMaxMs - this.provider.renewMarginMs, 1000);
    this.renewTimer = setTimeout(() => void this.renew('limite de durée de session'), delay);
    this.renewTimer.unref?.();
  }

  /**
   * Make-before-break renewal (session time limit, `goAway`): the new socket is fully set up,
   * with the resumption handle, before the old one is closed, so audio is never cut.
   */
  async renew(reason: string): Promise<void> {
    if (this.renewing || this.closedByClient || this.state !== 'ready') return;
    this.renewing = true;
    const old = this.ws;
    try {
      const next = await this.connect();
      if (this.closedByClient) return next.close(1000, 'client');
      this.ws = next;
      this.afterReconnect();
      old?.close(1000, 'renew');
      this.provider.log('info', `Session Gemini Live renouvelée (${reason})`);
      this.scheduleRenew();
    } catch {
      // The old socket is still usable; when it drops, the reconnection path takes over.
    } finally {
      this.renewing = false;
    }
  }

  private onSocketLost(code: number, reason: string) {
    if (this.closedByClient) return;
    const err = classifyLiveClose(code, reason);
    if (!err.retryable) return this.fail(err);
    void this.reconnect(err);
  }

  private async reconnect(cause: ProviderError): Promise<void> {
    this.ws = null;
    const max = this.provider.maxReconnectAttempts;
    for (let attempt = 0; attempt < max && !this.closedByClient; attempt++) {
      this.setState('reconnecting', `${cause.message} — tentative ${attempt + 1}/${max}`);
      await new Promise((r) => setTimeout(r, this.provider.backoff(attempt)));
      if (this.closedByClient) return;
      try {
        this.ws = await this.connect();
        this.afterReconnect();
        this.setState('ready');
        this.scheduleRenew();
        return;
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError('network', String(err));
        if (!pe.retryable) return this.fail(pe);
        cause = pe;
      }
    }
    if (!this.closedByClient)
      this.fail(
        new ProviderError(
          cause.kind,
          `Reconnexion Gemini Live impossible après ${max} tentatives : ${cause.message}`,
        ),
      );
  }

  /** Without a resumption handle, the recent conversation is replayed as context (no reply requested). */
  private afterReconnect() {
    this.suppressAudio = false;
    if (this.resumeHandle || !this.history.length) return;
    this.send({
      clientContent: {
        turns: this.history.map((t) => ({
          role: t.speaker === 'user' ? 'user' : 'model',
          parts: [{ text: t.text }],
        })),
        turnComplete: false,
      },
    });
  }

  private fail(err: ProviderError) {
    this.closedByClient = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.setState('closed', err.message);
    this.onError(err);
  }

  // ---------------------------------------------------------------- inbound

  private handle(msg: Record<string, unknown>) {
    if (msg.usageMetadata) {
      const u = msg.usageMetadata as {
        promptTokenCount?: number;
        responseTokenCount?: number;
        totalTokenCount?: number;
      };
      this.usage.promptTokens += u.promptTokenCount ?? 0;
      this.usage.responseTokens += u.responseTokenCount ?? 0;
      this.usage.totalTokens += u.totalTokenCount ?? 0;
    }
    if (msg.sessionResumptionUpdate) {
      const r = msg.sessionResumptionUpdate as { newHandle?: unknown; resumable?: unknown };
      if (r.resumable !== false && typeof r.newHandle === 'string' && r.newHandle)
        this.resumeHandle = r.newHandle;
    }
    if (msg.goAway) void this.renew('goAway reçu du serveur');
    if (msg.toolCall) {
      // A tool call answers what the user just said: that utterance is complete.
      this.finalize('user');
      const calls = ((msg.toolCall as { functionCalls?: unknown }).functionCalls ?? []) as {
        id?: unknown;
        name?: unknown;
        args?: unknown;
      }[];
      for (const fc of calls) {
        if (typeof fc.name !== 'string') continue;
        const id = typeof fc.id === 'string' && fc.id ? fc.id : `live_call_${this.pendingCalls.size}`;
        this.pendingCalls.set(id, fc.name);
        this.onToolCall({
          id,
          type: 'function',
          function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
        });
      }
    }
    if (msg.toolCallCancellation) {
      const ids = ((msg.toolCallCancellation as { ids?: unknown }).ids ?? []) as unknown[];
      const valid = ids.filter((i): i is string => typeof i === 'string');
      for (const i of valid) this.pendingCalls.delete(i);
      if (valid.length) this.onToolCallCancelled(valid);
    }
    if (msg.serverContent) this.handleContent(msg.serverContent as Record<string, unknown>);
  }

  private handleContent(sc: Record<string, unknown>) {
    const input = sc.inputTranscription as { text?: unknown; finished?: unknown } | undefined;
    if (typeof input?.text === 'string' && input.text) {
      this.userText += input.text;
      this.transcript('user', this.userText, false);
    }
    if (input?.finished === true) this.finalize('user');

    const parts = ((sc.modelTurn as { parts?: unknown } | undefined)?.parts ?? []) as Record<
      string,
      unknown
    >[];
    const output = sc.outputTranscription as { text?: unknown } | undefined;
    // The model answering means the user's utterance is complete.
    if (parts.length || typeof output?.text === 'string') this.finalize('user');
    for (const part of parts) {
      const inline = part.inlineData as { mimeType?: unknown; data?: unknown } | undefined;
      if (inline && typeof inline.data === 'string' && String(inline.mimeType ?? '').startsWith('audio/')) {
        if (this.suppressAudio) continue;
        const raw = Buffer.from(inline.data, 'base64');
        const mime = String(inline.mimeType).toLowerCase();
        this.onAudioChunk(/bits=24|audio\/l24/.test(mime) ? pcm24To16(raw) : raw);
      } else if (typeof part.text === 'string' && part.thought !== true && part.text) {
        // TEXT modality: the text itself is the agent's answer.
        this.agentText += part.text;
        this.transcript('agent', this.agentText, false);
      }
    }
    if (typeof output?.text === 'string' && output.text) {
      this.agentText += output.text;
      if (!this.suppressAudio) this.transcript('agent', this.agentText, false);
    }
    if (sc.interrupted === true) {
      // The server stopped generating because the user spoke (barge-in).
      this.finalize('agent');
      this.suppressAudio = false;
      this.onInterrupted('server');
    }
    if (sc.turnComplete === true) {
      this.finalize('user');
      this.finalize('agent');
      this.suppressAudio = false;
      this.onTurnEnd();
    }
  }

  private transcript(speaker: LiveSpeaker, text: string, final: boolean) {
    this.onTranscript(text, final, speaker);
    this.provider.opts.telemetry?.live({
      type: 'voice.transcript',
      category: 'voice',
      agent: 'voice',
      data: { speaker, text, final },
    });
  }

  private finalize(speaker: LiveSpeaker) {
    const text = (speaker === 'user' ? this.userText : this.agentText).trim();
    if (speaker === 'user') this.userText = '';
    else this.agentText = '';
    if (!text) return;
    this.transcript(speaker, text, true);
    this.history.push({ speaker, text });
    const max = this.provider.historyTurns * 2;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }

  // ---------------------------------------------------------------- outbound

  private send(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendAudioChunk(pcm16: Buffer): void {
    // While reconnecting, live audio is dropped rather than replayed late.
    if (this.state !== 'ready' || !pcm16.length) return;
    this.send({
      realtimeInput: { audio: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' } },
    });
  }

  endAudioStream(): void {
    if (this.state === 'ready') this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  sendText(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.finalize('user');
    this.history.push({ speaker: 'user', text: t });
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: t }] }], turnComplete: true } });
  }

  sendToolResult(callId: string, result: unknown): void {
    const name = this.pendingCalls.get(callId);
    if (!name) return; // cancelled by the server or unknown: nothing to answer
    this.pendingCalls.delete(callId);
    const response =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : { result };
    this.send({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name,
            response,
            // NON_BLOCKING calls: the result is used once the model finishes what it is saying.
            ...(this.cfg.nonBlockingTools === false ? {} : { scheduling: 'WHEN_IDLE' }),
          },
        ],
      },
    });
  }

  interrupt(): void {
    // Local barge-in: playback stops now and the rest of this answer is discarded. The server
    // itself stops generating when its voice activity detection hears the user (`interrupted`).
    this.suppressAudio = true;
    this.finalize('agent');
    this.onInterrupted('user');
  }

  close(): void {
    if (this.closedByClient) return;
    this.closedByClient = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.finalize('user');
    this.finalize('agent');
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'client');
    this.setState('closed');
  }
}

// ------------------------------------------------------------------ provider

export class GeminiLiveProvider {
  readonly id = 'gemini-live';
  readonly url: string;
  readonly factory: WebSocketFactory;
  readonly maxReconnectAttempts: number;
  readonly sessionMaxMs: number;
  readonly renewMarginMs: number;
  readonly setupTimeoutMs: number;
  readonly historyTurns: number;
  readonly backoff: (attempt: number) => number;

  constructor(readonly opts: GeminiLiveOptions) {
    this.url = validateGeminiBaseUrl(opts.url ?? GEMINI_LIVE_DEFAULT_URL, {
      websocket: true,
      allowLoopbackForTests: opts.allowLoopbackForTests,
    });
    this.factory = opts.webSocketFactory ?? nativeWebSocketFactory;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 3;
    this.sessionMaxMs = opts.sessionMaxMs ?? 30 * 60_000;
    this.renewMarginMs = opts.renewMarginMs ?? 60_000;
    this.setupTimeoutMs = opts.setupTimeoutMs ?? 15_000;
    this.historyTurns = opts.historyTurns ?? 20;
    this.backoff = opts.backoff ?? ((attempt) => backoffMs(attempt, null));
  }

  async hasKey(): Promise<boolean> {
    return Boolean(await this.opts.getApiKey());
  }

  log(level: 'info' | 'warn', message: string): void {
    this.opts.logger?.log({ level, category: 'voice', message: redactString(message) });
  }

  /** Resolves once Gemini confirmed the setup; the returned session reconnects by itself afterwards. */
  async openSession(config: LiveSessionConfig): Promise<GeminiLiveSession> {
    const session = new LiveSession(this, config);
    await session.start();
    this.log('info', `Session Gemini Live ouverte (${config.model})`);
    return session;
  }

  /** Real round-trip: opens a session, waits for setupComplete, closes it. */
  async testConnection(model: string | null): Promise<ConnectionTestResult> {
    const testedAt = new Date().toISOString();
    const started = Date.now();
    const result = (
      status: ConnectionTestResult['status'],
      ok: boolean,
      message: string,
    ): ConnectionTestResult => ({
      status,
      ok,
      message: redactString(message),
      model,
      latencyMs: Date.now() - started,
      key: null,
      testedAt,
    });
    if (!(await this.hasKey())) return result('config_missing', false, 'Aucune clé API Gemini configurée.');
    if (!model)
      return result('model_unavailable', false, 'Aucun modèle Live sélectionné pour le rôle « voice ».');
    try {
      const s = await this.openSession({ model, responseModalities: ['AUDIO'] });
      s.close();
      return result('ok', true, `Session Live établie avec ${model}.`);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError('network', String(err));
      const status: ConnectionTestResult['status'] =
        pe.kind === 'auth_invalid' || pe.kind === 'forbidden'
          ? 'auth_invalid'
          : pe.kind === 'network' || pe.kind === 'timeout'
            ? 'network'
            : pe.kind === 'config_missing' ||
                pe.kind === 'rate_limited' ||
                pe.kind === 'insufficient_credits' ||
                pe.kind === 'model_unavailable'
              ? pe.kind
              : pe.kind === 'bad_request'
                ? 'model_unavailable'
                : 'provider_error';
      return result(status, false, pe.message);
    }
  }
}

// Uses a SIMULATED Gemini Live WebSocket: validates HERMES' protocol handling, not the real service.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TOOLS,
  GeminiLiveProvider,
  classifyLiveClose,
  pcm24To16,
  toChatToolSpec,
  type LiveEvent,
} from '@hermes/core';
import { fakeLiveFactory, tick } from '../helpers/mock-gemini-live';

const KEY = `AIzaSy${'L'.repeat(33)}`;

function provider(
  reply?: Parameters<typeof fakeLiveFactory>[0],
  over: Partial<ConstructorParameters<typeof GeminiLiveProvider>[0]> = {},
) {
  const f = fakeLiveFactory(reply);
  const live: LiveEvent[] = [];
  const p = new GeminiLiveProvider({
    getApiKey: async () => KEY,
    webSocketFactory: f.factory,
    telemetry: { live: (e: LiveEvent) => void live.push(e) },
    backoff: () => 1,
    ...over,
  });
  return { p, f, live };
}

afterEach(() => vi.useRealTimers());

describe('ouverture de session Gemini Live (simulée)', () => {
  it('envoie un setup complet et attend setupComplete', async () => {
    const { p, f } = provider();
    const s = await p.openSession({
      model: 'gemini-3.8-live',
      voiceName: 'Kore',
      languageCode: 'fr-FR',
      systemInstruction: 'Sois bref.',
      tools: [toChatToolSpec(ALL_TOOLS.find((t) => t.id === 'mission.pause')!)],
    });
    const sock = f.last();
    expect(sock.url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    );
    expect(sock.url).not.toContain(KEY);
    expect(sock.headers['x-goog-api-key']).toBe(KEY);
    const setup = sock.of('setup')[0]!;
    expect(setup).toMatchObject({
      model: 'models/gemini-3.8-live',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, languageCode: 'fr-FR' },
      },
      systemInstruction: { parts: [{ text: 'Sois bref.' }] },
      enableAffectiveDialog: true,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    });
    const decl = (setup.tools as { functionDeclarations: Record<string, unknown>[] }[])[0]!
      .functionDeclarations[0]!;
    expect(decl).toMatchObject({ name: 'mission__pause', behavior: 'NON_BLOCKING' });
    expect(s.state).toBe('ready');
    s.close();
  });
  it('désactive le dialogue affectif sur demande et refuse une clé absente', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live', affectiveDialogue: false });
    expect(f.last().of('setup')[0]!.enableAffectiveDialog).toBe(false);
    s.close();
    const none = new GeminiLiveProvider({ getApiKey: async () => null, webSocketFactory: f.factory });
    await expect(none.openSession({ model: 'gemini-3.8-live' })).rejects.toMatchObject({
      kind: 'config_missing',
    });
  });
  it('rejette une clé invalide (fermeture 1007, comme l’API réelle) sans reconnexion', async () => {
    const { p, f } = provider(() => ({
      close: 1007,
      reason: 'API key not valid. Please pass a valid API key.',
    }));
    await expect(p.openSession({ model: 'gemini-3.8-live' })).rejects.toMatchObject({ kind: 'auth_invalid' });
    expect(f.sockets).toHaveLength(1);
  });
  it('échoue proprement si le serveur ne confirme jamais', async () => {
    const { p } = provider(() => 'silent', { setupTimeoutMs: 30 });
    await expect(p.openSession({ model: 'gemini-3.8-live' })).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('refuse un hôte non Google pour le WebSocket', () => {
    expect(
      () => new GeminiLiveProvider({ getApiKey: async () => KEY, url: 'wss://evil.example/ws/x' }),
    ).toThrow(/non autorisé/);
  });
});

describe('flux audio, transcriptions et outils (simulés)', () => {
  it('envoie l’audio PCM 16 kHz en base64 et la fin de flux', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    s.sendAudioChunk(Buffer.from([1, 2, 3, 4]));
    s.endAudioStream();
    expect(f.last().of('realtimeInput')).toEqual([
      { audio: { data: 'AQIDBA==', mimeType: 'audio/pcm;rate=16000' } },
      { audioStreamEnd: true },
    ]);
    s.close();
  });
  it('reçoit l’audio 24 kHz (trames binaires JSON) et convertit le 24 bits', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const chunks: Buffer[] = [];
    s.onAudioChunk = (b) => chunks.push(b);
    f.last().emit({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAEC' } }] },
      },
    });
    f.last().emit({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000;bits=24',
                data: Buffer.from([1, 2, 3, 4, 5, 6]).toString('base64'),
              },
            },
          ],
        },
      },
    });
    await tick();
    expect(chunks[0]).toEqual(Buffer.from([0, 1, 2]));
    expect(chunks[1]).toEqual(Buffer.from([2, 3, 5, 6]));
    expect(pcm24To16(Buffer.from([0, 0, 0x80]))).toEqual(Buffer.from([0, 0x80]));
    s.close();
  });
  it('émet les transcriptions partielles puis finales, et les publie en direct (catégorie voice)', async () => {
    const { p, f, live } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const seen: [string, boolean, string][] = [];
    s.onTranscript = (t, fin, who) => seen.push([t, fin, who]);
    let ended = 0;
    s.onTurnEnd = () => ended++;
    const sock = f.last();
    sock.emit({ serverContent: { inputTranscription: { text: 'Mets en ' } } });
    sock.emit({ serverContent: { inputTranscription: { text: 'pause' } } });
    sock.emit({ serverContent: { outputTranscription: { text: 'C’est fait.' } } });
    sock.emit({ serverContent: { turnComplete: true } });
    await tick();
    expect(seen).toEqual([
      ['Mets en ', false, 'user'],
      ['Mets en pause', false, 'user'],
      ['Mets en pause', true, 'user'],
      ['C’est fait.', false, 'agent'],
      ['C’est fait.', true, 'agent'],
    ]);
    expect(ended).toBe(1);
    expect(s.history).toEqual([
      { speaker: 'user', text: 'Mets en pause' },
      { speaker: 'agent', text: 'C’est fait.' },
    ]);
    expect(live.every((e) => e.category === 'voice' && e.type === 'voice.transcript')).toBe(true);
    expect(live).toHaveLength(5);
    s.close();
  });
  it('relaie un appel d’outil non bloquant et renvoie le résultat nommé (WHEN_IDLE)', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const calls: unknown[] = [];
    s.onToolCall = (c) => calls.push(c);
    f.last().emit({
      toolCall: { functionCalls: [{ id: 'fc-1', name: 'mission_create', args: { request: 'test' } }] },
    });
    await tick();
    expect(calls).toEqual([
      { id: 'fc-1', type: 'function', function: { name: 'mission_create', arguments: '{"request":"test"}' } },
    ]);
    s.sendToolResult('fc-1', { missionId: 'msn_1' });
    s.sendToolResult('fc-1', { duplicate: true }); // already answered: ignored
    s.sendToolResult('inconnu', 'x');
    expect(f.last().of('toolResponse')).toEqual([
      {
        functionResponses: [
          { id: 'fc-1', name: 'mission_create', response: { missionId: 'msn_1' }, scheduling: 'WHEN_IDLE' },
        ],
      },
    ]);
    s.close();
  });
  it('n’envoie pas de résultat pour un appel annulé par le serveur', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const cancelled: string[][] = [];
    s.onToolCallCancelled = (ids) => cancelled.push(ids);
    f.last().emit({ toolCall: { functionCalls: [{ id: 'fc-2', name: 'mission_status', args: {} }] } });
    f.last().emit({ toolCallCancellation: { ids: ['fc-2'] } });
    await tick();
    s.sendToolResult('fc-2', { ok: true });
    expect(cancelled).toEqual([['fc-2']]);
    expect(f.last().of('toolResponse')).toEqual([]);
    s.close();
  });
  it('barge-in : interrupt() coupe l’audio restant jusqu’à la fin du tour, interrupted le réactive', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const chunks: Buffer[] = [];
    const by: string[] = [];
    s.onAudioChunk = (b) => chunks.push(b);
    s.onInterrupted = (w) => by.push(w);
    const audio = {
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] },
      },
    };
    const sock = f.last();
    sock.emit(audio);
    await tick();
    s.interrupt();
    sock.emit(audio); // rest of the interrupted answer
    await tick();
    expect(chunks).toHaveLength(1);
    sock.emit({ serverContent: { interrupted: true } });
    sock.emit(audio); // new answer to the user's new speech
    await tick();
    expect(chunks).toHaveLength(2);
    expect(by).toEqual(['user', 'server']);
    s.close();
  });
  it('envoie du texte comme tour client et accumule l’usage', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    s.sendText('Quel est l’état ?');
    f.last().emit({ usageMetadata: { promptTokenCount: 10, responseTokenCount: 4, totalTokenCount: 14 } });
    await tick();
    expect(f.last().of('clientContent')).toEqual([
      { turns: [{ role: 'user', parts: [{ text: 'Quel est l’état ?' }] }], turnComplete: true },
    ]);
    expect(s.usage).toEqual({ promptTokens: 10, responseTokens: 4, totalTokens: 14 });
    s.close();
  });
});

describe('reconnexion et renouvellement (simulés)', () => {
  it('reconnecte après une coupure réseau avec le jeton de reprise', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const states: string[] = [];
    s.onStateChange = (st) => states.push(st);
    f.last().emit({ sessionResumptionUpdate: { newHandle: 'h-42', resumable: true } });
    await tick();
    f.last().serverClose(1006, '');
    await tick(20);
    expect(f.sockets).toHaveLength(2);
    expect(f.last().of('setup')[0]!.sessionResumption).toEqual({ handle: 'h-42' });
    expect(f.last().of('clientContent')).toEqual([]); // the handle restores context server-side
    expect(states).toEqual(['reconnecting', 'ready']);
    s.close();
  });
  it('sans jeton de reprise, rejoue les derniers échanges comme contexte', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    f.last().emit({ serverContent: { inputTranscription: { text: 'Bonjour' } } });
    f.last().emit({ serverContent: { outputTranscription: { text: 'Salut !' }, turnComplete: true } });
    await tick();
    f.last().serverClose(1011, 'Internal error');
    await tick(20);
    expect(f.last().of('clientContent')).toEqual([
      {
        turns: [
          { role: 'user', parts: [{ text: 'Bonjour' }] },
          { role: 'model', parts: [{ text: 'Salut !' }] },
        ],
        turnComplete: false,
      },
    ]);
    s.close();
  });
  it('abandonne après 3 tentatives (backoff) et signale l’erreur', async () => {
    const { p, f } = provider((n) => (n === 0 ? 'complete' : { close: 1011, reason: 'unavailable' }));
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const errors: string[] = [];
    s.onError = (e) => errors.push(e.kind);
    f.last().serverClose(1006, '');
    await tick(50);
    expect(f.sockets).toHaveLength(4); // 1 initial + 3 attempts
    expect(s.state).toBe('closed');
    expect(errors).toEqual(['provider_error']);
  });
  it('ne reconnecte pas une erreur d’authentification survenue en cours de session', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const errors: string[] = [];
    s.onError = (e) => errors.push(e.kind);
    f.last().serverClose(1008, 'Permission denied');
    await tick(20);
    expect(f.sockets).toHaveLength(1);
    expect(errors).toEqual(['auth_invalid']);
  });
  it('goAway : nouvelle connexion établie avant de fermer l’ancienne (sans coupure)', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    const first = f.last();
    first.emit({ sessionResumptionUpdate: { newHandle: 'h-1' } });
    first.emit({ goAway: { timeLeft: '10s' } });
    await tick(20);
    const second = f.last();
    expect(second).not.toBe(first);
    expect(first.closedWith).toEqual({ code: 1000, reason: 'renew' });
    expect(second.of('setup')[0]!.sessionResumption).toEqual({ handle: 'h-1' });
    s.sendAudioChunk(Buffer.from([9]));
    expect(second.of('realtimeInput')).toHaveLength(1);
    expect(first.of('realtimeInput')).toHaveLength(0);
    s.close();
  });
  it('renouvelle la session avant la limite de 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { p, f } = provider(undefined, { sessionMaxMs: 30 * 60_000, renewMarginMs: 60_000 });
    const opening = p.openSession({ model: 'gemini-3.8-live' });
    await vi.advanceTimersByTimeAsync(10);
    const s = await opening;
    expect(f.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29 * 60_000 + 10);
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[0]!.closedWith?.reason).toBe('renew');
    s.close();
  });
  it('close() ferme sans reconnexion', async () => {
    const { p, f } = provider();
    const s = await p.openSession({ model: 'gemini-3.8-live' });
    s.close();
    f.last().serverClose(1000, '');
    await tick(20);
    expect(f.sockets).toHaveLength(1);
    expect(s.state).toBe('closed');
  });
  it('classe les codes de fermeture', () => {
    expect(classifyLiveClose(1007, 'API key not valid').kind).toBe('auth_invalid');
    expect(classifyLiveClose(1011, 'RESOURCE_EXHAUSTED: quota').kind).toBe('rate_limited');
    expect(classifyLiveClose(1006, '').retryable).toBe(true);
    expect(classifyLiveClose(1008, 'policy').retryable).toBe(false);
  });
  it('test de connexion Live : réussite et clé invalide', async () => {
    const ok = provider();
    expect(await ok.p.testConnection('gemini-3.8-live')).toMatchObject({ ok: true, status: 'ok' });
    const bad = provider(() => ({ close: 1007, reason: 'API key not valid. Please pass a valid API key.' }));
    expect(await bad.p.testConnection('gemini-3.8-live')).toMatchObject({
      ok: false,
      status: 'auth_invalid',
    });
    expect(await ok.p.testConnection(null)).toMatchObject({ ok: false, status: 'model_unavailable' });
  });
});

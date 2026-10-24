// Voice pipeline with the REAL runtime (orchestrator, store, tools) and a SIMULATED Gemini Live
// served over a real local WebSocket (Node's native client). Proves HERMES' wiring, not Google's service.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_KEY_NAME,
  GEMINI_KEY_NAME,
  MemorySecretStore,
  UnavailableDesktopAdapter,
  createRuntime,
  type VoiceServerEvent,
} from '@hermes/core';
import { mockFetch, scenarioHandler } from '../helpers/mock-openrouter';
import {
  TEST_KEY,
  createTestRuntime,
  filesPlan,
  tempDir,
  waitForMissionStatus,
  type TestRuntime,
} from '../helpers/runtime';
import { startMockLiveServer, toneBase64 } from '../helpers/mock-gemini-live';

const GKEY = `AIzaSy${'V'.repeat(33)}`;
let t: TestRuntime | null = null;
let live: Awaited<ReturnType<typeof startMockLiveServer>> | null = null;
const bridges: { stop(): void }[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) b.stop();
  await t?.cleanup();
  await live?.close();
  t = null;
  live = null;
});

const until = async (cond: () => boolean, ms = 10_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition non atteinte');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function setup(script: Parameters<typeof startMockLiveServer>[0]) {
  live = await startMockLiveServer({ expectedKey: GKEY, ...script });
  t = await createTestRuntime((ws) => ({ plan: filesPlan(join(ws, 'voix.txt')) }), {
    runtime: { geminiLiveUrl: live.url, allowLoopbackProviderForTests: true },
  });
  await t.rt.secrets.set(GEMINI_KEY_NAME, GKEY);
  const events: VoiceServerEvent[] = [];
  const audio: Buffer[] = [];
  const bridge = t.rt.createVoiceBridge({ audio: (b) => audio.push(b), event: (e) => events.push(e) });
  bridges.push(bridge);
  return { rt: t.rt, bridge, events, audio, live };
}

describe('pont audio vocal (Gemini Live simulé, runtime réel)', () => {
  it('ouvre la session avec la voix, la langue, l’invite vocale et les outils de contrôle', async () => {
    const { rt, bridge, events, live } = await setup({});
    rt.settings.setVoice({ voiceName: 'Puck', languageCode: 'fr-FR' });
    await bridge.start();
    const setupMsg = live.received.find((m) => 'setup' in m)!.setup as Record<string, unknown>;
    expect(live.headers[0]!.key).toBe(GKEY);
    expect(setupMsg.model).toBe('models/gemini-3.8-live');
    expect(JSON.stringify(setupMsg.systemInstruction)).toContain('Tu es la voix de HERMES');
    const names = (setupMsg.tools as { functionDeclarations: { name: string; behavior: string }[] }[])[0]!
      .functionDeclarations;
    expect(names.map((d) => d.name)).toContain('mission_create');
    expect(names.every((d) => d.behavior === 'NON_BLOCKING')).toBe(true);
    expect(events[0]).toMatchObject({ type: 'ready', model: 'gemini-3.8-live' });
    bridge.stop();
    const ended = rt.store.listEvents({ category: 'voice' }).find((e) => e.type === 'voice.session_ended')!;
    expect(ended).toBeTruthy();
    expect(JSON.stringify(ended.data)).not.toMatch(/transcript|texte/);
  });

  it('voix → mission réelle : audio, transcription, appel d’outil, plan annoncé, historique normal', async () => {
    const { rt, bridge, events, audio, live } = await setup({
      onMessage: (msg, reply, state) => {
        if ((msg.realtimeInput as { audio?: unknown } | undefined)?.audio && state.audioChunks === 3) {
          reply({
            serverContent: {
              inputTranscription: { text: 'Écris un fichier voix.txt dans le dossier de travail' },
            },
          });
          reply({
            toolCall: {
              functionCalls: [
                {
                  id: 'fc-1',
                  name: 'mission_create',
                  args: { request: 'Écrire voix.txt dans le dossier de travail' },
                },
              ],
            },
          });
          reply({
            serverContent: {
              modelTurn: {
                parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: toneBase64(40) } }],
              },
            },
          });
          reply({
            serverContent: { outputTranscription: { text: 'Je prépare le plan.' }, turnComplete: true },
          });
        }
      },
    });
    await bridge.start();
    for (let i = 0; i < 3; i++) bridge.pushAudio(Buffer.alloc(640));
    bridge.endAudio();
    await until(() => events.some((e) => e.type === 'mission'));
    const missionId = (events.find((e) => e.type === 'mission') as { missionId: string }).missionId;

    // The tool result went back to Gemini with the real mission id.
    await until(() => live.received.some((m) => 'toolResponse' in m));
    const resp = live.received.find((m) => 'toolResponse' in m)!.toolResponse as {
      functionResponses: Record<string, unknown>[];
    };
    expect(resp.functionResponses[0]).toMatchObject({
      id: 'fc-1',
      name: 'mission_create',
      response: { ok: true, missionId },
    });
    expect(audio.length).toBeGreaterThan(0);
    expect(events).toContainEqual({
      type: 'transcript',
      speaker: 'user',
      text: 'Écris un fichier voix.txt dans le dossier de travail',
      final: true,
    });
    expect(events).toContainEqual({
      type: 'transcript',
      speaker: 'agent',
      text: 'Je prépare le plan.',
      final: true,
    });

    // The mission is an ordinary one: planned by the planner, listed in history, with a voice event.
    const m = await waitForMissionStatus(rt, missionId, ['planned', 'failed']);
    expect(m.status).toBe('planned');
    expect(m.request).toMatch(/Demande dictée à la voix/);
    expect(rt.store.listMissions({ limit: 10 }).map((x) => x.id)).toContain(missionId);
    expect(rt.store.listEvents({ missionId }).map((e) => e.type)).toContain('voice.mission_created');
    // …and Gemini is told the plan is ready so it can ask whether to start it.
    await until(() =>
      live.received.some((x) => JSON.stringify(x.clientContent ?? '').includes('[Notification HERMES]')),
    );
    expect(events.some((e) => e.type === 'mission_update' && e.event === 'plan.created')).toBe(true);
    bridge.stop();
  });

  it('commande spéciale « Arrêt d’urgence » exécutée de façon déterministe et signalée au modèle', async () => {
    const { rt, bridge, events, live } = await setup({
      onMessage: (msg, reply) => {
        if ((msg.realtimeInput as { audioStreamEnd?: unknown } | undefined)?.audioStreamEnd) {
          reply({ serverContent: { inputTranscription: { text: 'Arrêt d’urgence !' } } });
          reply({ serverContent: { turnComplete: true } });
        }
      },
    });
    await bridge.start();
    bridge.endAudio();
    await until(() => events.some((e) => e.type === 'command'));
    expect(events.find((e) => e.type === 'command')).toMatchObject({ command: 'emergency_stop', ok: true });
    expect(rt.executor.isHalted).toBe(true);
    expect(rt.store.listEvents({ category: 'voice' }).map((e) => e.type)).toContain('voice.command');
    await until(() =>
      live.received.some((x) => JSON.stringify(x.clientContent ?? '').includes('emergency_stop')),
    );
    rt.orchestrator.rearm();
    bridge.stop();
  });

  it('texte saisi, pause vocale d’une mission en cours et clé Gemini refusée', async () => {
    const { rt, bridge, events } = await setup({});
    await bridge.start();
    bridge.sendText('Pause');
    await until(() => events.some((e) => e.type === 'command'));
    // No mission at all: the command fails cleanly and says why.
    expect(events.find((e) => e.type === 'command')).toMatchObject({ command: 'pause', ok: false });
    bridge.stop();

    await rt.secrets.set(GEMINI_KEY_NAME, `AIzaSy${'X'.repeat(33)}`);
    const other = rt.createVoiceBridge({ audio: () => undefined, event: () => undefined });
    await expect(other.start()).rejects.toMatchObject({ kind: 'auth_invalid' });
  });
});

describe('routage des fournisseurs par rôle (simulé)', () => {
  it('la planification passe par Gemini, l’exécution reste sur OpenRouter', async () => {
    const dir = tempDir();
    const ws = join(dir, 'workspace');
    const plan = filesPlan(join(ws, 'routage.txt'));
    const secrets = new MemorySecretStore();
    await secrets.set(API_KEY_NAME, TEST_KEY);
    await secrets.set(GEMINI_KEY_NAME, GKEY);
    const openRouter = mockFetch(
      scenarioHandler({
        agent: [
          { call: { name: 'files.write', args: { path: join(ws, 'routage.txt'), content: 'ok' } } },
          { complete: { summary: 'écrit' } },
        ],
      }),
    );
    const geminiCalls: { path: string; key: string | null }[] = [];
    // Gemini REST answers the planner (SSE stream, as requested by the gateway); the rest goes to OpenRouter.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://generativelanguage.googleapis.com/'))
        return openRouter.fetchImpl(input, init);
      geminiCalls.push({
        path: new URL(url).pathname,
        key: new Headers(init?.headers).get('x-goog-api-key'),
      });
      const chunk = {
        candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] }, finishReason: 'STOP' }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const rt = await createRuntime({
      dataDir: dir,
      secrets,
      fetchImpl,
      desktop: new UnavailableDesktopAdapter('tests'),
    });
    try {
      rt.settings.setAssignment('primary', 'mock/model', []);
      rt.settings.setAssignment('planning', 'gemini-3.8-flash', []);
      rt.settings.setRoleProviders({ planning: 'gemini' });
      const m = rt.orchestrator.createMission('Écris routage.txt');
      const planned = await waitForMissionStatus(rt, m.id, ['planned', 'failed']);
      expect({ status: planned.status, error: planned.error }).toEqual({ status: 'planned', error: null });
      expect(geminiCalls).toEqual([
        { path: '/v1beta/models/gemini-3.8-flash:streamGenerateContent', key: GKEY },
      ]);
      expect(openRouter.calls).toHaveLength(0);
      rt.orchestrator.start(m.id);
      const done = await waitForMissionStatus(rt, m.id, ['completed', 'failed']);
      expect(done.status).toBe('completed');
      // Execution (role "execution", unassigned → follows primary → OpenRouter).
      expect(openRouter.calls.length).toBeGreaterThan(0);
      expect(geminiCalls).toHaveLength(1);
      expect(() => rt.settings.setRoleProviders({ voice: 'openrouter' })).toThrow();
    } finally {
      await rt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

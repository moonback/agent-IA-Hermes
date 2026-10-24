import { describe, expect, it } from 'vitest';
import {
  AGENTS,
  ConversationWindow,
  GEMINI_LIVE_LANGUAGES,
  GEMINI_VOICES,
  MODEL_ROLES,
  VoiceAgent,
  VoiceSettings,
  detectVoiceCommand,
  sanitizeTranscript,
  voiceToolSpecs,
  type Mission,
  type VoiceAgentDeps,
} from '@hermes/core';

describe('commandes vocales spéciales', () => {
  it.each([
    ['Pause', 'pause'],
    ['Mets en pause.', 'pause'],
    ['Hermes, pause s’il te plaît', 'pause'],
    ['Annule !', 'cancel'],
    ['Stop', 'cancel'],
    ['Arrêt d’urgence', 'emergency_stop'],
    ["ARRÊT D'URGENCE", 'emergency_stop'],
    ['Rapport', 'report'],
    ['Résume', 'report'],
    ['Reprends', 'resume'],
  ])('« %s » → %s', (text, cmd) => {
    expect(detectVoiceCommand(text)).toBe(cmd);
  });
  it.each([
    'Explique-moi comment mettre en pause une mission',
    'Annule le rendez-vous de demain dans mon agenda',
    'Le rapport de la semaine dernière était bien',
    '',
  ])('ne déclenche rien pour « %s »', (text) => {
    expect(detectVoiceCommand(text)).toBeNull();
  });
});

describe('fenêtre de conversation et transcriptions', () => {
  it('garde les 20 derniers tours (20 énoncés utilisateur + 20 réponses)', () => {
    const w = new ConversationWindow();
    for (let i = 0; i < 30; i++) {
      w.push('user', `question ${i}`);
      w.push('agent', `réponse ${i}`);
    }
    expect(w.size).toBe(40);
    expect(w.recent()[0]).toMatchObject({ speaker: 'user', text: 'question 10' });
    expect(w.recent().at(-1)).toMatchObject({ speaker: 'agent', text: 'réponse 29' });
  });
  it('nettoie les transcriptions (caractères de contrôle, longueur)', () => {
    expect(sanitizeTranscript('a\u0000b\n\tc   d')).toBe('a b c d');
    expect(sanitizeTranscript('x'.repeat(900))).toHaveLength(500);
    const w = new ConversationWindow();
    w.push('user', '   ');
    expect(w.size).toBe(0);
  });
});

describe('agent vocal : définition et outils', () => {
  it('est un agent non exécutant servi par le rôle voice', () => {
    expect(MODEL_ROLES).toContain('voice');
    expect(AGENTS.voice).toMatchObject({ executes: false, modelRole: 'voice' });
    expect(AGENTS.voice.systemPrompt).toMatch(/confirmation orale explicite/);
    expect(AGENTS.voice.systemPrompt).toMatch(/jamais à la voix/);
  });
  it('expose des déclarations de fonctions valides pour Gemini', () => {
    const specs = voiceToolSpecs();
    expect(specs.map((s) => s.function.name)).toEqual([
      'mission_create',
      'mission_start',
      'mission_pause',
      'mission_cancel',
      'mission_status',
      'mission_report',
      'missions_recent',
      'approvals_pending',
      'emergency_stop',
    ]);
    for (const s of specs) {
      expect(s.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(s.function.parameters).not.toHaveProperty('$schema');
    }
    expect((specs[1]!.function.parameters as { required?: string[] }).required).toContain('confirmed');
  });
  it('propose 30 voix et 24 langues, avec des réglages validés', () => {
    expect(GEMINI_VOICES).toHaveLength(30);
    expect(GEMINI_LIVE_LANGUAGES).toHaveLength(24);
    expect(VoiceSettings.parse({})).toEqual({
      voiceName: 'Kore',
      languageCode: 'fr-FR',
      affectiveDialogue: true,
      mode: 'vad',
      vadSensitivity: 0.5,
    });
    expect(() => VoiceSettings.parse({ voiceName: 'Inconnue' })).toThrow();
    expect(() => VoiceSettings.parse({ languageCode: 'xx-XX' })).toThrow();
  });
});

describe('agent vocal : garde-fous (orchestrateur factice)', () => {
  const mission = (over: Partial<Mission> = {}): Mission =>
    ({
      id: 'msn_1',
      request: 'Ranger les PDF',
      status: 'planned',
      plan: { summary: 'Ranger', steps: [], successCriteria: ['ok'] },
      result: null,
      usage: {
        aiCalls: 1,
        toolCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0.001,
        costKnown: true,
      },
      ...over,
    }) as Mission;
  const fake = (m: Mission | null, calls: string[]): VoiceAgentDeps => ({
    orchestrator: {
      createMission: (r: string) => (calls.push(`create:${r}`), mission({ status: 'planning' })),
      start: (id: string) => (calls.push(`start:${id}`), mission({ status: 'running' })),
      pause: (id: string) => void calls.push(`pause:${id}`),
      cancel: (id: string) => (calls.push(`cancel:${id}`), mission({ status: 'cancelled' })),
      emergencyStop: async () => (
        calls.push('emergency'),
        { missions: ['msn_1'], uncertainToolCalls: [], killedProcesses: 0 }
      ),
      isActive: () => true,
    },
    store: {
      getMission: () => m,
      listMissions: () => (m ? [m] : []),
      listTasks: () => [],
      listApprovals: () => [],
    },
    telemetry: { record: () => ({}) as never },
  });
  const call = (name: string, args: unknown) => ({
    id: 'c',
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });

  it('exige une confirmation orale avant de lancer ou d’annuler', async () => {
    const calls: string[] = [];
    const a = new VoiceAgent(fake(mission(), calls));
    expect(await a.execute(call('mission_start', { confirmed: false }))).toMatchObject({
      ok: false,
      needsConfirmation: true,
    });
    expect(await a.execute(call('mission_cancel', { confirmed: false }))).toMatchObject({
      ok: false,
      needsConfirmation: true,
    });
    expect(calls).toEqual([]);
    expect(await a.execute(call('mission_start', { confirmed: true }))).toMatchObject({ ok: true });
    expect(calls).toEqual(['start:msn_1']);
  });
  it('rejette les outils inconnus et les arguments invalides sans exception', async () => {
    const a = new VoiceAgent(fake(mission(), []));
    expect(await a.execute(call('files__write', {}))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/inconnu/),
    });
    expect(await a.execute(call('mission_create', { request: 'x' }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalides/),
    });
    expect(
      await a.execute({
        ...call('mission_status', {}),
        function: { name: 'mission_status', arguments: '{oops' },
      }),
    ).toMatchObject({
      ok: false,
    });
  });
  it('n’autorise pas les approbations à la voix et exécute les commandes directes', async () => {
    const calls: string[] = [];
    const a = new VoiceAgent(fake(mission({ status: 'running' }), calls));
    expect(await a.execute(call('approvals_pending', {}))).toMatchObject({
      ok: true,
      message: expect.stringMatching(/interface/),
    });
    expect(await a.runCommand('pause')).toMatchObject({ ok: true });
    expect(await a.runCommand('emergency_stop')).toMatchObject({ ok: true, missions: 1 });
    expect(calls).toEqual(['pause:msn_1', 'emergency']);
  });
});

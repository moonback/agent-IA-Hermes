import { errorMessage } from '../shared/errors';
import type { MissionEvent, VoiceServerEvent } from '../shared/contracts';
import type { Telemetry } from '../observability/telemetry';
import type { GeminiLiveProvider, GeminiLiveSession } from '../model-providers/gemini-live';
import { ProviderError } from '../model-providers/openrouter';
import { VOICE_SYSTEM_PROMPT } from '../agents/definitions';
import { clockContext } from '../shared/util';
import { VoiceAgent, detectVoiceCommand, voiceToolSpecs } from './voice-agent';

export interface VoiceSink {
  audio(pcm24: Buffer): void;
  event(e: VoiceServerEvent): void;
}

export interface VoiceSessionSettings {
  model: string;
  voiceName: string | null;
  languageCode: string | null;
  affectiveDialogue: boolean;
}

/** Mission events worth saying out loud for missions created during the voice session. */
const NOTIFY = new Set([
  'plan.created',
  'plan.failed',
  'approval.requested',
  'mission.verified',
  'mission.cancelled',
  'mission.paused',
  'mission.crashed',
  'budget.exceeded',
]);

/**
 * Server-side bridge for one voice conversation: microphone audio → Gemini Live, Live audio and
 * transcripts → client, Live tool calls → VoiceAgent (orchestrator), and spoken notifications
 * about the missions it created. It never runs machine tools itself.
 */
export class AudioBridge {
  private session: GeminiLiveSession | null = null;
  private stopped = false;
  private readonly startedAt = Date.now();
  private utterances = { user: 0, agent: 0 };
  private readonly onMissionEvent = (e: MissionEvent) => this.notify(e);

  constructor(
    private readonly d: {
      live: Pick<GeminiLiveProvider, 'openSession'>;
      agent: VoiceAgent;
      telemetry: Telemetry;
      settings: VoiceSessionSettings;
      sink: VoiceSink;
    },
  ) {}

  get agent(): VoiceAgent {
    return this.d.agent;
  }

  async start(): Promise<void> {
    const s = this.d.settings;
    const session = await this.d.live.openSession({
      model: s.model,
      voiceName: s.voiceName ?? undefined,
      languageCode: s.languageCode ?? undefined,
      affectiveDialogue: s.affectiveDialogue,
      systemInstruction: `${VOICE_SYSTEM_PROMPT}\n${clockContext()}`,
      tools: voiceToolSpecs(),
    });
    if (this.stopped) return session.close();
    this.session = session;
    const sink = this.d.sink;
    session.onAudioChunk = (pcm) => sink.audio(pcm);
    session.onTranscript = (text, final, speaker) => {
      sink.event({ type: 'transcript', speaker, text, final });
      if (final) void this.onUtterance(speaker, text);
    };
    session.onToolCall = (call) => {
      void this.d.agent.execute(call).then((result) => {
        session.sendToolResult(call.id, result);
        const missionId = typeof result.missionId === 'string' ? result.missionId : undefined;
        sink.event({
          type: 'tool',
          name: call.function.name,
          ok: result.ok,
          missionId,
          message: result.ok ? (result.message as string | undefined) : result.error,
        });
        if (call.function.name === 'mission_create' && result.ok && missionId)
          sink.event({ type: 'mission', missionId });
      });
    };
    session.onInterrupted = (by) => sink.event({ type: 'interrupted', by });
    session.onTurnEnd = () => sink.event({ type: 'turn_end' });
    session.onStateChange = (state, detail) => sink.event({ type: 'state', state, detail });
    session.onError = (err) => {
      sink.event({ type: 'error', code: err.kind, message: err.message });
      this.stop(`erreur : ${err.message}`);
    };
    this.d.telemetry.on('event', this.onMissionEvent);
    this.d.telemetry.record({
      agent: 'voice',
      category: 'voice',
      type: 'voice.session_started',
      message: `Session vocale ouverte (${s.model}${s.voiceName ? `, voix ${s.voiceName}` : ''})`,
      data: {
        model: s.model,
        voice: s.voiceName,
        language: s.languageCode,
        affectiveDialogue: s.affectiveDialogue,
      },
    });
    sink.event({ type: 'ready', model: s.model, voice: s.voiceName, language: s.languageCode });
  }

  private async onUtterance(speaker: 'user' | 'agent', text: string) {
    this.d.agent.window.push(speaker, text);
    this.utterances[speaker]++;
    if (speaker !== 'user') return;
    const cmd = detectVoiceCommand(text);
    if (!cmd) return;
    const r = await this.d.agent.runCommand(cmd);
    const message = r.ok ? String(r.message ?? 'Commande exécutée.') : r.error;
    this.d.sink.event({
      type: 'command',
      command: cmd,
      ok: r.ok,
      message,
      missionId: typeof r.missionId === 'string' ? r.missionId : undefined,
    });
    // The model heard the same words: it is told the command already ran so it does not repeat it.
    this.session?.sendText(
      cmd === 'report' && r.ok
        ? `[Notification HERMES] Rapport demandé. Données : ${JSON.stringify(r).slice(0, 3000)}. Résume-le oralement en deux ou trois phrases.`
        : `[Notification HERMES] Commande « ${cmd} » ${r.ok ? 'exécutée' : 'non exécutée'} : ${message} Confirme-le en une phrase, sans appeler d'outil.`,
    );
  }

  private notify(e: MissionEvent) {
    if (!e.missionId || !this.d.agent.missions.has(e.missionId) || !NOTIFY.has(e.type)) return;
    this.d.sink.event({ type: 'mission_update', missionId: e.missionId, event: e.type, message: e.message });
    const hint =
      e.type === 'plan.created'
        ? ' Résume le plan en une phrase et demande si tu dois le lancer.'
        : e.type === 'approval.requested'
          ? " Dis à l'utilisateur qu'une action attend sa décision à l'écran."
          : '';
    this.session?.sendText(`[Notification HERMES] Mission ${e.missionId} : ${e.message}.${hint}`);
  }

  pushAudio(pcm16: Buffer): void {
    this.session?.sendAudioChunk(pcm16);
  }
  endAudio(): void {
    this.session?.endAudioStream();
  }
  sendText(text: string): void {
    const t = text.trim().slice(0, 2000);
    if (!t) return;
    this.d.sink.event({ type: 'transcript', speaker: 'user', text: t, final: true });
    void this.onUtterance('user', t);
    this.session?.sendText(t);
  }
  interrupt(): void {
    this.session?.interrupt();
  }

  stop(reason = 'fin de session'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.d.telemetry.off('event', this.onMissionEvent);
    const usage = this.session?.usage;
    const opened = this.session !== null;
    this.session?.close();
    this.session = null;
    this.d.sink.event({ type: 'closed', reason });
    if (!opened) return; // never connected: voice.session_failed is recorded by the caller
    this.d.telemetry.record({
      agent: 'voice',
      category: 'voice',
      type: 'voice.session_ended',
      message: `Session vocale terminée (${reason}) — ${this.utterances.user} énoncé(s) utilisateur, ${this.d.agent.missions.size} mission(s) créée(s)`,
      // Counts only: the spoken content itself is not written to the audit log.
      data: {
        durationSec: Math.round((Date.now() - this.startedAt) / 1000),
        utterances: this.utterances,
        missions: [...this.d.agent.missions],
        usage: usage ?? null,
      },
    });
  }
}

export function voiceErrorMessage(err: unknown): { code: string; message: string } {
  return err instanceof ProviderError
    ? { code: err.kind, message: err.message }
    : { code: 'INTERNAL', message: errorMessage(err) };
}

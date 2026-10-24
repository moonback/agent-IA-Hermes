import { z } from 'zod';
import type { Mission, MissionStatus } from '../shared/contracts';
import { TERMINAL_MISSION_STATUSES } from '../shared/state-machine';
import { HermesError, errorMessage } from '../shared/errors';
import type { HermesStore } from '../persistence/store';
import type { Telemetry } from '../observability/telemetry';
import type { Orchestrator } from '../orchestrator/orchestrator';
import type { ChatToolCall, ChatToolSpec } from '../model-providers/types';

/**
 * Conversational voice agent (non-executing). It never calls a ToolExecutor tool: every action on
 * the machine goes through a mission, so plans, policy, approvals, budgets and audit stay intact.
 * Its own tools only drive the orchestrator and read the store.
 */

export type VoiceCommand = 'pause' | 'resume' | 'cancel' | 'emergency_stop' | 'report';

const COMMANDS: Record<VoiceCommand, string[]> = {
  pause: ['pause', 'mets en pause', 'met en pause', 'pause la mission', 'mets la mission en pause'],
  resume: ['reprends', 'reprend', 'continue', 'reprends la mission', 'continue la mission'],
  cancel: ['annule', 'annuler', 'annule la mission', 'annule tout', 'stop', 'stoppe la mission'],
  emergency_stop: ['arret d urgence', 'arret durgence', 'arrete tout', 'urgence', 'stop urgence'],
  report: [
    'rapport',
    'le rapport',
    'fais moi le rapport',
    'donne moi le rapport',
    'resume',
    'resume la mission',
  ],
};

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(ok |dis )?hermes /, '')
    .replace(/ (s il te plait|s il vous plait|maintenant|merci)$/, '');

/**
 * Special commands are matched only when the whole utterance is the command (a few words):
 * "pause" triggers, "explique-moi comment mettre en pause" does not.
 */
export function detectVoiceCommand(text: string): VoiceCommand | null {
  const n = normalize(text);
  if (!n || n.split(' ').length > 5) return null;
  for (const [cmd, phrases] of Object.entries(COMMANDS) as [VoiceCommand, string[]][])
    if (phrases.includes(n)) return cmd;
  return null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

/** Transcripts are untrusted speech-to-text: control characters removed, length capped. */
export function sanitizeTranscript(text: string, max = 500): string {
  return text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export interface VoiceTurn {
  speaker: 'user' | 'agent';
  text: string;
  at: string;
}

/** Last N turns of the current voice conversation (a turn = one user utterance and its answer). */
export class ConversationWindow {
  private readonly turns: VoiceTurn[] = [];
  constructor(readonly maxTurns = 20) {}
  push(speaker: VoiceTurn['speaker'], text: string): void {
    const t = sanitizeTranscript(text, 2000);
    if (!t) return;
    this.turns.push({ speaker, text: t, at: new Date().toISOString() });
    const max = this.maxTurns * 2;
    if (this.turns.length > max) this.turns.splice(0, this.turns.length - max);
  }
  recent(): readonly VoiceTurn[] {
    return this.turns;
  }
  get size(): number {
    return this.turns.length;
  }
}

export interface VoiceAgentDeps {
  orchestrator: Pick<
    Orchestrator,
    'createMission' | 'start' | 'pause' | 'cancel' | 'emergencyStop' | 'isActive'
  >;
  store: Pick<HermesStore, 'getMission' | 'listMissions' | 'listTasks' | 'listApprovals'>;
  telemetry: Pick<Telemetry, 'record'>;
}

const MissionRef = z.object({ missionId: z.string().max(64).optional() });

interface VoiceToolDef {
  description: string;
  input: z.ZodType;
}

export const VOICE_TOOL_DEFS = {
  mission_create: {
    description:
      'Crée une mission HERMES à partir d’une demande complète et autonome (HERMES prépare un plan, qui n’est PAS lancé automatiquement).',
    input: z.object({ request: z.string().min(5).max(2000) }),
  },
  mission_start: {
    description:
      'Lance (ou reprend) une mission planifiée, en pause ou interrompue. confirmed=true seulement après un « oui » oral explicite de l’utilisateur.',
    input: MissionRef.extend({ confirmed: z.boolean() }),
  },
  mission_pause: { description: 'Met en pause la mission en cours.', input: MissionRef },
  mission_cancel: {
    description:
      'Annule une mission (irréversible). confirmed=true seulement après confirmation orale explicite.',
    input: MissionRef.extend({ confirmed: z.boolean() }),
  },
  mission_status: {
    description: 'État d’une mission : statut, étapes, coût. Sans identifiant : la mission courante.',
    input: MissionRef,
  },
  mission_report: {
    description: 'Résultat et vérification de la mission (la dernière par défaut).',
    input: MissionRef,
  },
  missions_recent: {
    description: 'Liste les missions récentes.',
    input: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
  },
  approvals_pending: {
    description:
      'Actions qui attendent une décision de l’utilisateur (à prendre dans l’interface, pas à la voix).',
    input: z.object({}),
  },
  emergency_stop: {
    description: "Arrêt d'urgence immédiat de toutes les actions de HERMES.",
    input: z.object({}),
  },
} satisfies Record<string, VoiceToolDef>;

export type VoiceToolName = keyof typeof VOICE_TOOL_DEFS;

/** Same conversion as HERMES tools (toChatToolSpec): zod schema → JSON Schema function declaration. */
export function voiceToolSpecs(): ChatToolSpec[] {
  return Object.entries(VOICE_TOOL_DEFS).map(([name, d]) => {
    const parameters = z.toJSONSchema(d.input, { io: 'input' }) as Record<string, unknown>;
    delete parameters.$schema;
    return { type: 'function', function: { name, description: d.description, parameters } };
  });
}

const STATUS_FR: Record<MissionStatus, string> = {
  planning: 'plan en préparation',
  planned: 'planifiée, en attente de lancement',
  running: 'en cours',
  paused: 'en pause',
  interrupted: 'interrompue',
  completed: 'terminée',
  failed: 'échouée',
  cancelled: 'annulée',
};

export type VoiceResult =
  { ok: true; [k: string]: unknown } | { ok: false; error: string; [k: string]: unknown };

export class VoiceAgent {
  readonly window: ConversationWindow;
  /** Missions created during this voice session (they are normal missions, visible in history). */
  readonly missions = new Set<string>();
  private current: string | null = null;

  constructor(
    private readonly d: VoiceAgentDeps,
    opts: { maxTurns?: number } = {},
  ) {
    this.window = new ConversationWindow(opts.maxTurns ?? 20);
  }

  get currentMissionId(): string | null {
    return this.current;
  }

  /** Mission targeted when the user does not name one: the one discussed, else the only active one. */
  private resolve(missionId?: string): Mission {
    const id = missionId ?? this.current;
    if (id) {
      const m = this.d.store.getMission(id);
      if (!m) throw new HermesError('NOT_FOUND', `Mission inconnue : ${id}`);
      this.current = m.id;
      return m;
    }
    const active = this.d.store.listMissions({
      status: ['planning', 'planned', 'running', 'paused', 'interrupted'],
      limit: 5,
    });
    if (active.length === 1) return ((this.current = active[0]!.id), active[0]!);
    if (active.length > 1)
      throw new HermesError(
        'VALIDATION',
        `${active.length} missions sont actives : précise laquelle (identifiant ou description).`,
      );
    const last = this.d.store.listMissions({ limit: 1 })[0];
    if (!last) throw new HermesError('NOT_FOUND', 'Aucune mission pour le moment.');
    this.current = last.id;
    return last;
  }

  private audit(type: string, message: string, missionId: string | null, data?: unknown) {
    this.d.telemetry.record({ missionId, agent: 'voice', category: 'voice', type, message, data });
  }

  private describe(m: Mission) {
    const tasks = this.d.store.listTasks(m.id);
    return {
      missionId: m.id,
      request: m.request.slice(0, 300),
      status: m.status,
      statut: STATUS_FR[m.status],
      plan: m.plan?.summary ?? null,
      steps: tasks.map((t) => ({ step: t.stepId, agent: t.agent, status: t.status })),
      pendingApprovals: this.d.store.listApprovals({ missionId: m.id, status: 'pending' }).length,
      costUsd: Number(m.usage.costUsd.toFixed(4)),
      costKnown: m.usage.costKnown,
    };
  }

  /** Runs one tool call from the Live model; never throws (errors are returned to the model). */
  async execute(call: ChatToolCall): Promise<VoiceResult> {
    const name = call.function.name as VoiceToolName;
    const def = VOICE_TOOL_DEFS[name] as VoiceToolDef | undefined;
    if (!def) return { ok: false, error: `Outil vocal inconnu : ${call.function.name}` };
    let args: Record<string, unknown>;
    try {
      args = def.input.parse(JSON.parse(call.function.arguments || '{}')) as Record<string, unknown>;
    } catch (err) {
      return { ok: false, error: `Arguments invalides : ${errorMessage(err).slice(0, 300)}` };
    }
    try {
      const out = await this.run(name, args);
      this.audit('voice.tool', `Outil vocal ${name} exécuté`, (out.missionId as string | undefined) ?? null, {
        tool: name,
      });
      return out;
    } catch (err) {
      this.audit('voice.tool_failed', `Outil vocal ${name} : ${errorMessage(err)}`, this.current, {
        tool: name,
      });
      return { ok: false, error: errorMessage(err) };
    }
  }

  private async run(name: VoiceToolName, a: Record<string, unknown>): Promise<VoiceResult> {
    const missionId = a.missionId as string | undefined;
    switch (name) {
      case 'mission_create': {
        const context = this.window
          .recent()
          .filter((t) => t.speaker === 'user')
          .slice(-4)
          .map((t) => `« ${t.text} »`);
        // Always marked as dictated; recent user speech is attached as clearly labelled, untrusted context.
        const request = [
          sanitizeTranscript(String(a.request), 2000),
          '',
          context.length
            ? `(Demande dictée à la voix. Derniers propos de l'utilisateur, transcription non fiable : ${context.join(' ')})`
            : '(Demande dictée à la voix.)',
        ].join('\n');
        const m = this.d.orchestrator.createMission(request);
        this.missions.add(m.id);
        this.current = m.id;
        this.audit('voice.mission_created', 'Mission créée à la voix', m.id);
        return {
          ok: true,
          missionId: m.id,
          status: m.status,
          message: 'Mission créée : le plan est en préparation.',
        };
      }
      case 'mission_start': {
        const m = this.resolve(missionId);
        if (a.confirmed !== true)
          return {
            ok: false,
            error: 'Confirmation orale requise avant le lancement.',
            needsConfirmation: true,
            ...this.describe(m),
          };
        const started = this.d.orchestrator.start(m.id);
        return { ok: true, missionId: m.id, status: started.status, message: 'Mission lancée.' };
      }
      case 'mission_pause':
        return this.pause(missionId);
      case 'mission_cancel': {
        if (a.confirmed !== true) {
          const m = this.resolve(missionId);
          return {
            ok: false,
            error: 'Confirmation orale requise avant l’annulation.',
            needsConfirmation: true,
            missionId: m.id,
          };
        }
        return this.cancel(missionId);
      }
      case 'mission_status':
        return { ok: true, ...this.describe(this.resolve(missionId)) };
      case 'mission_report':
        return this.report(missionId);
      case 'missions_recent':
        return {
          ok: true,
          missions: this.d.store
            .listMissions({ limit: a.limit as number })
            .map((m) => ({ missionId: m.id, request: m.request.slice(0, 120), statut: STATUS_FR[m.status] })),
        };
      case 'approvals_pending':
        return {
          ok: true,
          approvals: this.d.store
            .listApprovals({ status: 'pending' })
            .map((p) => ({ missionId: p.missionId, action: p.description.slice(0, 200) })),
          message: 'Les décisions se prennent dans l’interface de HERMES, pas à la voix.',
        };
      case 'emergency_stop':
        return this.emergency();
    }
  }

  private pause(missionId?: string): VoiceResult {
    const m = this.resolve(missionId);
    if (m.status === 'paused') return { ok: true, missionId: m.id, message: 'La mission est déjà en pause.' };
    if (!this.d.orchestrator.isActive(m.id))
      return { ok: false, missionId: m.id, error: `La mission n'est pas en cours (${STATUS_FR[m.status]}).` };
    this.d.orchestrator.pause(m.id, 'Demandé à la voix');
    return {
      ok: true,
      missionId: m.id,
      message: 'Pause demandée : elle prend effet après l’action en cours.',
    };
  }

  private cancel(missionId?: string): VoiceResult {
    const m = this.resolve(missionId);
    if (TERMINAL_MISSION_STATUSES.includes(m.status))
      return { ok: true, missionId: m.id, message: `La mission est déjà ${STATUS_FR[m.status]}.` };
    this.d.orchestrator.cancel(m.id, 'Annulée à la voix');
    return { ok: true, missionId: m.id, message: 'Mission annulée.' };
  }

  private async emergency(): Promise<VoiceResult> {
    const r = await this.d.orchestrator.emergencyStop("Arrêt d'urgence demandé à la voix");
    return {
      ok: true,
      missions: r.missions.length,
      uncertainActions: r.uncertainToolCalls.length,
      message: "Arrêt d'urgence effectué. Il faut réarmer HERMES dans l'interface pour reprendre.",
    };
  }

  private report(missionId?: string): VoiceResult {
    const m = this.resolve(missionId);
    return {
      ok: true,
      ...this.describe(m),
      result: m.result?.summary.slice(0, 1500) ?? null,
      verification: m.result?.verification
        ? { verdict: m.result.verification.verdict, reasons: m.result.verification.reasons.slice(0, 3) }
        : null,
      aiCalls: m.usage.aiCalls,
      toolCalls: m.usage.toolCalls,
    };
  }

  /** Deterministic special command, executed without waiting for the model's interpretation. */
  async runCommand(cmd: VoiceCommand): Promise<VoiceResult> {
    let out: VoiceResult;
    try {
      switch (cmd) {
        case 'pause':
          out = this.pause();
          break;
        case 'cancel':
          // Saying "annule" is itself the explicit confirmation.
          out = this.cancel();
          break;
        case 'resume': {
          const m = this.resolve();
          if (!['paused', 'interrupted'].includes(m.status)) {
            out = {
              ok: false,
              missionId: m.id,
              error: `Rien à reprendre : la mission est ${STATUS_FR[m.status]}.`,
            };
            break;
          }
          this.d.orchestrator.start(m.id);
          out = { ok: true, missionId: m.id, message: 'Mission reprise.' };
          break;
        }
        case 'emergency_stop':
          out = await this.emergency();
          break;
        case 'report':
          out = this.report();
          break;
      }
    } catch (err) {
      out = { ok: false, error: errorMessage(err) };
    }
    this.audit(
      'voice.command',
      `Commande vocale « ${cmd} » : ${out.ok ? 'exécutée' : out.error}`,
      (out.missionId as string) ?? null,
      {
        command: cmd,
        ok: out.ok,
      },
    );
    return out;
  }
}

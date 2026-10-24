import { z } from 'zod';
import { EXECUTOR_AGENTS, MemoryKind } from '../shared/contracts';
import { alwaysAvailable, defineTool } from './types';

const ALL = EXECUTOR_AGENTS;

export const missionPause = defineTool({
  id: 'mission.pause',
  description:
    "Met la mission en pause (par ex. quand une information de l'utilisateur est nécessaire). La reprise est manuelle.",
  input: z.object({ reason: z.string().min(3).max(500) }),
  output: z.object({ paused: z.boolean() }),
  allowedAgents: ALL,
  permissions: ['mission.control'],
  risk: 'low',
  timeoutMs: 5_000,
  reversible: true,
  idempotent: true,
  verification: 'Le changement d’état de la mission est persisté.',
  confirmation: 'Aucune.',
  availability: alwaysAvailable,
  resources: () => ({}),
  async run(i, ctx) {
    ctx.services.missionControl.pause(ctx.missionId, i.reason);
    return { paused: true };
  },
});

export const missionCancel = defineTool({
  id: 'mission.cancel',
  description: 'Annule la mission (quand elle est impossible ou dangereuse à poursuivre).',
  input: z.object({ reason: z.string().min(3).max(500) }),
  output: z.object({ cancelled: z.boolean() }),
  allowedAgents: ALL,
  permissions: ['mission.control'],
  risk: 'low',
  timeoutMs: 5_000,
  reversible: false,
  idempotent: true,
  verification: 'Le changement d’état de la mission est persisté.',
  confirmation: 'Aucune.',
  availability: alwaysAvailable,
  resources: () => ({}),
  async run(i, ctx) {
    ctx.services.missionControl.cancel(ctx.missionId, i.reason);
    return { cancelled: true };
  },
});

export const missionVerify = defineTool({
  id: 'mission.verify',
  description:
    "Demande au vérificateur indépendant d'examiner les preuves déjà produites par la tâche courante.",
  input: z.object({}),
  output: z.object({ verdict: z.unknown() }),
  allowedAgents: ALL,
  permissions: ['mission.control'],
  risk: 'low',
  timeoutMs: 120_000,
  reversible: true,
  idempotent: true,
  verification: 'Verdict produit par l’agent vérificateur à partir des appels d’outils enregistrés.',
  confirmation: 'Aucune.',
  availability: alwaysAvailable,
  resources: () => ({}),
  async run(_i, ctx) {
    if (!ctx.taskId) throw new Error('Aucune tâche courante à vérifier');
    return { verdict: await ctx.services.missionControl.verifyTask(ctx.taskId, ctx.signal) };
  },
});

export const memorySearch = defineTool({
  id: 'memory.search',
  description:
    'Cherche dans la mémoire persistante (résumés de missions, préférences, procédures) : mots-clés (BM25) et, si disponible, similarité sémantique. Les résultats peuvent être obsolètes.',
  input: z.object({
    query: z.string().min(2).max(300),
    kind: MemoryKind.optional(),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  output: z.object({
    entries: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        content: z.string(),
        confidence: z.number().nullable(),
        updatedAt: z.string(),
        score: z.number(),
        matchedBy: z.array(z.enum(['keyword', 'semantic'])),
        similarity: z.number().nullable(),
      }),
    ),
    mode: z.enum(['hybrid', 'keyword']),
  }),
  allowedAgents: ALL,
  permissions: ['memory.read'],
  risk: 'low',
  timeoutMs: 5_000,
  reversible: true,
  idempotent: true,
  verification: 'Lecture directe de la base locale.',
  confirmation: 'Aucune.',
  availability: alwaysAvailable,
  resources: () => ({}),
  async run(i, ctx) {
    const index = ctx.services.memoryIndex;
    const entries = await index.search({ text: i.query, kind: i.kind, limit: i.limit });
    return {
      entries: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        content: e.content,
        confidence: e.confidence,
        updatedAt: e.updatedAt,
        score: Number(e.score.toFixed(5)),
        matchedBy: e.matchedBy,
        similarity: e.similarity === null ? null : Number(e.similarity.toFixed(3)),
      })),
      mode: index.status().mode,
    };
  },
});

export const memorySave = defineTool({
  id: 'memory.save',
  description:
    "Enregistre une connaissance ou une procédure candidate. Elle est marquée non validée (confiance faible) jusqu'à validation par l'utilisateur. Ne jamais y mettre de secret.",
  input: z.object({
    kind: z.enum(['knowledge', 'procedure']),
    content: z.string().min(5).max(4000),
    tags: z.array(z.string().max(40)).max(10).default([]),
  }),
  output: z.object({ id: z.string() }),
  allowedAgents: ['memory'],
  permissions: ['memory.write'],
  risk: 'low',
  timeoutMs: 5_000,
  reversible: true,
  idempotent: false,
  verification: 'Entrée relue depuis la base après écriture.',
  confirmation: 'Aucune ; l’utilisateur peut modifier ou supprimer l’entrée.',
  availability: alwaysAvailable,
  resources: () => ({}),
  async run(i, ctx) {
    const e = ctx.services.store.addMemory({
      kind: i.kind,
      content: i.content,
      origin: `agent:${ctx.agent}`,
      missionId: ctx.missionId,
      confidence: 0.3,
      tags: [...i.tags, 'non-validé'],
    });
    ctx.services.memoryIndex.schedule();
    return { id: e.id };
  },
  async verify(_i, o, ctx) {
    return { verified: ctx.services.store.getMemory(o.id) !== null, detail: 'Entrée présente en base' };
  },
});

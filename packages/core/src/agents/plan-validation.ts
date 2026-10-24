import { z } from 'zod';
import { Plan } from '../shared/contracts';
import type { AnyTool } from '../tools/types';

/** Tools every executing agent may use regardless of the plan. */
export const IMPLICIT_TOOLS = ['mission.pause', 'mission.cancel', 'mission.verify'] as const;

/** Extracts a JSON object from a model answer (tolerates ```json fences and prose around it). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Aucun objet JSON trouvé dans la réponse');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Schema + semantic validation of a plan produced by a model. Returns the parsed plan or the
 * list of problems (used for one repair round-trip with the planner).
 */
export function validatePlan(
  raw: unknown,
  tools: ReadonlyMap<string, AnyTool>,
  unavailable: ReadonlyMap<string, string>,
): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: [z.prettifyError(parsed.error)] };
  const plan = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const s of plan.steps) {
    if (ids.has(s.id)) errors.push(`Identifiant d'étape dupliqué : ${s.id}`);
    ids.add(s.id);
  }
  for (const s of plan.steps) {
    for (const d of s.dependsOn) {
      if (d === s.id) errors.push(`L'étape ${s.id} dépend d'elle-même`);
      else if (!ids.has(d)) errors.push(`L'étape ${s.id} dépend d'une étape inconnue : ${d}`);
    }
    for (const t of s.tools) {
      const tool = tools.get(t);
      if (!tool) errors.push(`Étape ${s.id} : outil inconnu ${t}`);
      else if (!tool.allowedAgents.includes(s.agent))
        errors.push(`Étape ${s.id} : l'agent ${s.agent} n'a pas accès à ${t}`);
      else if (unavailable.has(t))
        errors.push(`Étape ${s.id} : outil ${t} indisponible (${unavailable.get(t)})`);
    }
  }
  const cycle = findCycle(plan);
  if (cycle) errors.push(`Dépendances circulaires : ${cycle.join(' -> ')}`);
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

function findCycle(plan: Plan): string[] | null {
  const deps = new Map(plan.steps.map((s) => [s.id, s.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = deps.has(d) ? visit(d) : null;
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const s of plan.steps) {
    const c = visit(s.id);
    if (c) return c;
  }
  return null;
}

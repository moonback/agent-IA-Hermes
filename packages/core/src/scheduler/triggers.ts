import { z } from 'zod';
import { HermesError } from '../shared/errors';
import { nextCronRun, parseCron } from './cron';

/**
 * Proactive missions: a trigger turns a time, a file event or a failed mission into a new mission
 * built from a template. The mission then goes through the usual planner, policy and approvals.
 */

export const TRIGGER_KINDS = ['cron', 'interval', 'event', 'condition'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const TriggerSpec = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    expression: z
      .string()
      .min(1)
      .max(100)
      .superRefine((e, ctx) => {
        try {
          parseCron(e);
        } catch (err) {
          ctx.addIssue({ code: 'custom', message: (err as Error).message });
        }
      }),
  }),
  z.object({
    kind: z.literal('interval'),
    minutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60),
  }),
  z.object({
    kind: z.literal('event'),
    /** created: new file; changed: existing file modified; any: both (deletions are ignored). */
    event: z.enum(['created', 'changed', 'any']).default('any'),
    path: z.string().min(1).max(1024),
    /** Name filter on the file name: * and ? wildcards, case-insensitive. */
    pattern: z.string().min(1).max(100).default('*'),
    recursive: z.boolean().default(false),
    /** Events arriving sooner are grouped into the next mission. */
    cooldownSec: z.number().int().min(10).max(86_400).default(60),
  }),
  z.object({
    kind: z.literal('condition'),
    condition: z.literal('mission_failed').default('mission_failed'),
    /** Only missions started by this trigger; null = any failed mission. */
    sourceTriggerId: z.string().max(40).nullable().default(null),
    /** Retries of one original mission, counting retries of retries. */
    maxRetries: z.number().int().min(1).max(3).default(1),
    delayMinutes: z.number().int().min(0).max(1440).default(0),
  }),
]);
export type TriggerSpec = z.infer<typeof TriggerSpec>;

/** Budget of a proactive mission; capped at fire time by the proactive policy. */
export const TriggerBudget = z
  .object({
    maxCostUsd: z.number().min(0).max(100),
    maxAiCalls: z.number().int().min(1).max(500),
    maxToolCalls: z.number().int().min(1).max(1000),
    maxDurationSec: z.number().int().min(10).max(86_400),
  })
  .partial();
export type TriggerBudget = z.infer<typeof TriggerBudget>;

export const TriggerInput = z.object({
  name: z.string().trim().min(1).max(120),
  spec: TriggerSpec,
  missionTemplate: z.string().trim().min(2).max(4000),
  budget: TriggerBudget.default({}),
  enabled: z.boolean().default(true),
  /** false: the mission is planned, then waits for the user to start it. */
  autoStart: z.boolean().default(true),
});
export type TriggerInput = z.infer<typeof TriggerInput>;

export const TriggerPatch = TriggerInput.partial();

export interface ScheduledTrigger {
  id: string;
  name: string;
  kind: TriggerKind;
  spec: TriggerSpec;
  missionTemplate: string;
  budget: TriggerBudget;
  enabled: boolean;
  autoStart: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastMissionId: string | null;
  lastError: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export const TRIGGER_RUN_STATUSES = [
  'scheduled', // condition retry waiting for its delay
  'planning',
  'awaiting_start', // planned, auto-start off
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'error', // the mission could not be created
] as const;
export type TriggerRunStatus = (typeof TRIGGER_RUN_STATUSES)[number];
export const OPEN_RUN_STATUSES: TriggerRunStatus[] = ['scheduled', 'planning', 'awaiting_start', 'running'];

export interface TriggerRun {
  id: string;
  triggerId: string;
  missionId: string | null;
  firedAt: string;
  reason: string;
  status: TriggerRunStatus;
  error: string | null;
  sourceMissionId: string | null;
  attempt: number;
  /** Mission request rendered from the template. */
  request: string | null;
}

export const ProactiveSettings = z.object({
  enabled: z.boolean().default(true),
  /** Hard cap on the cost of each proactive mission (USD). */
  maxCostUsd: z.number().min(0.01).max(5).default(0.2),
  /** Missions started by triggers in a rolling 24 h window, all triggers together. */
  maxRunsPerDay: z.number().int().min(1).max(200).default(24),
  /** Windows toast notifications when a proactive mission starts or ends (in-app notices always). */
  desktopNotifications: z.boolean().default(true),
});
export type ProactiveSettings = z.infer<typeof ProactiveSettings>;

/** Next time a time-based trigger fires, strictly after `after`; null for event and condition triggers. */
export function nextRunFor(spec: TriggerSpec, after: Date): Date | null {
  if (spec.kind === 'cron') return nextCronRun(parseCron(spec.expression), after);
  if (spec.kind === 'interval') return new Date(after.getTime() + spec.minutes * 60_000);
  return null;
}

export interface TemplateContext {
  now: Date;
  file?: string;
  files?: string[];
  mission?: { request: string; error: string | null };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Values from files and other missions are data: quoted, bounded, without template syntax. */
const quoteValue = (v: string, max: number) =>
  `« ${v
    .replace(/\{\{|\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)} »`;

export const TEMPLATE_VARIABLES = [
  '{{date}}',
  '{{time}}',
  '{{file}}',
  '{{files}}',
  '{{mission.request}}',
  '{{mission.error}}',
] as const;

export function renderTemplate(template: string, ctx: TemplateContext): string {
  const d = ctx.now;
  const values: Record<string, string> = {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    file: ctx.file ? quoteValue(ctx.file, 1024) : '(aucun fichier)',
    files: ctx.files?.length
      ? ctx.files
          .slice(0, 20)
          .map((f) => quoteValue(f, 1024))
          .join(', ') + (ctx.files.length > 20 ? ` et ${ctx.files.length - 20} autre(s)` : '')
      : '(aucun fichier)',
    'mission.request': ctx.mission ? quoteValue(ctx.mission.request, 3000) : '(aucune mission)',
    'mission.error': ctx.mission?.error ? quoteValue(ctx.mission.error, 1000) : '(erreur inconnue)',
  };
  const out = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, k: string) => values[k] ?? all).trim();
  if (out.length < 2) throw new HermesError('VALIDATION', 'Modèle de mission vide après substitution');
  return out.slice(0, 8000);
}

/** File-name filter with * and ? wildcards (no path separators), case-insensitive. */
export function matchesPattern(name: string, pattern: string): boolean {
  const re = pattern
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`, 'i').test(name);
}

export function describeSpec(spec: TriggerSpec): string {
  switch (spec.kind) {
    case 'cron':
      return `cron « ${spec.expression} »`;
    case 'interval':
      return spec.minutes % 60 === 0 ? `toutes les ${spec.minutes / 60} h` : `toutes les ${spec.minutes} min`;
    case 'event':
      return `fichier ${spec.event === 'created' ? 'créé' : spec.event === 'changed' ? 'modifié' : 'créé ou modifié'} dans ${spec.path} (${spec.pattern})`;
    case 'condition':
      return `après l’échec d’une mission${spec.sourceTriggerId ? ' de ce déclencheur source' : ''} (${spec.maxRetries} nouvelle(s) tentative(s) max.)`;
  }
}

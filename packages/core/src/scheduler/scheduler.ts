import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { Mission, MissionBudget, MissionEvent } from '../shared/contracts';
import { HermesError, errorMessage } from '../shared/errors';
import type { HermesStore } from '../persistence/store';
import type { Logger, Telemetry } from '../observability/telemetry';
import type { Notifier } from '../notifications/notifier';
import { assertInsideRoots } from '../policy-engine/paths';
import {
  OPEN_RUN_STATUSES,
  TriggerInput,
  TriggerPatch,
  describeSpec,
  matchesPattern,
  nextRunFor,
  renderTemplate,
  type ProactiveSettings,
  type ScheduledTrigger,
  type TemplateContext,
  type TriggerRun,
  type TriggerRunStatus,
  type TriggerSpec,
} from './triggers';

export interface SchedulerMissions {
  createMission(request: string, budget: Partial<MissionBudget>): Mission;
  start(id: string): Mission;
  isActive(id: string): boolean;
  idle(id: string): Promise<void>;
  isHalted(): boolean;
}

export interface SchedulerDeps {
  store: HermesStore;
  telemetry: Telemetry;
  logger: Logger;
  missions: SchedulerMissions;
  notifier: Notifier;
  defaultBudget: () => MissionBudget;
  proactive: () => ProactiveSettings;
  allowedRoots: () => string[];
  now?: () => Date;
  tickMs?: number;
  /** Quiet time before grouped file events fire (tests shorten it). */
  debounceMs?: number;
}

/** A time trigger more than this late at startup counts as missed (not caught up). */
const MISSED_GRACE_MS = 2 * 60_000;
const CURSOR_KEY = 'scheduler_cursor';

interface Watch {
  spec: Extract<TriggerSpec, { kind: 'event' }>;
  dir: string;
  watcher: FSWatcher;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  lastFire: number;
}

/**
 * Fires proactive missions. Time triggers are checked on a tick; file triggers use fs.watch on a
 * folder inside the allowed roots; condition triggers scan newly failed missions. Each mission is
 * created through the orchestrator (planner, policy and approvals unchanged) with a budget capped by
 * the proactive policy, and at most one mission per trigger is open at a time.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly watches = new Map<string, Watch>();
  private readonly starting = new Set<string>();
  private ticking = false;
  private readonly onEvent = (ev: MissionEvent) => {
    if (!ev.missionId || !(ev.type.startsWith('plan.') || ev.type.startsWith('mission.'))) return;
    const run = this.d.store.triggerRunForMission(ev.missionId);
    if (!run || !OPEN_RUN_STATUSES.includes(run.status)) return;
    // The planning loop is still settling when plan.created is recorded: start once it has.
    void this.d.missions.idle(ev.missionId).then(() => this.syncRun(run.id));
  };

  constructor(private readonly d: SchedulerDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private record(
    t: ScheduledTrigger | null,
    type: string,
    message: string,
    extra: { level?: 'info' | 'warn' | 'error'; missionId?: string | null; data?: unknown } = {},
  ) {
    this.d.telemetry.record({
      category: 'scheduler',
      agent: 'scheduler',
      type,
      message: t ? `${t.name} : ${message}` : message,
      missionId: extra.missionId ?? null,
      level: extra.level,
      data: { triggerId: t?.id, ...(extra.data as object) },
    });
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.timer) return;
    const now = this.now();
    for (const t of this.d.store.listTriggers()) {
      if (!t.enabled || !t.nextRunAt) continue;
      const due = Date.parse(t.nextRunAt);
      if (due < now.getTime() - MISSED_GRACE_MS) {
        // Missed while HERMES was closed: recorded, not replayed (a backlog of runs helps nobody).
        this.d.store.addTriggerRun({
          triggerId: t.id,
          reason: `Exécution manquée (application fermée) prévue le ${new Date(due).toLocaleString('fr-FR')}`,
          status: 'skipped',
          firedAt: t.nextRunAt,
        });
        this.d.store.updateTrigger(t.id, { nextRunAt: this.nextIso(t.spec, now) });
      }
    }
    if (!this.cursor()) this.setCursor(now.toISOString());
    this.d.telemetry.on('event', this.onEvent);
    this.refreshWatches();
    this.timer = setInterval(() => void this.tick(), this.d.tickMs ?? 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.d.telemetry.off('event', this.onEvent);
    for (const id of [...this.watches.keys()]) this.unwatch(id);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  private cursor(): string | null {
    return (
      this.d.store.getSetting<{ failuresSince?: string }>('app_settings', CURSOR_KEY, {}).failuresSince ??
      null
    );
  }

  private setCursor(iso: string) {
    this.d.store.setSetting('app_settings', CURSOR_KEY, { failuresSince: iso });
  }

  private nextIso(spec: TriggerSpec, after: Date): string | null {
    return nextRunFor(spec, after)?.toISOString() ?? null;
  }

  // ---------------------------------------------------------------- CRUD

  private validate(input: TriggerInput, selfId?: string): void {
    if (input.spec.kind === 'event') {
      const dir = assertInsideRoots(input.spec.path, this.d.allowedRoots());
      if (!existsSync(dir) || !statSync(dir).isDirectory())
        throw new HermesError('VALIDATION', `Dossier à surveiller introuvable : ${dir}`);
    }
    if (input.spec.kind === 'condition' && input.spec.sourceTriggerId) {
      if (input.spec.sourceTriggerId === selfId)
        throw new HermesError('VALIDATION', 'Un déclencheur conditionnel ne peut pas se surveiller lui-même');
      const src = this.d.store.requireTrigger(input.spec.sourceTriggerId);
      if (src.kind === 'condition')
        throw new HermesError('VALIDATION', 'La source doit être un déclencheur planifié ou sur fichier');
    }
  }

  create(raw: unknown): ScheduledTrigger {
    const input = TriggerInput.parse(raw);
    this.validate(input);
    const t = this.d.store.createTrigger({ ...input, nextRunAt: this.nextIso(input.spec, this.now()) });
    this.record(t, 'trigger.created', `déclencheur créé (${describeSpec(t.spec)})`);
    this.refreshWatches();
    return t;
  }

  update(id: string, raw: unknown): ScheduledTrigger {
    const cur = this.d.store.requireTrigger(id);
    const patch = TriggerPatch.parse(raw);
    const merged = TriggerInput.parse({ ...cur, ...patch });
    this.validate(merged, id);
    const specChanged = JSON.stringify(merged.spec) !== JSON.stringify(cur.spec);
    const t = this.d.store.updateTrigger(id, {
      ...patch,
      ...(specChanged || (patch.enabled && !cur.enabled)
        ? { nextRunAt: this.nextIso(merged.spec, this.now()), lastError: null }
        : {}),
    });
    this.record(t, 'trigger.updated', t.enabled ? 'déclencheur modifié' : 'déclencheur désactivé');
    this.refreshWatches();
    return t;
  }

  remove(id: string): boolean {
    const t = this.d.store.getTrigger(id);
    if (!t) return false;
    this.unwatch(id);
    this.d.store.deleteTrigger(id);
    this.record(t, 'trigger.deleted', 'déclencheur supprimé');
    return true;
  }

  /** Fires a trigger now, as a test of its template and budget (same rules as an automatic run). */
  runNow(id: string): TriggerRun {
    const t = this.d.store.requireTrigger(id);
    return this.fire(t, 'Exécution manuelle depuis Planification', { now: this.now() });
  }

  // ---------------------------------------------------------------- firing

  private budgetFor(t: ScheduledTrigger): Partial<MissionBudget> {
    const cap = this.d.proactive().maxCostUsd;
    const base = this.d.defaultBudget();
    return {
      ...t.budget,
      maxCostUsd: Math.min(t.budget.maxCostUsd ?? cap, cap),
      // A proactive mission runs unattended: never longer than the user's own default.
      maxDurationSec: Math.min(t.budget.maxDurationSec ?? base.maxDurationSec, base.maxDurationSec),
    };
  }

  private openRun(triggerId: string): TriggerRun | null {
    return (
      this.d.store
        .listTriggerRuns({ triggerId, status: ['planning', 'awaiting_start', 'running'], limit: 1 })
        .at(0) ?? null
    );
  }

  private skip(
    t: ScheduledTrigger,
    reason: string,
    why: string,
    extra: Partial<TriggerRun> = {},
  ): TriggerRun {
    const run = this.d.store.addTriggerRun({
      triggerId: t.id,
      reason,
      status: 'skipped',
      error: why,
      sourceMissionId: extra.sourceMissionId,
      attempt: extra.attempt,
    });
    this.record(t, 'trigger.skipped', `exécution ignorée — ${why}`, { level: 'warn' });
    return run;
  }

  private fire(
    t: ScheduledTrigger,
    reason: string,
    ctx: TemplateContext,
    chain: { sourceMissionId?: string | null; attempt?: number; runId?: string } = {},
  ): TriggerRun {
    const skipWith = (why: string) => {
      if (chain.runId) {
        this.d.store.updateTriggerRun(chain.runId, { status: 'skipped', error: why });
        this.record(t, 'trigger.skipped', `exécution ignorée — ${why}`, { level: 'warn' });
        return this.d.store.getTriggerRun(chain.runId)!;
      }
      return this.skip(t, reason, why, chain);
    };
    const policy = this.d.proactive();
    if (!policy.enabled) return skipWith('missions proactives désactivées dans les paramètres');
    if (this.d.missions.isHalted()) return skipWith('arrêt d’urgence actif');
    const open = this.openRun(t.id);
    if (open) return skipWith(`la mission précédente (${open.missionId}) n’est pas terminée`);
    const since = new Date(this.now().getTime() - 86_400_000).toISOString();
    if (this.d.store.countLaunchedRunsSince(since) >= policy.maxRunsPerDay)
      return skipWith(`plafond de ${policy.maxRunsPerDay} missions proactives par 24 h atteint`);

    let request = '';
    try {
      request = renderTemplate(t.missionTemplate, ctx);
      const mission = this.d.missions.createMission(
        `[Mission proactive « ${t.name} »] ${request}`,
        this.budgetFor(t),
      );
      const fields = { status: 'planning' as const, missionId: mission.id, request };
      const run = chain.runId
        ? (this.d.store.updateTriggerRun(chain.runId, { ...fields, firedAt: this.now().toISOString() }),
          this.d.store.getTriggerRun(chain.runId)!)
        : this.d.store.addTriggerRun({
            triggerId: t.id,
            reason,
            ...fields,
            sourceMissionId: chain.sourceMissionId,
            attempt: chain.attempt,
          });
      this.d.store.updateTrigger(t.id, {
        lastRunAt: this.now().toISOString(),
        lastMissionId: mission.id,
        lastError: null,
        incrementRuns: true,
      });
      this.record(t, 'trigger.fired', `mission proactive créée (${reason})`, {
        missionId: mission.id,
        data: { budget: mission.budget },
      });
      this.d.notifier.notify({
        title: `Mission proactive : ${t.name}`,
        body: `Démarrée (${reason}). Budget max. ${mission.budget.maxCostUsd.toFixed(2)} $.`,
        missionId: mission.id,
      });
      return run;
    } catch (err) {
      const msg = errorMessage(err);
      this.d.store.updateTrigger(t.id, { lastRunAt: this.now().toISOString(), lastError: msg });
      this.record(t, 'trigger.failed', `mission non créée : ${msg}`, { level: 'error' });
      this.d.notifier.notify({ title: `Déclencheur « ${t.name} » en échec`, body: msg, level: 'error' });
      if (chain.runId) {
        this.d.store.updateTriggerRun(chain.runId, { status: 'error', error: msg });
        return this.d.store.getTriggerRun(chain.runId)!;
      }
      return this.d.store.addTriggerRun({
        triggerId: t.id,
        reason,
        status: 'error',
        error: msg,
        request: request || null,
        sourceMissionId: chain.sourceMissionId,
        attempt: chain.attempt,
      });
    }
  }

  // ---------------------------------------------------------------- tick

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const t of this.d.store.listTriggers()) {
        if (!t.enabled || !t.nextRunAt || Date.parse(t.nextRunAt) > now.getTime()) continue;
        // Next occurrence first: a failing fire must not retrigger on every tick.
        this.d.store.updateTrigger(t.id, { nextRunAt: this.nextIso(t.spec, now) });
        this.fire(t, t.kind === 'cron' ? `planification ${describeSpec(t.spec)}` : describeSpec(t.spec), {
          now,
        });
      }
      for (const run of this.d.store.listTriggerRuns({ status: ['scheduled'], limit: 50 })) {
        if (Date.parse(run.firedAt) > now.getTime()) continue;
        const t = this.d.store.getTrigger(run.triggerId);
        if (!t?.enabled) {
          this.d.store.updateTriggerRun(run.id, { status: 'skipped', error: 'déclencheur désactivé' });
          continue;
        }
        const src = run.sourceMissionId ? this.d.store.getMission(run.sourceMissionId) : null;
        this.fire(
          t,
          run.reason,
          {
            now,
            mission: src ? { request: originalRequest(src.request), error: run.error } : undefined,
          },
          { runId: run.id },
        );
      }
      // Settle finished runs first: a failed retry must not count as still open.
      for (const run of this.d.store.listTriggerRuns({
        status: ['planning', 'awaiting_start', 'running'],
        limit: 200,
      }))
        this.syncRun(run.id);
      this.scanFailures();
    } catch (err) {
      this.d.logger.log({
        level: 'error',
        category: 'scheduler',
        message: `Planificateur : ${errorMessage(err)}`,
      });
    } finally {
      this.ticking = false;
    }
  }

  /** Condition triggers: one retry chain per failed mission, bounded by maxRetries. */
  private scanFailures(): void {
    const conditions = this.d.store
      .listTriggers()
      .filter(
        (t): t is ScheduledTrigger & { spec: Extract<TriggerSpec, { kind: 'condition' }> } =>
          t.enabled && t.spec.kind === 'condition',
      );
    const since = this.cursor() ?? this.now().toISOString();
    const failed = this.d.store.missionsEndedSince(since, 'failed');
    for (const m of failed) {
      const run = this.d.store.triggerRunForMission(m.id);
      for (const t of conditions) {
        const isRetry = run?.triggerId === t.id;
        if (!isRetry) {
          const owner = run ? this.d.store.getTrigger(run.triggerId) : null;
          // Retries of another condition trigger belong to that trigger's chain.
          if (owner?.kind === 'condition') continue;
          if (t.spec.sourceTriggerId && run?.triggerId !== t.spec.sourceTriggerId) continue;
        }
        const attempt = isRetry ? run.attempt + 1 : 1;
        const sourceId = isRetry ? (run.sourceMissionId ?? m.id) : m.id;
        const reason = `échec de la mission ${m.id} (tentative ${attempt}/${t.spec.maxRetries})`;
        if (attempt > t.spec.maxRetries) {
          this.skip(t, reason, `nombre maximal de nouvelles tentatives atteint (${t.spec.maxRetries})`, {
            sourceMissionId: sourceId,
            attempt,
          });
          this.d.notifier.notify({
            title: `Mission en échec : ${t.name}`,
            body: `Plus de nouvelle tentative (${t.spec.maxRetries} max.) : ${m.error ?? 'erreur inconnue'}`,
            level: 'error',
            missionId: m.id,
          });
          continue;
        }
        const source = this.d.store.getMission(sourceId) ?? m;
        if (t.spec.delayMinutes > 0) {
          this.d.store.addTriggerRun({
            triggerId: t.id,
            reason,
            status: 'scheduled',
            firedAt: new Date(this.now().getTime() + t.spec.delayMinutes * 60_000).toISOString(),
            sourceMissionId: sourceId,
            attempt,
            // Kept on the run: the error shown to the retry is the latest one, not the first.
            error: m.error,
          });
          this.record(t, 'trigger.retry_scheduled', `nouvelle tentative dans ${t.spec.delayMinutes} min`, {
            missionId: m.id,
          });
        } else {
          this.fire(
            t,
            reason,
            { now: this.now(), mission: { request: originalRequest(source.request), error: m.error } },
            { sourceMissionId: sourceId, attempt },
          );
        }
      }
      if (m.endedAt) this.setCursor(m.endedAt);
    }
  }

  /** Follows the mission of a run: auto-start after planning, final status and notifications. */
  private syncRun(runId: string): void {
    const run = this.d.store.getTriggerRun(runId);
    if (!run?.missionId || !OPEN_RUN_STATUSES.includes(run.status)) return;
    const m = this.d.store.getMission(run.missionId);
    const t = this.d.store.getTrigger(run.triggerId);
    if (!m || !t) {
      this.d.store.updateTriggerRun(run.id, {
        status: 'cancelled',
        error: 'mission ou déclencheur supprimé',
      });
      return;
    }
    const set = (status: TriggerRunStatus, error?: string | null) => {
      if (status !== run.status) this.d.store.updateTriggerRun(run.id, { status, error });
    };
    switch (m.status) {
      case 'planning':
        return;
      case 'planned': {
        if (this.d.missions.isActive(m.id) || this.starting.has(m.id)) return;
        if (!t.autoStart) {
          if (run.status !== 'awaiting_start') {
            set('awaiting_start');
            this.d.notifier.notify({
              title: `Plan prêt : ${t.name}`,
              body: 'La mission proactive attend votre validation dans Missions.',
              missionId: m.id,
            });
          }
          return;
        }
        if (this.d.missions.isHalted()) return set('awaiting_start', 'arrêt d’urgence actif');
        this.starting.add(m.id);
        try {
          this.d.missions.start(m.id);
          set('running');
        } catch (err) {
          set('awaiting_start', errorMessage(err));
        } finally {
          this.starting.delete(m.id);
        }
        return;
      }
      case 'running':
      case 'paused':
        return set('running');
      case 'interrupted':
        return this.finish(run, t, m, 'cancelled', 'mission interrompue (reprise possible depuis Missions)');
      case 'completed':
      case 'failed':
      case 'cancelled':
        return this.finish(run, t, m, m.status, m.error);
    }
  }

  private finish(
    run: TriggerRun,
    t: ScheduledTrigger,
    m: Mission,
    status: TriggerRunStatus,
    error: string | null,
  ) {
    this.d.store.updateTriggerRun(run.id, { status, error });
    if (status === 'failed') this.d.store.updateTrigger(t.id, { lastError: error ?? 'mission en échec' });
    const cost = m.usage.costKnown ? `${m.usage.costUsd.toFixed(3)} $` : `≥ ${m.usage.costUsd.toFixed(3)} $`;
    this.record(t, `trigger.mission_${status}`, `mission ${labels[status] ?? status} (${cost})`, {
      missionId: m.id,
      level: status === 'completed' ? 'info' : 'warn',
    });
    this.d.notifier.notify({
      title: `Mission proactive ${labels[status] ?? status} : ${t.name}`,
      body:
        status === 'completed'
          ? `Terminée et vérifiée — coût ${cost}.`
          : (error ?? 'Voir le détail dans Missions.'),
      level: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warn',
      missionId: m.id,
    });
  }

  // ---------------------------------------------------------------- file watchers

  /** Opens watchers for enabled event triggers, closes the others. Paths are re-checked against the policy. */
  refreshWatches(): void {
    const wanted = new Map(
      this.d.store
        .listTriggers()
        .filter((t) => t.enabled && t.spec.kind === 'event')
        .map((t) => [t.id, t] as const),
    );
    for (const [id, w] of this.watches) {
      const t = wanted.get(id);
      if (!t || JSON.stringify(t.spec) !== JSON.stringify(w.spec)) this.unwatch(id);
    }
    for (const [id, t] of wanted) {
      if (this.watches.has(id) || t.spec.kind !== 'event') continue;
      const spec = t.spec;
      try {
        const dir = assertInsideRoots(spec.path, this.d.allowedRoots());
        const watcher = watch(dir, { recursive: spec.recursive, persistent: false }, (type, name) => {
          if (name) this.onFile(id, type, String(name));
        });
        watcher.on('error', (err) => {
          this.unwatch(id);
          this.d.store.updateTrigger(id, { lastError: `surveillance arrêtée : ${errorMessage(err)}` });
        });
        this.watches.set(id, { spec, dir, watcher, pending: new Set(), timer: null, lastFire: 0 });
        if (t.lastError?.startsWith('surveillance')) this.d.store.updateTrigger(id, { lastError: null });
      } catch (err) {
        this.d.store.updateTrigger(id, { lastError: `surveillance impossible : ${errorMessage(err)}` });
      }
    }
  }

  get watching(): number {
    return this.watches.size;
  }

  private unwatch(id: string) {
    const w = this.watches.get(id);
    if (!w) return;
    w.watcher.close();
    if (w.timer) clearTimeout(w.timer);
    this.watches.delete(id);
  }

  private onFile(id: string, type: string, name: string) {
    const w = this.watches.get(id);
    if (!w || !matchesPattern(basename(name), w.spec.pattern)) return;
    // Files written while this trigger's own mission runs would loop back into a new mission.
    if (this.openRun(id)) return;
    const full = join(w.dir, name);
    let isFile: boolean;
    try {
      isFile = statSync(full).isFile();
    } catch {
      return; // deleted: not an event of interest
    }
    if (!isFile) return;
    // 'rename' = a name appeared in the folder (new file, move, atomic save); 'change' = content.
    const kind = type === 'rename' ? 'created' : 'changed';
    if (w.spec.event !== 'any' && w.spec.event !== kind) return;
    w.pending.add(full);
    this.arm(id, this.d.debounceMs ?? 2_000);
  }

  private arm(id: string, ms: number) {
    const w = this.watches.get(id);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => this.flush(id), ms);
    w.timer.unref();
  }

  private flush(id: string) {
    const w = this.watches.get(id);
    if (!w) return;
    w.timer = null;
    const wait = w.lastFire + w.spec.cooldownSec * 1000 - Date.now();
    if (wait > 0) return this.arm(id, wait);
    const t = this.d.store.getTrigger(id);
    if (!t?.enabled) return;
    const files: string[] = [];
    for (const f of w.pending) {
      try {
        files.push(assertInsideRoots(f, this.d.allowedRoots())); // a link cannot lead outside the roots
      } catch {
        /* dropped */
      }
    }
    w.pending.clear();
    if (!files.length) return;
    w.lastFire = Date.now();
    this.fire(t, `${files.length} fichier(s) ${describeSpec(t.spec).replace(/^fichier /, '')}`, {
      now: this.now(),
      file: files[0],
      files,
    });
  }

  // ---------------------------------------------------------------- views

  status() {
    const p = this.d.proactive();
    return {
      running: this.running,
      watching: this.watching,
      settings: p,
      launchedLast24h: this.d.store.countLaunchedRunsSince(
        new Date(this.now().getTime() - 86_400_000).toISOString(),
      ),
    };
  }
}

const labels: Partial<Record<TriggerRunStatus, string>> = {
  completed: 'terminée',
  failed: 'en échec',
  cancelled: 'annulée',
};

/** Retries carry the user's original request, not the "[Mission proactive …]" wrapper. */
function originalRequest(request: string): string {
  return request.replace(/^\[Mission proactive « .*? »\]\s*/, '');
}

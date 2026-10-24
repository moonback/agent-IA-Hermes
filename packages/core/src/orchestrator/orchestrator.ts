import {
  MissionBudget,
  type ExecutorAgentId,
  type Mission,
  type MissionResult,
  type Task,
  type TaskStatus,
  type ToolCallRecord,
  type Verdict,
} from '../shared/contracts';
import { HermesError, errorCode, errorMessage } from '../shared/errors';
import {
  TERMINAL_MISSION_STATUSES,
  TERMINAL_TASK_STATUSES,
  canTransitionTask,
} from '../shared/state-machine';
import { nowIso, sleep } from '../shared/util';
import type { HermesStore } from '../persistence/store';
import type { Telemetry } from '../observability/telemetry';
import type { PolicyConfig } from '../policy-engine/policy';
import type { ToolExecutor } from '../tools/executor';
import type { AnyTool } from '../tools/types';
import { BudgetTracker } from '../agents/llm-gateway';
import type { Planner } from '../agents/planner';
import type { Verifier } from '../agents/verifier';
import type { Agent } from '../agents/tool-agent';

type StopReason = 'cancel' | 'emergency' | 'budget' | null;

interface Active {
  abort: AbortController;
  pause: boolean;
  stopReason: StopReason;
  budget: BudgetTracker;
  loop: Promise<void> | null;
}

export interface OrchestratorDeps {
  store: HermesStore;
  telemetry: Telemetry;
  executor: ToolExecutor;
  tools: ReadonlyMap<string, AnyTool>;
  planner: Planner;
  verifier: Verifier;
  agents: Record<ExecutorAgentId, Agent>;
  getPolicy: () => PolicyConfig;
  defaultBudget: () => MissionBudget;
  unavailableTools: () => Promise<Map<string, string>>;
  closeMissionResources: (missionId: string) => Promise<void>;
  stopAllWorkers: () => Promise<{ processes: number }>;
}

const UNCERTAIN = 'uncertain_effect';
const DEPENDENCY = 'dependency_failed';
/** Errors that a retry of the same step cannot fix. */
const NO_RETRY = new Set([
  'CONFIG',
  'POLICY_DENIED',
  'APPROVAL_DENIED',
  'BUDGET_EXCEEDED',
  'EMERGENCY_STOP',
  'UNKNOWN_TOOL',
]);

export class Orchestrator {
  private readonly active = new Map<string, Active>();

  constructor(private readonly d: OrchestratorDeps) {}

  private event(
    missionId: string | null,
    type: string,
    message: string,
    extra: {
      taskId?: string | null;
      level?: 'info' | 'warn' | 'error';
      data?: unknown;
      errorCode?: string | null;
      agent?: string;
    } = {},
  ) {
    this.d.telemetry.record({
      missionId,
      category: 'orchestration',
      type,
      message,
      ...extra,
      agent: extra.agent ?? 'orchestrator',
    });
  }

  isActive(missionId: string): boolean {
    return this.active.has(missionId);
  }

  activeCount(): number {
    return this.active.size;
  }

  /** Resolves when the mission's current planning or execution loop has fully settled (tests, shutdown). */
  async idle(missionId: string): Promise<void> {
    await this.active.get(missionId)?.loop;
  }

  private budgetFor(m: Mission): BudgetTracker {
    return new BudgetTracker(m.budget, { ...m.usage }, Date.parse(m.startedAt ?? m.createdAt), (u) =>
      this.d.store.setMissionUsage(m.id, u),
    );
  }

  // ------------------------------------------------------------------ planning

  createMission(request: string, budget?: Partial<MissionBudget>): Mission {
    if (this.d.executor.isHalted)
      throw new HermesError(
        'EMERGENCY_STOP',
        "Arrêt d'urgence actif : réarmez HERMES avant de créer une mission",
      );
    const text = request.trim();
    if (text.length < 2 || text.length > 8000)
      throw new HermesError('VALIDATION', 'La demande doit contenir entre 2 et 8000 caractères');
    const m = this.d.store.createMission(text, MissionBudget.parse({ ...this.d.defaultBudget(), ...budget }));
    this.event(m.id, 'mission.created', 'Mission créée, planification en cours');
    const act: Active = {
      abort: new AbortController(),
      pause: false,
      stopReason: null,
      budget: this.budgetFor(m),
      loop: null,
    };
    this.active.set(m.id, act);
    act.loop = this.planMission(m.id, act).finally(() => this.active.delete(m.id));
    return m;
  }

  private async planMission(id: string, act: Active): Promise<void> {
    const m = this.d.store.requireMission(id);
    try {
      const unavailable = await this.d.unavailableTools();
      const memory = [
        ...this.d.store.searchMemory({ kind: 'preference', limit: 10 }),
        ...this.d.store.searchMemory({ text: m.request, kind: 'mission_summary', limit: 4 }),
      ];
      const plan = await this.d.planner.plan({
        missionId: id,
        request: m.request,
        tools: this.d.tools,
        unavailable,
        memory,
        allowedRoots: this.d.getPolicy().allowedRoots,
        budget: act.budget,
        signal: act.abort.signal,
      });
      if (act.stopReason) return;
      this.d.store.tx(() => {
        this.d.store.setMissionPlan(id, plan);
        this.d.store.createTasks(id, plan);
        this.d.store.setMissionStatus(id, 'planned');
      });
      this.event(id, 'plan.created', `Plan validé : ${plan.steps.length} étape(s)`, {
        data: plan,
        agent: 'planner',
      });
    } catch (err) {
      if (act.stopReason) return; // cancelled / emergency: state already handled
      this.safeMission(id, 'failed', errorMessage(err));
      this.event(id, 'plan.failed', `Planification impossible : ${errorMessage(err)}`, {
        level: 'error',
        errorCode: errorCode(err),
        agent: 'planner',
      });
    }
  }

  // ------------------------------------------------------------------ execution control

  /** Starts a planned mission or resumes a paused/interrupted one. */
  start(id: string, opts: { confirmUncertainTaskIds?: string[] } = {}): Mission {
    if (this.d.executor.isHalted)
      throw new HermesError('EMERGENCY_STOP', "Arrêt d'urgence actif : réarmez HERMES avant de reprendre");
    if (this.active.has(id)) throw new HermesError('VALIDATION', 'La mission est déjà en cours');
    const m = this.d.store.requireMission(id);
    if (!['planned', 'paused', 'interrupted'].includes(m.status))
      throw new HermesError('INVALID_TRANSITION', `Impossible de démarrer une mission « ${m.status} »`);
    for (const t of this.d.store.listTasks(id)) {
      if (
        t.status === 'blocked' &&
        t.blockReason === UNCERTAIN &&
        opts.confirmUncertainTaskIds?.includes(t.id)
      ) {
        const n = this.d.store.abandonUncertainToolCalls(t.id);
        this.d.store.setTaskStatus(t.id, 'ready', { blockReason: null, error: null });
        this.event(
          id,
          'task.uncertainty_confirmed',
          `Reprise confirmée par l'utilisateur (${n} action(s) incertaine(s) abandonnée(s))`,
          { taskId: t.id, level: 'warn' },
        );
      }
    }
    const running = this.d.store.setMissionStatus(id, 'running');
    const act: Active = {
      abort: new AbortController(),
      pause: false,
      stopReason: null,
      budget: this.budgetFor(running),
      loop: null,
    };
    this.active.set(id, act);
    this.event(
      id,
      m.status === 'planned' ? 'mission.started' : 'mission.resumed',
      m.status === 'planned' ? 'Exécution démarrée' : 'Exécution reprise',
    );
    act.loop = this.runLoop(id, act)
      .catch((err) => {
        this.event(id, 'mission.crashed', `Erreur interne de l'orchestrateur : ${errorMessage(err)}`, {
          level: 'error',
          errorCode: errorCode(err),
        });
        this.safeMission(id, 'failed', errorMessage(err));
      })
      .finally(() => this.active.delete(id));
    return running;
  }

  pause(id: string, reason: string): void {
    const act = this.active.get(id);
    if (!act) throw new HermesError('VALIDATION', "La mission n'est pas en cours d'exécution");
    act.pause = true;
    this.event(
      id,
      'mission.pause_requested',
      `Pause demandée : ${reason}. Les tâches s'arrêtent après l'action en cours.`,
    );
  }

  cancel(id: string, reason: string): Mission {
    const m = this.d.store.requireMission(id);
    if (TERMINAL_MISSION_STATUSES.includes(m.status))
      throw new HermesError('INVALID_TRANSITION', `Mission déjà ${m.status}`);
    const act = this.active.get(id);
    if (act) {
      act.stopReason = 'cancel';
      act.abort.abort(new HermesError('CANCELLED', reason));
    }
    for (const t of this.d.store.listTasks(id))
      this.safeTask(t.id, 'cancelled', { error: `Annulée : ${reason}` });
    this.d.store.expirePendingApprovals(id);
    const tasks = this.d.store.listTasks(id);
    const result: MissionResult = {
      status: 'cancelled',
      summary: `Mission annulée : ${reason}`,
      verification: null,
      tasks: tasks.map(taskSummary),
    };
    const out = this.d.store.setMissionStatus(id, 'cancelled', { error: reason, result });
    void this.d.closeMissionResources(id);
    this.event(id, 'mission.cancelled', `Mission annulée : ${reason}`, {
      level: 'warn',
      data: { uncertain: this.uncertainCalls(id).map((c) => c.id) },
    });
    return out;
  }

  /**
   * Global emergency stop: blocks every new action, aborts running work, kills worker processes,
   * persists the state and reports actions whose outcome is unknown.
   */
  async emergencyStop(
    reason = "Arrêt d'urgence demandé par l'utilisateur",
  ): Promise<{ missions: string[]; uncertainToolCalls: ToolCallRecord[]; killedProcesses: number }> {
    this.d.executor.halt();
    const loops: Promise<void>[] = [];
    for (const act of this.active.values()) {
      act.stopReason = 'emergency';
      act.abort.abort(new HermesError('EMERGENCY_STOP', reason));
      if (act.loop) loops.push(act.loop);
    }
    const { processes } = await this.d.stopAllWorkers();
    await Promise.race([Promise.allSettled(loops), sleep(5000)]);
    const affected = this.d.store.listMissions({ status: ['running', 'paused', 'planning'], limit: 500 });
    const uncertainToolCalls: ToolCallRecord[] = [];
    for (const m of affected) {
      this.settleInterruptedTasks(m.id);
      if (m.status === 'planning') this.safeMission(m.id, 'cancelled', reason);
      else this.safeMission(m.id, 'interrupted', reason);
      uncertainToolCalls.push(...this.uncertainCalls(m.id));
    }
    this.d.store.expirePendingApprovals();
    this.d.telemetry.record({
      category: 'security',
      level: 'warn',
      type: 'emergency.stop',
      message: `${reason} — ${affected.length} mission(s) interrompue(s), ${processes} processus arrêté(s), ${uncertainToolCalls.length} action(s) au résultat incertain`,
      data: {
        missions: affected.map((m) => m.id),
        uncertain: uncertainToolCalls.map((c) => ({ id: c.id, toolId: c.toolId, missionId: c.missionId })),
      },
    });
    return { missions: affected.map((m) => m.id), uncertainToolCalls, killedProcesses: processes };
  }

  rearm(): void {
    this.d.executor.resume();
    this.d.telemetry.record({
      category: 'security',
      level: 'warn',
      type: 'emergency.rearmed',
      message: "HERMES réarmé par l'utilisateur après arrêt d'urgence",
    });
  }

  /** Called at startup: nothing is "running" after a restart. Never replays an external action blindly. */
  recoverOnStartup(): { interrupted: string[]; failedPlanning: string[] } {
    const interrupted: string[] = [];
    const failedPlanning: string[] = [];
    for (const m of this.d.store.listMissions({ status: ['running', 'planning'], limit: 500 })) {
      this.settleInterruptedTasks(m.id);
      if (m.status === 'planning') {
        this.safeMission(m.id, 'failed', 'Application fermée pendant la planification');
        failedPlanning.push(m.id);
      } else {
        this.safeMission(m.id, 'interrupted', "Application fermée pendant l'exécution");
        interrupted.push(m.id);
      }
    }
    const expired = this.d.store.expirePendingApprovals();
    if (interrupted.length || failedPlanning.length || expired) {
      this.d.telemetry.record({
        category: 'orchestration',
        level: 'warn',
        type: 'recovery.startup',
        message: `${interrupted.length} mission(s) interrompue(s) détectée(s), ${expired} approbation(s) expirée(s)`,
        data: { interrupted, failedPlanning },
      });
    }
    return { interrupted, failedPlanning };
  }

  /** Running tasks become ready again, unless a non-idempotent action has an unknown outcome. */
  private settleInterruptedTasks(missionId: string): void {
    for (const t of this.d.store.listTasks(missionId)) {
      if (t.status !== 'running' && t.status !== 'waiting_approval') continue;
      const uncertain = this.d.store.listToolCalls({ taskId: t.id }).filter((c) => c.status === 'started');
      if (uncertain.length) {
        this.safeTask(t.id, 'blocked', {
          blockReason: UNCERTAIN,
          error: `Résultat incertain de ${uncertain.map((c) => c.toolId).join(', ')} : vérifiez l'état réel puis confirmez la reprise`,
        });
      } else this.safeTask(t.id, 'ready');
    }
  }

  private uncertainCalls(missionId: string): ToolCallRecord[] {
    return this.d.store.listToolCalls({ missionId, limit: 2000 }).filter((c) => c.status === 'started');
  }

  // ------------------------------------------------------------------ scheduling

  private async runLoop(id: string, act: Active): Promise<void> {
    const running = new Map<string, Promise<void>>();
    const exclusive = (a: string) => a === 'computer' || a === 'browser';
    try {
      for (;;) {
        if (act.abort.signal.aborted) break;
        const tasks = this.d.store.listTasks(id);
        const byId = new Map(tasks.map((t) => [t.id, t]));
        for (const t of tasks) {
          if (t.status !== 'pending') continue;
          const deps = t.dependsOn.map((dep) => byId.get(dep)).filter((x): x is Task => Boolean(x));
          if (deps.every((x) => x.status === 'completed')) this.d.store.setTaskStatus(t.id, 'ready');
          else if (
            deps.some(
              (x) =>
                x.status === 'failed' ||
                x.status === 'cancelled' ||
                (x.status === 'blocked' && x.blockReason === DEPENDENCY),
            )
          ) {
            this.d.store.setTaskStatus(t.id, 'blocked', {
              blockReason: DEPENDENCY,
              error: 'Une étape dont elle dépend a échoué',
            });
            this.event(id, 'task.blocked', `Étape ${t.stepId} bloquée : dépendance en échec`, {
              taskId: t.id,
              level: 'warn',
            });
          }
        }
        if (!act.pause) {
          for (const t of this.d.store.listTasks(id)) {
            if (t.status !== 'ready' || running.has(t.id)) continue;
            if (running.size >= act.budget.budget.maxParallelTasks) break;
            // Desktop and browser share one screen / one page: never run them in parallel.
            if (
              exclusive(t.agent) &&
              [...running.keys()].some((rid) => exclusive(byId.get(rid)?.agent ?? ''))
            )
              continue;
            running.set(
              t.id,
              this.runTask(id, t.id, act).finally(() => running.delete(t.id)),
            );
          }
        }
        if (running.size === 0) break;
        await Promise.race(running.values());
      }
    } finally {
      await Promise.allSettled(running.values());
    }
    await this.finalize(id, act);
  }

  private async finalize(id: string, act: Active): Promise<void> {
    if (act.stopReason === 'cancel' || act.stopReason === 'emergency') return;
    const tasks = this.d.store.listTasks(id);
    if (act.stopReason === 'budget') {
      for (const t of tasks) this.safeTask(t.id, 'cancelled', { error: 'Budget de mission dépassé' });
      this.finish(id, 'failed', 'Budget de mission dépassé : exécution arrêtée', null);
      return;
    }
    if (act.pause) {
      this.safeMission(id, 'paused', null);
      this.event(id, 'mission.paused', 'Mission en pause');
      return;
    }
    const needsConfirmation = tasks.filter((t) => t.status === 'blocked' && t.blockReason === UNCERTAIN);
    if (needsConfirmation.length) {
      this.safeMission(id, 'paused', 'Confirmation requise : une action a un résultat incertain');
      this.event(
        id,
        'mission.needs_confirmation',
        `${needsConfirmation.length} étape(s) attendent votre confirmation avant reprise`,
        { level: 'warn' },
      );
      return;
    }
    let verdict: Verdict;
    const mission = this.d.store.requireMission(id);
    try {
      verdict = await this.d.verifier.verifyMission({
        mission,
        tasks,
        calls: this.d.store.listToolCalls({ missionId: id, limit: 2000 }),
        budget: act.budget,
        signal: act.abort.signal,
      });
    } catch (err) {
      verdict = {
        verdict: 'fail',
        reasons: [`Vérification finale impossible : ${errorMessage(err)}`],
        unsupportedClaims: [],
      };
    }
    this.event(
      id,
      'mission.verified',
      `Vérification finale : ${verdict.verdict} — ${verdict.reasons.join(' ; ')}`,
      {
        agent: 'verifier',
        level: verdict.verdict === 'pass' ? 'info' : 'warn',
        data: verdict,
      },
    );
    const ok = verdict.verdict === 'pass' && tasks.every((t) => t.status === 'completed');
    const summary = tasks
      .map((t) => `• ${t.stepId} (${t.status}) : ${t.result?.summary ?? t.error ?? ''}`)
      .join('\n');
    this.finish(id, ok ? 'completed' : 'failed', summary, verdict);
  }

  private finish(id: string, status: 'completed' | 'failed', summary: string, verdict: Verdict | null) {
    const tasks = this.d.store.listTasks(id);
    const result: MissionResult = { status, summary, verification: verdict, tasks: tasks.map(taskSummary) };
    this.safeMission(
      id,
      status,
      status === 'failed' ? (verdict?.reasons.join(' ; ') ?? summary).slice(0, 2000) : null,
      result,
    );
    const m = this.d.store.requireMission(id);
    this.d.store.addMemory({
      kind: 'mission_summary',
      content: `Mission « ${m.request.slice(0, 200)} » → ${status}. ${summary.slice(0, 1500)}`,
      origin: 'orchestrator',
      missionId: id,
      confidence: verdict?.verdict === 'pass' ? 0.9 : 0.4,
      tags: [status],
    });
    void this.d.closeMissionResources(id);
    this.event(
      id,
      `mission.${status}`,
      status === 'completed' ? 'Mission terminée et vérifiée' : 'Mission terminée sans réussite vérifiée',
      {
        level: status === 'completed' ? 'info' : 'warn',
      },
    );
  }

  private async runTask(missionId: string, taskId: string, act: Active): Promise<void> {
    const initial = this.d.store.requireTask(taskId);
    const attempt = initial.attempts + 1;
    if (attempt > 1)
      await sleep(Math.min(1000 * 2 ** (attempt - 2), 8000), act.abort.signal).catch(() => undefined);
    if (act.abort.signal.aborted || act.pause) return;
    const task = this.d.store.setTaskStatus(taskId, 'running', { incrementAttempt: true });
    const attemptStartedAt = nowIso();
    const agent = this.d.agents[task.agent];
    this.event(
      missionId,
      'task.started',
      `Étape ${task.stepId} (tentative ${attempt}/${task.maxAttempts}) confiée à ${agent.descriptor.name}`,
      { taskId, agent: task.agent },
    );
    const timeout = AbortSignal.timeout(task.spec.timeoutSec * 1000);
    const signal = AbortSignal.any([act.abort.signal, timeout]);
    const usage0 = { ...act.budget.usage };
    const runId = this.d.store.startAgentRun({ missionId, taskId, agent: task.agent, model: null, attempt });
    const endRun = (status: string, error: string | null) =>
      this.d.store.endAgentRun(runId, {
        status,
        aiCalls: act.budget.usage.aiCalls - usage0.aiCalls,
        promptTokens: act.budget.usage.promptTokens - usage0.promptTokens,
        completionTokens: act.budget.usage.completionTokens - usage0.completionTokens,
        costUsd: act.budget.usage.costUsd - usage0.costUsd,
        error,
      });
    try {
      const dependencies = task.dependsOn.map((dep) => {
        const t = this.d.store.requireTask(dep);
        return { stepId: t.stepId, summary: t.result?.summary ?? '', outputs: t.result?.outputs ?? {} };
      });
      const result = await agent.execute({
        missionId,
        task,
        attempt,
        signal,
        budget: act.budget,
        dependencies,
        memory: this.d.store.searchMemory({ text: task.objective, limit: 4 }),
        feedback: attempt > 1 ? task.error : null,
        isPauseRequested: () => act.pause,
        onApprovalWait: (a) => {
          this.safeTask(taskId, 'waiting_approval');
          this.event(
            missionId,
            'task.waiting_approval',
            `Étape ${task.stepId} : approbation requise — ${a.description}`,
            { taskId, data: { approvalId: a.id } },
          );
        },
        onApprovalResolved: () => this.safeTask(taskId, 'running'),
      });
      const calls = this.d.store.listToolCalls({ taskId, limit: 2000 });
      const verdict = await this.d.verifier.verifyTask({
        mission: this.d.store.requireMission(missionId),
        task,
        result,
        calls,
        attemptStartedAt,
        budget: act.budget,
        signal,
      });
      this.event(
        missionId,
        'task.verified',
        `Étape ${task.stepId} — vérification ${verdict.verdict} : ${verdict.reasons.join(' ; ')}`,
        {
          taskId,
          agent: 'verifier',
          level: verdict.verdict === 'pass' ? 'info' : 'warn',
          data: verdict,
        },
      );
      if (verdict.verdict === 'pass') {
        this.d.store.setTaskStatus(taskId, 'completed', {
          result: { ...result, status: 'completed' },
          error: null,
        });
        endRun('completed', null);
        this.event(missionId, 'task.completed', `Étape ${task.stepId} terminée et vérifiée`, {
          taskId,
          agent: task.agent,
        });
        return;
      }
      const msg = `Vérification « ${verdict.verdict} » : ${verdict.reasons.join(' ; ')}${verdict.correctionRequest ? ` — Correction demandée : ${verdict.correctionRequest}` : ''}`;
      this.d.store.setTaskStatus(taskId, 'failed', { error: msg, result: { ...result, status: 'failed' } });
      endRun('failed', msg);
      this.retryOrFail(missionId, taskId, attempt, msg, 'VERIFICATION');
    } catch (err) {
      const code = errorCode(err);
      const message = errorMessage(err);
      endRun(code === 'PAUSED' ? 'paused' : 'failed', message);
      if (act.stopReason === 'cancel' || act.stopReason === 'emergency') return; // handled by cancel()/emergencyStop()
      if (code === 'PAUSED' || (act.pause && code === 'CANCELLED')) {
        this.safeTask(taskId, 'ready');
        this.d.store.refundAttempt(taskId);
        return;
      }
      if (code === 'UNCERTAIN_EFFECT') {
        this.safeTask(taskId, 'blocked', { blockReason: UNCERTAIN, error: message });
        this.event(missionId, 'task.blocked', `Étape ${task.stepId} : ${message}`, {
          taskId,
          level: 'warn',
          errorCode: code,
        });
        return;
      }
      if (code === 'BUDGET_EXCEEDED') {
        act.stopReason = 'budget';
        act.abort.abort(err);
        this.safeTask(taskId, 'failed', { error: message });
        this.event(missionId, 'budget.exceeded', message, { taskId, level: 'error', errorCode: code });
        return;
      }
      const finalMessage = timeout.aborted ? `Délai de l'étape dépassé (${task.spec.timeoutSec} s)` : message;
      this.safeTask(taskId, 'failed', { error: finalMessage });
      this.event(missionId, 'task.failed', `Étape ${task.stepId} en échec : ${finalMessage}`, {
        taskId,
        level: 'error',
        errorCode: timeout.aborted ? 'TOOL_TIMEOUT' : code,
      });
      this.retryOrFail(missionId, taskId, attempt, finalMessage, code);
    }
  }

  private retryOrFail(missionId: string, taskId: string, attempt: number, message: string, code: string) {
    const t = this.d.store.requireTask(taskId);
    if (attempt < t.maxAttempts && !NO_RETRY.has(code)) {
      this.d.store.setTaskStatus(taskId, 'ready');
      this.event(
        missionId,
        'task.retry',
        `Nouvelle tentative de l'étape ${t.stepId} avec le retour : ${message.slice(0, 300)}`,
        { taskId, level: 'warn' },
      );
    }
  }

  /** Verification on demand for the mission.verify tool (evidence produced so far). */
  async verifyTaskNow(taskId: string, signal: AbortSignal): Promise<Verdict> {
    const task = this.d.store.requireTask(taskId);
    const mission = this.d.store.requireMission(task.missionId);
    const act = this.active.get(mission.id);
    const now = nowIso();
    return this.d.verifier.verifyTask({
      mission,
      task,
      calls: this.d.store.listToolCalls({ taskId }),
      budget: act?.budget ?? this.budgetFor(mission),
      signal,
      result: {
        taskId,
        status: 'completed',
        summary: 'Vérification intermédiaire demandée par l’agent',
        outputs: {},
        evidence: [],
        errors: [],
        warnings: [],
        approvalRequests: [],
        metadata: {
          agent: task.agent,
          attempt: task.attempts,
          startedAt: now,
          endedAt: now,
          aiCalls: 0,
          toolCalls: 0,
        },
      },
    });
  }

  // ------------------------------------------------------------------ helpers

  private safeTask(
    id: string,
    to: TaskStatus,
    patch: { error?: string | null; blockReason?: string | null } = {},
  ): void {
    const t = this.d.store.getTask(id);
    if (
      !t ||
      t.status === to ||
      TERMINAL_TASK_STATUSES.includes(t.status) ||
      !canTransitionTask(t.status, to)
    )
      return;
    this.d.store.setTaskStatus(id, to, patch);
  }

  private safeMission(id: string, to: Mission['status'], error: string | null, result?: MissionResult): void {
    const m = this.d.store.getMission(id);
    if (!m || m.status === to || TERMINAL_MISSION_STATUSES.includes(m.status)) return;
    try {
      this.d.store.setMissionStatus(id, to, { error, result });
    } catch (err) {
      this.event(id, 'mission.state_error', errorMessage(err), { level: 'error' });
    }
  }
}

function taskSummary(t: Task): MissionResult['tasks'][number] {
  return { id: t.id, stepId: t.stepId, status: t.status, verified: t.status === 'completed' };
}

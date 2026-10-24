import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MissionBudget,
  MissionUsage,
  type Approval,
  type ApprovalStatus,
  type EventCategory,
  type LogLevel,
  type MemoryEntry,
  type MemoryKind,
  type Mission,
  type MissionEvent,
  type MissionResult,
  type MissionStatus,
  type Plan,
  type PlanStep,
  type Task,
  type TaskResult,
  type TaskStatus,
  type ToolCallRecord,
  type ToolCallStatus,
  type ExecutorAgentId,
} from '../shared/contracts';
import { assertMissionTransition, assertTaskTransition } from '../shared/state-machine';
import { HermesError } from '../shared/errors';
import { redact, truncateDeep } from '../shared/redact';
import { newId, nowIso, sha256, stableStringify } from '../shared/util';
import { MIGRATIONS } from './migrations';
import type {
  ScheduledTrigger,
  TriggerBudget,
  TriggerInput,
  TriggerKind,
  TriggerRun,
  TriggerRunStatus,
  TriggerSpec,
} from '../scheduler/triggers';

type Row = Record<string, SQLInputValue>;

const json = (v: unknown): string => JSON.stringify(v ?? null);
const parse = <T>(v: SQLInputValue | undefined, fallback: T): T =>
  typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
const str = (v: SQLInputValue | undefined): string | null => (typeof v === 'string' ? v : null);
const num = (v: SQLInputValue | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0));

/** Values written to persistent storage are always redacted and bounded. */
const safe = (v: unknown): string => json(truncateDeep(redact(v)));

export interface NewEvent {
  missionId?: string | null;
  taskId?: string | null;
  agent?: string | null;
  toolId?: string | null;
  category: EventCategory;
  level?: LogLevel;
  type: string;
  message: string;
  data?: unknown;
  errorCode?: string | null;
}

export class HermesStore {
  readonly db: DatabaseSync;
  private lastHash = 'GENESIS';

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    const last = this.db.prepare('SELECT hash FROM mission_events ORDER BY seq DESC LIMIT 1').get() as
      Row | undefined;
    if (last) this.lastHash = String(last.hash);
  }

  close(): void {
    this.db.close();
  }

  private txDepth = 0;

  /** Transaction; nested calls become savepoints so composed operations stay atomic. */
  tx<T>(fn: () => T): T {
    const sp = `sp_${this.txDepth}`;
    this.db.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)',
    );
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Row[]).map((r) => num(r.version)),
    );
    const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
    if (pending.length > 0 && applied.size > 0 && this.path !== ':memory:') {
      this.backup(`${this.path}.pre-v${pending[0]!.version}.bak`);
    }
    for (const m of pending) {
      this.tx(() => {
        this.db.exec(m.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, nowIso());
      });
    }
  }

  schemaVersion(): number {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as Row;
    return num(r.v);
  }

  /** Consistent online copy of the database (SQLite VACUUM INTO). */
  backup(target: string): string {
    if (existsSync(target)) throw new HermesError('COLLISION', `La sauvegarde existe déjà : ${target}`);
    mkdirSync(dirname(target), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(target);
    return target;
  }

  // ---------------------------------------------------------------- events (audit)

  appendEvent(e: NewEvent): MissionEvent {
    const event = {
      id: newId('evt'),
      missionId: e.missionId ?? null,
      taskId: e.taskId ?? null,
      agent: e.agent ?? null,
      toolId: e.toolId ?? null,
      category: e.category,
      level: e.level ?? 'info',
      type: e.type,
      message: redact(e.message),
      data: e.data === undefined ? null : truncateDeep(redact(e.data)),
      errorCode: e.errorCode ?? null,
      createdAt: nowIso(),
    };
    const hash = sha256(this.lastHash + stableStringify(event));
    const res = this.db
      .prepare(
        `INSERT INTO mission_events (id, mission_id, task_id, agent, tool_id, category, level, type, message, data_json, error_code, created_at, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.missionId,
        event.taskId,
        event.agent,
        event.toolId,
        event.category,
        event.level,
        event.type,
        event.message,
        json(event.data),
        event.errorCode,
        event.createdAt,
        this.lastHash,
        hash,
      );
    this.lastHash = hash;
    return { seq: Number(res.lastInsertRowid), ...event };
  }

  listEvents(
    q: { missionId?: string; category?: string; afterSeq?: number; limit?: number; level?: string } = {},
  ): MissionEvent[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.missionId) {
      where.push('mission_id = ?');
      params.push(q.missionId);
    }
    if (q.category) {
      where.push('category = ?');
      params.push(q.category);
    }
    if (q.level) {
      where.push('level = ?');
      params.push(q.level);
    }
    if (q.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(q.afterSeq);
    }
    const limit = Math.min(q.limit ?? 200, 2000);
    const sql = `SELECT * FROM mission_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToEvent).reverse();
  }

  /** Recomputes the hash chain; detects edits made outside HERMES (e.g. with a SQLite editor). */
  verifyAuditChain(): { ok: boolean; checked: number; brokenAtSeq: number | null; purgedGaps: number } {
    const lastPurge = this.db
      .prepare(`SELECT MAX(seq) AS s FROM mission_events WHERE type = 'history.purged'`)
      .get() as Row;
    const purgeSeq = lastPurge.s == null ? 0 : num(lastPurge.s);
    let prev: string | null = null;
    let checked = 0;
    let purgedGaps = 0;
    for (const r of this.db
      .prepare('SELECT * FROM mission_events ORDER BY seq ASC')
      .iterate() as Iterable<Row>) {
      const ev = rowToEvent(r);
      const { seq: _seq, ...body } = ev;
      // Each row must hash to its own content: detects edited rows.
      if (sha256(String(r.prev_hash) + stableStringify(body)) !== r.hash)
        return { ok: false, checked, brokenAtSeq: ev.seq, purgedGaps };
      // Missing links are only legitimate where an explicit purge removed rows.
      if (prev !== null && r.prev_hash !== prev) {
        if (ev.seq <= purgeSeq) purgedGaps++;
        else return { ok: false, checked, brokenAtSeq: ev.seq, purgedGaps };
      }
      prev = String(r.hash);
      checked++;
    }
    return { ok: true, checked, brokenAtSeq: null, purgedGaps };
  }

  /** Explicit, documented history purge for missions ended before `beforeIso`. Logged in the audit trail. */
  purgeHistory(beforeIso: string): { missions: number; events: number } {
    const result = this.tx(() => {
      const ids = (
        this.db
          .prepare(
            `SELECT id FROM missions WHERE ended_at IS NOT NULL AND ended_at < ? AND status IN ('completed','failed','cancelled')`,
          )
          .all(beforeIso) as Row[]
      ).map((r) => String(r.id));
      this.db.prepare(`INSERT OR IGNORE INTO maintenance_flags (name) VALUES ('purge_events')`).run();
      let events = 0;
      for (const id of ids) {
        events += Number(this.db.prepare('DELETE FROM mission_events WHERE mission_id = ?').run(id).changes);
        this.db.prepare('DELETE FROM missions WHERE id = ?').run(id);
      }
      this.db.prepare(`DELETE FROM maintenance_flags WHERE name = 'purge_events'`).run();
      return { missions: ids.length, events };
    });
    // The chain restarts from the purge marker; earlier links were deliberately removed.
    this.appendEvent({
      category: 'persistence',
      level: 'warn',
      type: 'history.purged',
      message: `Purge explicite de l'historique antérieur à ${beforeIso}`,
      data: result,
    });
    return result;
  }

  // ---------------------------------------------------------------- missions

  createMission(request: string, budget: MissionBudget): Mission {
    const now = nowIso();
    const m: Mission = {
      id: newId('msn'),
      request,
      status: 'planning',
      plan: null,
      result: null,
      budget,
      usage: MissionUsage.parse({}),
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO missions (id, request, status, budget_json, usage_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(m.id, redact(request), m.status, json(budget), json(m.usage), now, now);
    return m;
  }

  getMission(id: string): Mission | null {
    const r = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToMission(r) : null;
  }

  requireMission(id: string): Mission {
    const m = this.getMission(id);
    if (!m) throw new HermesError('NOT_FOUND', `Mission introuvable : ${id}`);
    return m;
  }

  listMissions(q: { status?: MissionStatus[]; search?: string; limit?: number } = {}): Mission[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.status?.length) {
      where.push(`status IN (${q.status.map(() => '?').join(',')})`);
      params.push(...q.status);
    }
    if (q.search) {
      where.push('(request LIKE ? OR result_json LIKE ?)');
      params.push(`%${q.search}%`, `%${q.search}%`);
    }
    const sql = `SELECT * FROM missions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${Math.min(q.limit ?? 50, 500)}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToMission);
  }

  setMissionStatus(
    id: string,
    to: MissionStatus,
    patch: { error?: string | null; result?: MissionResult } = {},
  ): Mission {
    const m = this.requireMission(id);
    if (m.status !== to) assertMissionTransition(m.status, to);
    const now = nowIso();
    const terminal = to === 'completed' || to === 'failed' || to === 'cancelled';
    this.db
      .prepare(
        `UPDATE missions SET status = ?, updated_at = ?, error = COALESCE(?, error), result_json = COALESCE(?, result_json),
         started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
         ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?`,
      )
      .run(
        to,
        now,
        patch.error === undefined ? null : redact(patch.error),
        patch.result ? safe(patch.result) : null,
        to,
        now,
        terminal ? 1 : 0,
        now,
        id,
      );
    return this.requireMission(id);
  }

  setMissionPlan(id: string, plan: Plan): void {
    this.db
      .prepare('UPDATE missions SET plan_json = ?, updated_at = ? WHERE id = ?')
      .run(json(plan), nowIso(), id);
  }

  setMissionUsage(id: string, usage: MissionUsage): void {
    this.db
      .prepare('UPDATE missions SET usage_json = ?, updated_at = ? WHERE id = ?')
      .run(json(usage), nowIso(), id);
  }

  deleteMission(id: string): boolean {
    this.requireMission(id); // throws NOT_FOUND if missing
    // ON DELETE CASCADE handles tasks, tool_calls, approvals, agent_runs, artifacts, mission_events
    return Number(this.db.prepare('DELETE FROM missions WHERE id = ?').run(id).changes) > 0;
  }

  // ---------------------------------------------------------------- tasks

  /** Creates all tasks of a validated plan atomically, with their dependency edges. */
  createTasks(missionId: string, plan: Plan): Task[] {
    return this.tx(() => {
      const now = nowIso();
      const idByStep = new Map<string, string>();
      for (const step of plan.steps) idByStep.set(step.id, newId('tsk'));
      for (const step of plan.steps) {
        this.db
          .prepare(
            `INSERT INTO tasks (id, mission_id, step_id, agent, objective, spec_json, status, attempts, max_attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          )
          .run(
            idByStep.get(step.id)!,
            missionId,
            step.id,
            step.agent,
            step.objective,
            json(step),
            step.maxAttempts,
            now,
            now,
          );
      }
      for (const step of plan.steps) {
        for (const dep of step.dependsOn) {
          this.db
            .prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)')
            .run(idByStep.get(step.id)!, idByStep.get(dep)!);
        }
      }
      return this.listTasks(missionId);
    });
  }

  listTasks(missionId: string): Task[] {
    const deps = new Map<string, string[]>();
    for (const r of this.db
      .prepare(
        'SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.mission_id = ?',
      )
      .all(missionId) as Row[]) {
      const k = String(r.task_id);
      deps.set(k, [...(deps.get(k) ?? []), String(r.depends_on_task_id)]);
    }
    return (
      this.db.prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY rowid').all(missionId) as Row[]
    ).map((r) => rowToTask(r, deps.get(String(r.id)) ?? []));
  }

  getTask(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const deps = (
      this.db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?').all(id) as Row[]
    ).map((d) => String(d.depends_on_task_id));
    return rowToTask(r, deps);
  }

  requireTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new HermesError('NOT_FOUND', `Tâche introuvable : ${id}`);
    return t;
  }

  setTaskStatus(
    id: string,
    to: TaskStatus,
    patch: {
      error?: string | null;
      blockReason?: string | null;
      result?: TaskResult;
      incrementAttempt?: boolean;
    } = {},
  ): Task {
    const t = this.requireTask(id);
    if (t.status !== to) assertTaskTransition(t.status, to);
    const now = nowIso();
    const terminal = to === 'completed' || to === 'failed' || to === 'cancelled';
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, updated_at = ?,
          error = CASE WHEN ? THEN ? ELSE error END,
          block_reason = CASE WHEN ? THEN ? ELSE block_reason END,
          result_json = COALESCE(?, result_json),
          attempts = attempts + ?,
          started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
          ended_at = CASE WHEN ? THEN ? ELSE NULL END
         WHERE id = ?`,
      )
      .run(
        to,
        now,
        patch.error !== undefined ? 1 : 0,
        patch.error == null ? null : redact(patch.error),
        patch.blockReason !== undefined ? 1 : 0,
        patch.blockReason ?? null,
        patch.result ? safe(patch.result) : null,
        patch.incrementAttempt ? 1 : 0,
        to,
        now,
        terminal ? 1 : 0,
        now,
        id,
      );
    return this.requireTask(id);
  }

  // ---------------------------------------------------------------- agent runs

  startAgentRun(r: {
    missionId: string;
    taskId: string | null;
    agent: string;
    model: string | null;
    attempt: number;
  }): string {
    const id = newId('run');
    this.db
      .prepare(
        'INSERT INTO agent_runs (id, mission_id, task_id, agent, model, attempt, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, r.missionId, r.taskId, r.agent, r.model, r.attempt, 'running', nowIso());
    return id;
  }

  endAgentRun(
    id: string,
    r: {
      status: string;
      aiCalls: number;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      error?: string | null;
    },
  ): void {
    this.db
      .prepare(
        'UPDATE agent_runs SET status = ?, ai_calls = ?, prompt_tokens = ?, completion_tokens = ?, cost_usd = ?, error = ?, ended_at = ? WHERE id = ?',
      )
      .run(
        r.status,
        r.aiCalls,
        r.promptTokens,
        r.completionTokens,
        r.costUsd,
        r.error ? redact(r.error) : null,
        nowIso(),
        id,
      );
  }

  agentStats(): {
    agent: string;
    runs: number;
    failures: number;
    lastError: string | null;
    lastRunAt: string | null;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT agent, COUNT(*) AS runs, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures, MAX(started_at) AS last_run,
            (SELECT error FROM agent_runs a2 WHERE a2.agent = a.agent AND a2.error IS NOT NULL ORDER BY started_at DESC LIMIT 1) AS last_error
           FROM agent_runs a GROUP BY agent`,
        )
        .all() as Row[]
    ).map((r) => ({
      agent: String(r.agent),
      runs: num(r.runs),
      failures: num(r.failures),
      lastError: str(r.last_error),
      lastRunAt: str(r.last_run),
    }));
  }

  // ---------------------------------------------------------------- tool calls

  startToolCall(c: {
    missionId: string;
    taskId: string | null;
    agent: string;
    toolId: string;
    input: unknown;
    inputHash: string;
    idempotencyKey: string | null;
    policyDecision: string;
    approvalId: string | null;
  }): string {
    const id = newId('tc');
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, mission_id, task_id, agent, tool_id, input_json, input_hash, idempotency_key, status, policy_decision, approval_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)`,
      )
      .run(
        id,
        c.missionId,
        c.taskId,
        c.agent,
        c.toolId,
        safe(c.input),
        c.inputHash,
        c.idempotencyKey,
        c.policyDecision,
        c.approvalId,
        nowIso(),
      );
    return id;
  }

  finishToolCall(
    id: string,
    r: {
      status: ToolCallStatus;
      output?: unknown;
      error?: string | null;
      verified?: boolean | null;
      durationMs: number;
    },
  ): void {
    this.db
      .prepare(
        'UPDATE tool_calls SET status = ?, output_json = ?, error = ?, verified = ?, ended_at = ?, duration_ms = ? WHERE id = ?',
      )
      .run(
        r.status,
        r.output === undefined ? null : safe(r.output),
        r.error ? redact(r.error) : null,
        r.verified == null ? null : r.verified ? 1 : 0,
        nowIso(),
        r.durationMs,
        id,
      );
  }

  /** Records a call that never executed (denied by policy, refused approval, validation error). */
  recordRejectedToolCall(c: {
    missionId: string;
    taskId: string | null;
    agent: string;
    toolId: string;
    input: unknown;
    inputHash: string;
    decision: string;
    error: string;
  }): string {
    const id = newId('tc');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, mission_id, task_id, agent, tool_id, input_json, input_hash, status, policy_decision, error, started_at, ended_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'denied', ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        c.missionId,
        c.taskId,
        c.agent,
        c.toolId,
        safe(c.input),
        c.inputHash,
        c.decision,
        redact(c.error),
        now,
        now,
      );
    return id;
  }

  /** Evidence row for a call answered from a previous identical execution (no side effect repeated). */
  recordDeduplicatedToolCall(prior: ToolCallRecord, taskId: string | null): string {
    const id = newId('tc');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, mission_id, task_id, agent, tool_id, input_json, input_hash, idempotency_key, status, output_json, verified, policy_decision, started_at, ended_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'deduplicated', ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        prior.missionId,
        taskId,
        prior.agent,
        prior.toolId,
        safe(prior.input),
        prior.inputHash,
        safe(prior.output),
        prior.verified == null ? null : prior.verified ? 1 : 0,
        `dedup:${prior.id}`,
        now,
        now,
      );
    return id;
  }

  /** A paused attempt does not count against the retry limit. */
  refundAttempt(taskId: string): void {
    this.db.prepare('UPDATE tasks SET attempts = MAX(attempts - 1, 0) WHERE id = ?').run(taskId);
  }

  findToolCallsByIdempotencyKey(key: string): ToolCallRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM tool_calls WHERE idempotency_key = ? ORDER BY started_at')
        .all(key) as Row[]
    ).map(rowToToolCall);
  }

  listToolCalls(q: { missionId?: string; taskId?: string; limit?: number }): ToolCallRecord[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.missionId) {
      where.push('mission_id = ?');
      params.push(q.missionId);
    }
    if (q.taskId) {
      where.push('task_id = ?');
      params.push(q.taskId);
    }
    const sql = `SELECT * FROM tool_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ${Math.min(q.limit ?? 200, 2000)}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToToolCall).reverse();
  }

  /** Marks uncertain calls of a task as abandoned once the user confirmed how to proceed. */
  abandonUncertainToolCalls(taskId: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE tool_calls SET status = 'abandoned', ended_at = ? WHERE task_id = ? AND status = 'started'`,
        )
        .run(nowIso(), taskId).changes,
    );
  }

  toolStats(): { toolId: string; calls: number; failures: number; avgMs: number | null }[] {
    return (
      this.db
        .prepare(
          `SELECT tool_id, COUNT(*) AS calls, SUM(CASE WHEN status IN ('failed','denied') THEN 1 ELSE 0 END) AS failures, AVG(duration_ms) AS avg_ms
           FROM tool_calls GROUP BY tool_id`,
        )
        .all() as Row[]
    ).map((r) => ({
      toolId: String(r.tool_id),
      calls: num(r.calls),
      failures: num(r.failures),
      avgMs: r.avg_ms == null ? null : num(r.avg_ms),
    }));
  }

  // ---------------------------------------------------------------- approvals

  createApproval(a: {
    missionId: string;
    taskId: string | null;
    toolId: string;
    inputHash: string;
    input: unknown;
    description: string;
    consequences: string;
  }): Approval {
    const id = newId('apr');
    this.db
      .prepare(
        `INSERT INTO approvals (id, mission_id, task_id, tool_id, input_hash, input_json, description, consequences, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        a.missionId,
        a.taskId,
        a.toolId,
        a.inputHash,
        safe(a.input),
        redact(a.description),
        redact(a.consequences),
        nowIso(),
      );
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | null {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToApproval(r) : null;
  }

  listApprovals(q: { status?: ApprovalStatus; missionId?: string } = {}): Approval[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.missionId) {
      where.push('mission_id = ?');
      params.push(q.missionId);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`,
        )
        .all(...params) as Row[]
    ).map(rowToApproval);
  }

  decideApproval(id: string, decision: 'approved' | 'denied'): Approval {
    const res = this.db
      .prepare(`UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .run(decision, nowIso(), id);
    if (Number(res.changes) !== 1)
      throw new HermesError('VALIDATION', `Approbation ${id} introuvable ou déjà traitée`);
    return this.getApproval(id)!;
  }

  /** Atomically consumes an approval: it must be approved and bound to exactly this tool and input. */
  consumeApproval(id: string, toolId: string, inputHash: string): void {
    const res = this.db
      .prepare(
        `UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved' AND tool_id = ? AND input_hash = ?`,
      )
      .run(nowIso(), id, toolId, inputHash);
    if (Number(res.changes) !== 1) {
      throw new HermesError(
        'APPROVAL_MISMATCH',
        "L'approbation ne correspond pas à cette action ou a déjà été utilisée",
      );
    }
  }

  expirePendingApprovals(missionId?: string): number {
    const sql = missionId
      ? `UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND mission_id = ?`
      : `UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'`;
    return Number(
      (missionId ? this.db.prepare(sql).run(nowIso(), missionId) : this.db.prepare(sql).run(nowIso()))
        .changes,
    );
  }

  // ---------------------------------------------------------------- artifacts

  addArtifact(a: {
    missionId: string | null;
    taskId: string | null;
    kind: string;
    path: string;
    mime?: string;
    size?: number;
    sha256?: string;
    description?: string;
  }): string {
    const id = newId('art');
    this.db
      .prepare(
        'INSERT INTO artifacts (id, mission_id, task_id, kind, path, mime, size, sha256, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        a.missionId,
        a.taskId,
        a.kind,
        a.path,
        a.mime ?? null,
        a.size ?? null,
        a.sha256 ?? null,
        a.description ?? null,
        nowIso(),
      );
    return id;
  }

  listArtifacts(q: { missionId?: string; kind?: string; limit?: number }): {
    id: string;
    missionId: string | null;
    taskId: string | null;
    kind: string;
    path: string;
    mime: string | null;
    size: number | null;
    createdAt: string;
    description: string | null;
  }[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.missionId) {
      where.push('mission_id = ?');
      params.push(q.missionId);
    }
    if (q.kind) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${Math.min(q.limit ?? 50, 500)}`,
        )
        .all(...params) as Row[]
    ).map((r) => ({
      id: String(r.id),
      missionId: str(r.mission_id),
      taskId: str(r.task_id),
      kind: String(r.kind),
      path: String(r.path),
      mime: str(r.mime),
      size: r.size == null ? null : num(r.size),
      createdAt: String(r.created_at),
      description: str(r.description),
    }));
  }

  getArtifact(id: string): { path: string; mime: string | null } | null {
    const r = this.db.prepare('SELECT path, mime FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    return r ? { path: String(r.path), mime: str(r.mime) } : null;
  }

  // ---------------------------------------------------------------- memory

  addMemory(m: {
    kind: MemoryKind;
    content: string;
    origin: string;
    missionId?: string | null;
    confidence?: number | null;
    tags?: string[];
  }): MemoryEntry {
    const id = newId('mem');
    const now = nowIso();
    this.db
      .prepare(
        'INSERT INTO memory_entries (id, kind, content, origin, mission_id, confidence, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        m.kind,
        redact(m.content),
        m.origin,
        m.missionId ?? null,
        m.confidence ?? null,
        json(m.tags ?? []),
        now,
        now,
      );
    return this.getMemory(id)!;
  }

  getMemory(id: string): MemoryEntry | null {
    const r = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToMemory(r) : null;
  }

  updateMemory(
    id: string,
    patch: { content?: string; confidence?: number | null; tags?: string[]; kind?: MemoryKind },
  ): MemoryEntry {
    const cur = this.getMemory(id);
    if (!cur) throw new HermesError('NOT_FOUND', `Souvenir introuvable : ${id}`);
    this.db
      .prepare(
        'UPDATE memory_entries SET content = ?, confidence = ?, tags_json = ?, kind = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        redact(patch.content ?? cur.content),
        patch.confidence === undefined ? cur.confidence : patch.confidence,
        json(patch.tags ?? cur.tags),
        patch.kind ?? cur.kind,
        nowIso(),
        id,
      );
    return this.getMemory(id)!;
  }

  deleteMemory(ids: string[]): number {
    let n = 0;
    for (const id of ids)
      n += Number(this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id).changes);
    return n;
  }

  /**
   * Keyword search ranked by BM25 (SQLite FTS5, accents folded, prefix match on each word).
   * Lower bm25 = better. Returns nothing for a query without usable words.
   */
  searchMemoryKeyword(
    text: string,
    q: { kind?: MemoryKind; limit?: number } = {},
  ): { entry: MemoryEntry; bm25: number }[] {
    const match = ftsQuery(text);
    if (!match) return [];
    const params: SQLInputValue[] = [match];
    let kindSql = '';
    if (q.kind) {
      kindSql = 'AND m.kind = ?';
      params.push(q.kind);
    }
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts JOIN memory_entries m ON m.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ? ${kindSql} ORDER BY rank LIMIT ${Math.min(q.limit ?? 50, 500)}`,
      )
      .all(...params) as Row[];
    return rows.map((r) => ({ entry: rowToMemory(r), bm25: Number(r.rank) }));
  }

  /** Memory search used by the orchestrator: BM25 relevance when a text is given, else most recent. */
  searchMemory(q: { text?: string; kind?: MemoryKind; limit?: number } = {}): MemoryEntry[] {
    if (q.text) {
      const hits = this.searchMemoryKeyword(q.text, q);
      if (hits.length || ftsQuery(q.text)) return hits.map((h) => h.entry);
    }
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.kind) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM memory_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ${Math.min(q.limit ?? 50, 500)}`,
        )
        .all(...params) as Row[]
    ).map(rowToMemory);
  }

  /** Stored vectors computed by `model` (other models' vectors are not comparable). */
  memoryVectors(model: string, kind?: MemoryKind): { id: string; vector: Float32Array }[] {
    const rows = this.db
      .prepare(
        `SELECT id, embedding FROM memory_entries WHERE embedding IS NOT NULL AND embedding_model = ? ${kind ? 'AND kind = ?' : ''}`,
      )
      .all(...(kind ? [model, kind] : [model])) as Row[];
    return rows.map((r) => {
      const b = r.embedding as Uint8Array;
      return {
        id: String(r.id),
        vector: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
      };
    });
  }

  /** Entries without a vector for `model` (new, edited, or embedded by another model). */
  pendingMemoryEmbeddings(model: string, limit = 64): { id: string; content: string }[] {
    return (
      this.db
        .prepare(
          'SELECT id, content FROM memory_entries WHERE embedding IS NULL OR embedding_model IS NOT ? ORDER BY updated_at DESC LIMIT ?',
        )
        .all(model, limit) as Row[]
    ).map((r) => ({ id: String(r.id), content: String(r.content) }));
  }

  setMemoryEmbedding(id: string, vector: Float32Array, model: string): void {
    this.db
      .prepare('UPDATE memory_entries SET embedding = ?, embedding_model = ? WHERE id = ?')
      .run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id);
  }

  memoryIndexCounts(model: string): { total: number; embedded: number } {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS total, SUM(CASE WHEN embedding IS NOT NULL AND embedding_model = ? THEN 1 ELSE 0 END) AS embedded FROM memory_entries',
      )
      .get(model) as Row;
    return { total: Number(r.total), embedded: Number(r.embedded ?? 0) };
  }

  // ---------------------------------------------------------------- settings (non-secret)

  getSetting<T>(table: 'app_settings' | 'provider_settings', key: string, fallback: T): T {
    const r = this.db.prepare(`SELECT value_json FROM ${table} WHERE key = ?`).get(key) as Row | undefined;
    return r ? parse<T>(r.value_json, fallback) : fallback;
  }

  setSetting(table: 'app_settings' | 'provider_settings', key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, json(value), nowIso());
  }

  getModelAssignments(): { role: string; modelId: string; fallbacks: string[] }[] {
    return (this.db.prepare('SELECT * FROM model_assignments').all() as Row[]).map((r) => ({
      role: String(r.role),
      modelId: String(r.model_id),
      fallbacks: parse<string[]>(r.fallbacks_json, []),
    }));
  }

  setModelAssignment(role: string, modelId: string, fallbacks: string[]): void {
    this.db
      .prepare(
        `INSERT INTO model_assignments (role, model_id, fallbacks_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET model_id = excluded.model_id, fallbacks_json = excluded.fallbacks_json, updated_at = excluded.updated_at`,
      )
      .run(role, modelId, json(fallbacks), nowIso());
  }

  // ------------------------------------------------------------------ scheduled triggers

  createTrigger(t: TriggerInput & { nextRunAt: string | null }): ScheduledTrigger {
    const id = newId('trg');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO scheduled_triggers (id, name, kind, spec_json, mission_template, budget_json, enabled, auto_start, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.name,
        t.spec.kind,
        json(t.spec),
        t.missionTemplate,
        json(t.budget),
        t.enabled ? 1 : 0,
        t.autoStart ? 1 : 0,
        t.nextRunAt,
        now,
        now,
      );
    return this.requireTrigger(id);
  }

  getTrigger(id: string): ScheduledTrigger | null {
    const r = this.db.prepare('SELECT * FROM scheduled_triggers WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToTrigger(r) : null;
  }

  requireTrigger(id: string): ScheduledTrigger {
    const t = this.getTrigger(id);
    if (!t) throw new HermesError('NOT_FOUND', `Déclencheur introuvable : ${id}`);
    return t;
  }

  listTriggers(): ScheduledTrigger[] {
    return (this.db.prepare('SELECT * FROM scheduled_triggers ORDER BY created_at').all() as Row[]).map(
      rowToTrigger,
    );
  }

  updateTrigger(
    id: string,
    p: Partial<TriggerInput> & {
      nextRunAt?: string | null;
      lastRunAt?: string;
      lastMissionId?: string | null;
      lastError?: string | null;
      incrementRuns?: boolean;
    },
  ): ScheduledTrigger {
    const cur = this.requireTrigger(id);
    const spec = p.spec ?? cur.spec;
    this.db
      .prepare(
        `UPDATE scheduled_triggers SET name = ?, kind = ?, spec_json = ?, mission_template = ?, budget_json = ?, enabled = ?, auto_start = ?,
         next_run_at = ?, last_run_at = ?, last_mission_id = ?, last_error = ?, run_count = run_count + ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        p.name ?? cur.name,
        spec.kind,
        json(spec),
        p.missionTemplate ?? cur.missionTemplate,
        json(p.budget ?? cur.budget),
        (p.enabled ?? cur.enabled) ? 1 : 0,
        (p.autoStart ?? cur.autoStart) ? 1 : 0,
        p.nextRunAt === undefined ? cur.nextRunAt : p.nextRunAt,
        p.lastRunAt ?? cur.lastRunAt,
        p.lastMissionId === undefined ? cur.lastMissionId : p.lastMissionId,
        p.lastError === undefined ? cur.lastError : p.lastError === null ? null : redact(p.lastError),
        p.incrementRuns ? 1 : 0,
        nowIso(),
        id,
      );
    return this.requireTrigger(id);
  }

  deleteTrigger(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM scheduled_triggers WHERE id = ?').run(id).changes) > 0;
  }

  addTriggerRun(r: {
    triggerId: string;
    reason: string;
    status: TriggerRunStatus;
    firedAt?: string;
    missionId?: string | null;
    error?: string | null;
    sourceMissionId?: string | null;
    attempt?: number;
    request?: string | null;
  }): TriggerRun {
    const id = newId('run');
    this.db
      .prepare(
        `INSERT INTO trigger_runs (id, trigger_id, mission_id, fired_at, reason, status, error, source_mission_id, attempt, request)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.triggerId,
        r.missionId ?? null,
        r.firedAt ?? nowIso(),
        redact(r.reason).slice(0, 2000),
        r.status,
        r.error ? redact(r.error).slice(0, 2000) : null,
        r.sourceMissionId ?? null,
        r.attempt ?? 0,
        r.request ? redact(r.request) : null,
      );
    return this.getTriggerRun(id)!;
  }

  getTriggerRun(id: string): TriggerRun | null {
    const r = this.db.prepare('SELECT * FROM trigger_runs WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToTriggerRun(r) : null;
  }

  updateTriggerRun(
    id: string,
    p: {
      status?: TriggerRunStatus;
      missionId?: string | null;
      error?: string | null;
      firedAt?: string;
      request?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE trigger_runs SET status = COALESCE(?, status), mission_id = COALESCE(?, mission_id),
         error = COALESCE(?, error), fired_at = COALESCE(?, fired_at), request = COALESCE(?, request) WHERE id = ?`,
      )
      .run(
        p.status ?? null,
        p.missionId ?? null,
        p.error ? redact(p.error).slice(0, 2000) : null,
        p.firedAt ?? null,
        p.request ? redact(p.request) : null,
        id,
      );
  }

  listTriggerRuns(q: { triggerId?: string; status?: TriggerRunStatus[]; limit?: number } = {}): TriggerRun[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.triggerId) {
      where.push('trigger_id = ?');
      params.push(q.triggerId);
    }
    if (q.status?.length) {
      where.push(`status IN (${q.status.map(() => '?').join(',')})`);
      params.push(...q.status);
    }
    const sql = `SELECT * FROM trigger_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY fired_at DESC LIMIT ${Math.min(q.limit ?? 100, 1000)}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToTriggerRun);
  }

  triggerRunForMission(missionId: string): TriggerRun | null {
    const r = this.db.prepare('SELECT * FROM trigger_runs WHERE mission_id = ? LIMIT 1').get(missionId) as
      Row | undefined;
    return r ? rowToTriggerRun(r) : null;
  }

  /** Runs that created a mission since `sinceIso` (for the daily cap). */
  countLaunchedRunsSince(sinceIso: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM trigger_runs WHERE mission_id IS NOT NULL AND fired_at >= ?`)
      .get(sinceIso) as Row;
    return num(r.n);
  }

  /** Missions that reached `status` after `sinceIso`, oldest first. */
  missionsEndedSince(sinceIso: string, status: MissionStatus, limit = 50): Mission[] {
    return (
      this.db
        .prepare(`SELECT * FROM missions WHERE status = ? AND ended_at > ? ORDER BY ended_at LIMIT ?`)
        .all(status, sinceIso, limit) as Row[]
    ).map(rowToMission);
  }
}

function rowToTrigger(r: Row): ScheduledTrigger {
  return {
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind) as TriggerKind,
    spec: parse<TriggerSpec>(r.spec_json, { kind: 'interval', minutes: 60 }),
    missionTemplate: String(r.mission_template),
    budget: parse<TriggerBudget>(r.budget_json, {}) ?? {},
    enabled: num(r.enabled) === 1,
    autoStart: num(r.auto_start) === 1,
    nextRunAt: str(r.next_run_at),
    lastRunAt: str(r.last_run_at),
    lastMissionId: str(r.last_mission_id),
    lastError: str(r.last_error),
    runCount: num(r.run_count),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToTriggerRun(r: Row): TriggerRun {
  return {
    id: String(r.id),
    triggerId: String(r.trigger_id),
    missionId: str(r.mission_id),
    firedAt: String(r.fired_at),
    reason: String(r.reason),
    status: String(r.status) as TriggerRunStatus,
    error: str(r.error),
    sourceMissionId: str(r.source_mission_id),
    attempt: num(r.attempt),
    request: str(r.request),
  };
}

function rowToEvent(r: Row): MissionEvent {
  return {
    seq: num(r.seq),
    id: String(r.id),
    missionId: str(r.mission_id),
    taskId: str(r.task_id),
    agent: str(r.agent),
    toolId: str(r.tool_id),
    category: String(r.category) as EventCategory,
    level: String(r.level) as LogLevel,
    type: String(r.type),
    message: String(r.message),
    data: parse<unknown>(r.data_json, null),
    errorCode: str(r.error_code),
    createdAt: String(r.created_at),
  };
}

function rowToMission(r: Row): Mission {
  return {
    id: String(r.id),
    request: String(r.request),
    status: String(r.status) as MissionStatus,
    plan: parse<Plan | null>(r.plan_json, null),
    result: parse<MissionResult | null>(r.result_json, null),
    budget: MissionBudget.parse(parse(r.budget_json, {})),
    usage: MissionUsage.parse(parse(r.usage_json, {})),
    error: str(r.error),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    startedAt: str(r.started_at),
    endedAt: str(r.ended_at),
  };
}

function rowToTask(r: Row, dependsOn: string[]): Task {
  return {
    id: String(r.id),
    missionId: String(r.mission_id),
    stepId: String(r.step_id),
    agent: String(r.agent) as ExecutorAgentId,
    objective: String(r.objective),
    spec: parse<PlanStep>(r.spec_json, {} as PlanStep),
    status: String(r.status) as TaskStatus,
    attempts: num(r.attempts),
    maxAttempts: num(r.max_attempts),
    result: parse<TaskResult | null>(r.result_json, null),
    error: str(r.error),
    blockReason: str(r.block_reason),
    dependsOn,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    startedAt: str(r.started_at),
    endedAt: str(r.ended_at),
  };
}

function rowToToolCall(r: Row): ToolCallRecord {
  return {
    id: String(r.id),
    missionId: String(r.mission_id),
    taskId: str(r.task_id),
    agent: String(r.agent),
    toolId: String(r.tool_id),
    input: parse<unknown>(r.input_json, null),
    inputHash: String(r.input_hash),
    idempotencyKey: str(r.idempotency_key),
    status: String(r.status) as ToolCallStatus,
    output: parse<unknown>(r.output_json, null),
    error: str(r.error),
    verified: r.verified == null ? null : num(r.verified) === 1,
    policyDecision: str(r.policy_decision),
    approvalId: str(r.approval_id),
    startedAt: String(r.started_at),
    endedAt: str(r.ended_at),
    durationMs: r.duration_ms == null ? null : num(r.duration_ms),
  };
}

function rowToApproval(r: Row): Approval {
  return {
    id: String(r.id),
    missionId: String(r.mission_id),
    taskId: str(r.task_id),
    toolId: String(r.tool_id),
    inputHash: String(r.input_hash),
    input: parse<unknown>(r.input_json, null),
    description: String(r.description),
    consequences: String(r.consequences),
    status: String(r.status) as ApprovalStatus,
    createdAt: String(r.created_at),
    decidedAt: str(r.decided_at),
    consumedAt: str(r.consumed_at),
  };
}

function rowToMemory(r: Row): MemoryEntry {
  return {
    id: String(r.id),
    kind: String(r.kind) as MemoryKind,
    content: String(r.content),
    origin: String(r.origin),
    missionId: str(r.mission_id),
    confidence: r.confidence == null ? null : num(r.confidence),
    tags: parse<string[]>(r.tags_json, []),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

const FTS_STOPWORDS = new Set(
  'le la les un une des du de d l et ou en au aux a à dans sur pour par avec sans ce cet cette ces qui que quoi est sont the of and to in for on with is are'.split(
    ' ',
  ),
);

/** Turns free text into a safe FTS5 query: quoted words with prefix match, joined by OR. */
export function ftsQuery(text: string): string | null {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2 && !FTS_STOPWORDS.has(w)),
    ),
  ].slice(0, 16);
  return words.length ? words.map((w) => `"${w}"*`).join(' OR ') : null;
}

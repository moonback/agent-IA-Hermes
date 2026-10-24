import { z } from 'zod';
import type { AgentId, Approval, ExecutorAgentId } from '../shared/contracts';
import { HermesError, errorCode, errorMessage } from '../shared/errors';
import { evaluatePolicy } from '../policy-engine/policy';
import { hashInput, sha256 } from '../shared/util';
import type { ApprovalBroker } from './approvals';
import type { AnyTool, Availability, ToolContext, ToolServices } from './types';

export interface ExecuteRequest {
  toolId: string;
  input: unknown;
  missionId: string;
  taskId: string | null;
  agent: AgentId;
  /** Tools the plan step declared; anything else is refused. null = mission-level call. */
  stepTools: readonly string[] | null;
  signal: AbortSignal;
  /** Throws to refuse the call (budget). */
  beforeExecute?: () => void;
  onApprovalWait?: (approval: Approval) => void;
  onApprovalResolved?: (approval: Approval, decision: 'approved' | 'denied') => void;
}

export interface ToolOutcome {
  ok: boolean;
  toolId: string;
  toolCallId: string | null;
  output?: unknown;
  error?: { code: string; message: string };
  verified: boolean | null;
  verificationDetail?: string;
  deduplicated?: boolean;
}

const MAX_IDENTICAL_CALLS_PER_TASK = 3;

/**
 * The only path from a model's tool call to a real side effect: unknown tool → refused,
 * schema validation, policy, human approval bound to the exact input, duplicate protection,
 * timeout, output validation, post-condition verification and audit.
 */
export class ToolExecutor {
  private halted = false;
  private readonly identicalCalls = new Map<string, number>();
  private readonly availabilityCache = new Map<string, { at: number; value: Availability }>();

  constructor(
    private readonly tools: ReadonlyMap<string, AnyTool>,
    private readonly services: ToolServices,
    private readonly approvals: ApprovalBroker,
  ) {}

  get isHalted(): boolean {
    return this.halted;
  }

  halt(): void {
    this.halted = true;
  }

  resume(): void {
    this.halted = false;
  }

  async availability(tool: AnyTool): Promise<Availability> {
    const cached = this.availabilityCache.get(tool.id);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    let value: Availability;
    try {
      value = await tool.availability(this.services);
    } catch (err) {
      value = { available: false, reason: errorMessage(err) };
    }
    this.availabilityCache.set(tool.id, { at: Date.now(), value });
    return value;
  }

  invalidateAvailability(): void {
    this.availabilityCache.clear();
  }

  async execute(req: ExecuteRequest): Promise<ToolOutcome> {
    const { store, telemetry } = this.services;
    const tool = this.tools.get(req.toolId);
    const base = { missionId: req.missionId, taskId: req.taskId, agent: req.agent, toolId: req.toolId };
    const reject = (code: string, message: string, inputHash: string, decision: string): ToolOutcome => {
      const id = store.recordRejectedToolCall({
        ...base,
        input: req.input,
        inputHash,
        decision,
        error: message,
      });
      telemetry.record({
        ...base,
        category: 'security',
        level: 'warn',
        type: 'tool.rejected',
        message,
        errorCode: code,
        data: { toolCallId: id },
      });
      return { ok: false, toolId: req.toolId, toolCallId: id, error: { code, message }, verified: null };
    };

    if (!tool)
      return reject(
        'UNKNOWN_TOOL',
        `Outil inconnu refusé : ${req.toolId}`,
        sha256(String(req.toolId)),
        'deny',
      );

    const parsed = tool.inputSchema.safeParse(req.input);
    if (!parsed.success) {
      return reject(
        'VALIDATION',
        `Arguments invalides pour ${tool.id} : ${z.prettifyError(parsed.error)}`,
        hashInput(tool.id, req.input),
        'invalid',
      );
    }
    const input = parsed.data;
    const inputHash = hashInput(tool.id, input);

    try {
      req.beforeExecute?.();
    } catch (err) {
      return reject(errorCode(err), errorMessage(err), inputHash, 'budget');
    }

    if (req.taskId) {
      const loopKey = `${req.taskId}|${inputHash}`;
      const n = (this.identicalCalls.get(loopKey) ?? 0) + 1;
      this.identicalCalls.set(loopKey, n);
      if (n > MAX_IDENTICAL_CALLS_PER_TASK) {
        return reject(
          'LOOP_DETECTED',
          `Boucle détectée : ${tool.id} appelé ${n} fois avec les mêmes arguments`,
          inputHash,
          'loop',
        );
      }
    }

    const ctx: ToolContext = {
      missionId: req.missionId,
      taskId: req.taskId,
      agent: req.agent,
      signal: req.signal,
      services: this.services,
    };

    // Duplicate protection for non-idempotent tools: same mission/task/tool/input = same action.
    const idempotencyKey = tool.idempotent
      ? null
      : sha256(`${req.missionId}|${req.taskId ?? ''}|${inputHash}`);
    if (idempotencyKey) {
      const prior = store.findToolCallsByIdempotencyKey(idempotencyKey);
      const done = prior.find((c) => c.status === 'succeeded');
      if (done) {
        const dedupId = store.recordDeduplicatedToolCall(done, req.taskId);
        telemetry.record({
          ...base,
          category: 'tools',
          type: 'tool.deduplicated',
          message: `${tool.id} déjà exécuté (${done.id}) : action non répétée, résultat précédent réutilisé`,
          data: { toolCallId: dedupId, original: done.id },
        });
        return {
          ok: true,
          toolId: tool.id,
          toolCallId: dedupId,
          output: done.output,
          verified: done.verified,
          deduplicated: true,
        };
      }
      if (prior.some((c) => c.status === 'started')) {
        return reject(
          'UNCERTAIN_EFFECT',
          `Une exécution précédente de ${tool.id} avec ces arguments n'a pas confirmé son résultat ; confirmation humaine requise avant de réessayer`,
          inputHash,
          'uncertain',
        );
      }
    }

    let resources;
    let toolApprovalReason: string | null;
    try {
      resources = tool.resources(input, ctx);
      toolApprovalReason = await tool.approvalReason(input, ctx);
    } catch (err) {
      return reject(errorCode(err), errorMessage(err), inputHash, 'deny');
    }
    const availability = await this.availability(tool);
    const decision = evaluatePolicy(this.services.getPolicy(), {
      toolId: tool.id,
      toolKnown: true,
      toolAvailable: availability.available,
      allowedAgents: tool.allowedAgents,
      agent: req.agent as ExecutorAgentId | 'orchestrator',
      risk: tool.risk,
      toolApprovalReason,
      resources,
      stepTools: req.stepTools,
      halted: this.halted,
    });
    telemetry.record({
      ...base,
      category: 'security',
      level: decision.effect === 'deny' ? 'warn' : 'info',
      type: `policy.${decision.effect}`,
      message: decision.reasons.join(' ; '),
      data: { inputHash },
    });
    if (decision.effect === 'deny') {
      const reason =
        !availability.available && availability.reason
          ? `${decision.reasons.join(' ; ')} (${availability.reason})`
          : decision.reasons.join(' ; ');
      return reject('POLICY_DENIED', reason, inputHash, 'deny');
    }

    let approvalId: string | null = null;
    if (decision.effect === 'approval') {
      const desc = tool.describe(input);
      const approval = store.createApproval({
        missionId: req.missionId,
        taskId: req.taskId,
        toolId: tool.id,
        inputHash,
        input,
        description: desc.description,
        consequences: `${desc.consequences} Motif : ${decision.reasons.join(' ; ')}`,
      });
      telemetry.record({
        ...base,
        category: 'security',
        type: 'approval.requested',
        message: desc.description,
        data: { approvalId: approval.id, reasons: decision.reasons },
      });
      req.onApprovalWait?.(approval);
      let result: 'approved' | 'denied';
      try {
        result = await this.approvals.wait(approval, req.signal);
      } catch (err) {
        store.expirePendingApprovals(req.missionId);
        return reject(errorCode(err), errorMessage(err), inputHash, 'approval_cancelled');
      }
      req.onApprovalResolved?.(approval, result);
      if (result === 'denied')
        return reject(
          'APPROVAL_DENIED',
          `Action refusée par l'utilisateur : ${desc.description}`,
          inputHash,
          'approval_denied',
        );
      if (this.halted) return reject('EMERGENCY_STOP', "Arrêt d'urgence actif", inputHash, 'deny');
      try {
        store.consumeApproval(approval.id, tool.id, inputHash);
      } catch (err) {
        return reject(errorCode(err), errorMessage(err), inputHash, 'approval_mismatch');
      }
      approvalId = approval.id;
    }

    const toolCallId = store.startToolCall({
      ...base,
      input,
      inputHash,
      idempotencyKey,
      policyDecision: decision.effect,
      approvalId,
    });
    telemetry.record({
      ...base,
      category: categoryOf(tool.id),
      type: 'tool.started',
      message: `${tool.id} démarré`,
      data: { toolCallId },
    });
    const started = Date.now();
    const timeout = AbortSignal.timeout(tool.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);
    try {
      const raw = await raceAbort(tool.run(input, { ...ctx, signal }), signal, () =>
        timeout.aborted
          ? new HermesError('TOOL_TIMEOUT', `${tool.id} a dépassé ${tool.timeoutMs} ms`)
          : new HermesError('CANCELLED', `${tool.id} annulé`),
      );
      const out = tool.outputSchema.safeParse(raw);
      if (!out.success)
        throw new HermesError('TOOL_FAILED', `Sortie invalide de ${tool.id} : ${z.prettifyError(out.error)}`);
      let verification = null;
      try {
        verification = await tool.verify(input, out.data, ctx);
      } catch (err) {
        verification = { verified: false, detail: `Vérification impossible : ${errorMessage(err)}` };
      }
      const durationMs = Date.now() - started;
      store.finishToolCall(toolCallId, {
        status: 'succeeded',
        output: out.data,
        verified: verification?.verified ?? null,
        durationMs,
      });
      telemetry.record({
        ...base,
        category: categoryOf(tool.id),
        level: verification && !verification.verified ? 'warn' : 'info',
        type: 'tool.succeeded',
        message: `${tool.id} terminé en ${durationMs} ms${verification ? ` — ${verification.detail}` : ''}`,
        data: { toolCallId, durationMs, verified: verification?.verified ?? null },
      });
      return {
        ok: true,
        toolId: tool.id,
        toolCallId,
        output: out.data,
        verified: verification?.verified ?? null,
        verificationDetail: verification?.detail,
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      const code = errorCode(err);
      // A cancelled or timed-out side effect may or may not have happened: keep it "started" (uncertain)
      // for non-idempotent tools so a retry requires confirmation instead of blindly repeating it.
      const uncertain = !tool.idempotent && (code === 'TOOL_TIMEOUT' || code === 'CANCELLED');
      if (!uncertain)
        store.finishToolCall(toolCallId, { status: 'failed', error: errorMessage(err), durationMs });
      telemetry.record({
        ...base,
        category: categoryOf(tool.id),
        level: 'error',
        type: 'tool.failed',
        message: `${tool.id} : ${errorMessage(err)}`,
        errorCode: code,
        data: { toolCallId, durationMs, uncertain },
      });
      return {
        ok: false,
        toolId: tool.id,
        toolCallId,
        error: { code, message: errorMessage(err) },
        verified: null,
      };
    }
  }
}

function categoryOf(toolId: string) {
  if (toolId.startsWith('browser.')) return 'browser' as const;
  if (toolId.startsWith('desktop.') || toolId.startsWith('screen.')) return 'desktop' as const;
  return 'tools' as const;
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal, makeError: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(makeError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(makeError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

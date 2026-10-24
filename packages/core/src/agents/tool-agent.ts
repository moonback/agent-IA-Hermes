import { z } from 'zod';
import type { Approval, Evidence, ExecutorAgentId, MemoryEntry, Task, TaskResult } from '../shared/contracts';
import { HermesError } from '../shared/errors';
import { truncateDeep } from '../shared/redact';
import { clockContext, nowIso } from '../shared/util';
import type { ChatMessage, ChatToolSpec } from '../model-providers/types';
import type { ToolExecutor } from '../tools/executor';
import { fromFunctionName, toChatToolSpec } from '../tools/registry';
import type { AnyTool } from '../tools/types';
import { AGENTS, type AgentDescriptor } from './definitions';
import type { BudgetTracker, LlmGateway } from './llm-gateway';
import { IMPLICIT_TOOLS } from './plan-validation';

export interface DependencyResult {
  stepId: string;
  summary: string;
  outputs: Record<string, unknown>;
}

export interface AgentRunContext {
  missionId: string;
  task: Task;
  attempt: number;
  signal: AbortSignal;
  budget: BudgetTracker;
  dependencies: DependencyResult[];
  memory: MemoryEntry[];
  /** Verifier feedback from the previous attempt, if any. */
  feedback: string | null;
  isPauseRequested: () => boolean;
  onApprovalWait: (a: Approval) => void;
  onApprovalResolved: (a: Approval, d: 'approved' | 'denied') => void;
}

/** Common interface of executing agents. */
export interface Agent {
  readonly descriptor: AgentDescriptor;
  execute(ctx: AgentRunContext): Promise<TaskResult & { model: string | null }>;
}

const COMPLETE = 'task__complete';
const CompleteArgs = z.object({
  summary: z.string().min(1).max(8000),
  outputs: z.record(z.string(), z.unknown()).default({}),
  notDone: z.array(z.string()).default([]),
});
const COMPLETE_SPEC: ChatToolSpec = {
  type: 'function',
  function: {
    name: COMPLETE,
    description:
      "Termine la tâche. summary : ce qui a réellement été fait (avec preuves) ; outputs : données structurées utiles aux étapes suivantes ; notDone : ce qui n'a pas pu être fait.",
    parameters: z.toJSONSchema(CompleteArgs, { io: 'input' }) as Record<string, unknown>,
  },
};

/**
 * Generic executing agent: a bounded observe-think-act loop where every action goes through
 * the ToolExecutor. Specialised agents differ by their prompt, their tools and their limits.
 */
export class ToolLoopAgent implements Agent {
  readonly descriptor: AgentDescriptor;

  constructor(
    id: ExecutorAgentId,
    private readonly llm: LlmGateway,
    private readonly executor: ToolExecutor,
    private readonly tools: ReadonlyMap<string, AnyTool>,
  ) {
    this.descriptor = AGENTS[id];
  }

  async execute(ctx: AgentRunContext): Promise<TaskResult & { model: string | null }> {
    const { task } = ctx;
    const agentId = task.agent;
    const startedAt = nowIso();
    const stepTools = [...task.spec.tools, ...IMPLICIT_TOOLS].filter((t, i, a) => a.indexOf(t) === i);
    const usable = stepTools.flatMap((id) => {
      const t = this.tools.get(id);
      return t && t.allowedAgents.includes(agentId) ? [t] : [];
    });
    const specs = [...usable.map(toChatToolSpec), COMPLETE_SPEC];
    const evidence: Evidence[] = [];
    const errors: { code: string; message: string }[] = [];
    const warnings: string[] = [];
    let aiCalls = 0;
    let toolCalls = 0;
    let model: string | null = null;

    const brief = {
      contexte: clockContext(),
      objectif: task.objective,
      entrees: task.spec.inputs,
      criteresDeReussite: task.spec.successCriteria,
      strategieDeRecuperation: task.spec.recovery ?? null,
      resultatsDesEtapesPrecedentes: ctx.dependencies,
      tentative: ctx.attempt,
      retourDuVerificateur: ctx.feedback,
      memoire: ctx.memory.map((m) => ({
        type: m.kind,
        date: m.updatedAt.slice(0, 10),
        contenu: m.content.slice(0, 300),
      })),
    };
    const messages: ChatMessage[] = [
      { role: 'system', content: this.descriptor.systemPrompt },
      { role: 'user', content: `Tâche à exécuter (JSON) :\n${JSON.stringify(brief, null, 2)}` },
    ];

    const finish = (
      status: TaskResult['status'],
      summary: string,
      outputs: Record<string, unknown> = {},
    ) => ({
      taskId: task.id,
      status,
      summary,
      outputs,
      evidence,
      errors,
      warnings,
      approvalRequests: [],
      metadata: {
        agent: agentId,
        attempt: ctx.attempt,
        model: model ?? undefined,
        startedAt,
        endedAt: nowIso(),
        aiCalls,
        toolCalls,
      },
      model,
    });

    for (let iter = 0; iter < this.descriptor.limits.maxIterations; iter++) {
      if (ctx.signal.aborted) throw new HermesError('CANCELLED', 'Tâche annulée');
      if (ctx.isPauseRequested()) throw new HermesError('PAUSED', 'Pause demandée');
      const res = await this.llm.chat({
        missionId: ctx.missionId,
        taskId: task.id,
        agent: agentId,
        role: this.descriptor.modelRole,
        messages,
        tools: specs,
        budget: ctx.budget,
        signal: ctx.signal,
      });
      aiCalls++;
      model = res.model;
      if (res.incomplete) warnings.push('Réponse du modèle incomplète (limite de tokens ou flux interrompu)');
      messages.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: res.toolCalls.length ? res.toolCalls : undefined,
      });

      if (res.toolCalls.length === 0) {
        // No structured completion: keep the text, the verifier will judge it against real evidence.
        warnings.push("L'agent a répondu sans appeler task__complete");
        return finish('completed', res.content || '(réponse vide)');
      }

      for (const call of res.toolCalls) {
        if (call.function.name === COMPLETE) {
          const parsed = CompleteArgs.safeParse(safeJson(call.function.arguments));
          if (!parsed.success) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ ok: false, error: z.prettifyError(parsed.error) }),
            });
            continue;
          }
          for (const n of parsed.data.notDone) warnings.push(`Non réalisé : ${n}`);
          return finish('completed', parsed.data.summary, parsed.data.outputs);
        }
        if (toolCalls >= this.descriptor.limits.maxToolCallsPerTask) {
          throw new HermesError(
            'LOOP_DETECTED',
            `Limite de ${this.descriptor.limits.maxToolCallsPerTask} appels d'outils par tâche atteinte`,
          );
        }
        toolCalls++;
        const toolId = fromFunctionName(call.function.name);
        const args = safeJson(call.function.arguments);
        const outcome = await this.executor.execute({
          toolId,
          input: args === PARSE_ERROR ? { __invalidJson: call.function.arguments.slice(0, 200) } : args,
          missionId: ctx.missionId,
          taskId: task.id,
          agent: agentId,
          stepTools,
          signal: ctx.signal,
          beforeExecute: () => {
            ctx.budget.checkTool();
            ctx.budget.addTool();
          },
          onApprovalWait: ctx.onApprovalWait,
          onApprovalResolved: ctx.onApprovalResolved,
        });
        if (outcome.toolCallId) {
          evidence.push({
            kind: 'tool_call',
            ref: outcome.toolCallId,
            summary: outcome.ok
              ? `${toolId} réussi${outcome.verificationDetail ? ` : ${outcome.verificationDetail}` : ''}`
              : `${toolId} en échec : ${outcome.error?.message}`,
            verified: outcome.verified ?? undefined,
          });
        }
        if (!outcome.ok) {
          errors.push({
            code: outcome.error?.code ?? 'TOOL_FAILED',
            message: outcome.error?.message ?? 'échec',
          });
          if (outcome.error?.code === 'UNCERTAIN_EFFECT')
            throw new HermesError('UNCERTAIN_EFFECT', outcome.error.message);
          if (outcome.error?.code === 'BUDGET_EXCEEDED')
            throw new HermesError('BUDGET_EXCEEDED', outcome.error.message);
          if (outcome.error?.code === 'CANCELLED' && ctx.signal.aborted)
            throw new HermesError('CANCELLED', 'Tâche annulée');
        }
        const payload = outcome.ok
          ? {
              ok: true,
              verified: outcome.verified,
              deduplicated: outcome.deduplicated ?? false,
              data: truncateDeep(outcome.output, 6000),
            }
          : { ok: false, error: outcome.error };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `<donnees_outil source="${toolId}" fiabilite="non_fiable">\n${JSON.stringify(payload)}\n</donnees_outil>`,
        });
      }
    }
    throw new HermesError(
      'MAX_ITERATIONS',
      `${this.descriptor.name} : limite de ${this.descriptor.limits.maxIterations} itérations atteinte sans conclusion`,
    );
  }
}

const PARSE_ERROR = Symbol('parse-error');
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return PARSE_ERROR;
  }
}

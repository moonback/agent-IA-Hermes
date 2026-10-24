import { z } from 'zod';
import type { AgentId, MissionBudget, MissionUsage, ModelRole } from '../shared/contracts';
import { HermesError } from '../shared/errors';
import type { Telemetry } from '../observability/telemetry';
import { OPENROUTER_DEFAULT_BASE_URL } from '../model-providers/openrouter';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatToolSpec,
  ModelInfo,
  ModelProvider,
} from '../model-providers/types';

export const ProviderSettings = z.object({
  baseUrl: z.string().default(OPENROUTER_DEFAULT_BASE_URL),
  timeoutMs: z.number().int().min(5_000).max(600_000).default(90_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  temperature: z.number().min(0).max(2).default(0.2),
  maxOutputTokens: z.number().int().min(64).max(64_000).default(2_000),
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

export interface ModelAssignment {
  modelId: string;
  fallbacks: string[];
}

/** Per-mission limits: AI calls, tool calls, cost and wall-clock duration. */
export class BudgetTracker {
  constructor(
    readonly budget: MissionBudget,
    readonly usage: MissionUsage,
    private readonly startedAtMs: number,
    private readonly persist: (u: MissionUsage) => void,
  ) {}

  private checkTime(): void {
    const elapsed = (Date.now() - this.startedAtMs) / 1000;
    if (elapsed > this.budget.maxDurationSec)
      throw new HermesError(
        'BUDGET_EXCEEDED',
        `Durée maximale de mission dépassée (${this.budget.maxDurationSec} s)`,
      );
  }

  checkAi(): void {
    this.checkTime();
    if (this.usage.aiCalls >= this.budget.maxAiCalls)
      throw new HermesError(
        'BUDGET_EXCEEDED',
        `Nombre maximal d'appels IA atteint (${this.budget.maxAiCalls})`,
      );
    if (this.usage.costUsd >= this.budget.maxCostUsd)
      throw new HermesError(
        'BUDGET_EXCEEDED',
        `Budget de coût atteint (${this.usage.costUsd.toFixed(4)} / ${this.budget.maxCostUsd} USD)`,
      );
  }

  checkTool(): void {
    this.checkTime();
    if (this.usage.toolCalls >= this.budget.maxToolCalls)
      throw new HermesError(
        'BUDGET_EXCEEDED',
        `Nombre maximal d'appels d'outils atteint (${this.budget.maxToolCalls})`,
      );
  }

  addAi(res: Pick<ChatResponse, 'usage'>, costUsd: number | null): void {
    this.usage.aiCalls++;
    this.usage.promptTokens += res.usage.promptTokens;
    this.usage.completionTokens += res.usage.completionTokens;
    if (costUsd === null) this.usage.costKnown = false;
    else this.usage.costUsd += costUsd;
    this.persist(this.usage);
  }

  addTool(): void {
    this.usage.toolCalls++;
    this.persist(this.usage);
  }
}

export interface GatewayChat {
  missionId: string | null;
  taskId: string | null;
  agent: AgentId;
  role: ModelRole;
  messages: ChatMessage[];
  tools?: ChatToolSpec[];
  json?: boolean;
  maxTokens?: number;
  stream?: boolean;
  plugins?: ChatRequest['plugins'];
  budget: BudgetTracker | null;
  signal: AbortSignal;
}

/**
 * Agents never talk to the provider directly: the gateway picks the model of the agent's role,
 * checks documented capabilities, enforces budgets, computes cost and streams tokens to the UI.
 */
export class LlmGateway {
  constructor(
    private readonly deps: {
      /** Provider serving a role (OpenRouter or Gemini), chosen in the settings. */
      provider: (role: ModelRole) => ModelProvider;
      settings: () => ProviderSettings;
      assignment: (role: ModelRole) => ModelAssignment | null;
      catalog: () => ReadonlyMap<string, ModelInfo>;
      telemetry: Telemetry;
    },
  ) {}

  resolve(role: ModelRole): ModelAssignment {
    const a = this.deps.assignment(role) ?? this.deps.assignment('primary');
    if (!a?.modelId)
      throw new HermesError(
        'CONFIG',
        `Aucun modèle configuré pour le rôle « ${role} » ni de modèle principal`,
      );
    return a;
  }

  modelInfo(id: string): ModelInfo | undefined {
    return this.deps.catalog().get(id);
  }

  async chat(p: GatewayChat): Promise<ChatResponse> {
    if (p.role === 'voice')
      throw new HermesError(
        'CONFIG',
        'Le rôle « voice » est servi par une session Gemini Live, pas par une complétion',
      );
    p.budget?.checkAi();
    const assignment = this.resolve(p.role);
    const info = this.modelInfo(assignment.modelId);
    if (p.tools?.length && info && !info.supportsTools) {
      throw new HermesError(
        'CONFIG',
        `Le modèle ${assignment.modelId} ne déclare pas la prise en charge des appels d'outils ; choisissez-en un autre pour le rôle « ${p.role} »`,
      );
    }
    const s = this.deps.settings();
    const supports = (param: string) =>
      !info || info.supportedParameters.length === 0 || info.supportedParameters.includes(param);
    const req: ChatRequest = {
      model: assignment.modelId,
      fallbackModels: assignment.fallbacks,
      messages: p.messages,
      tools: p.tools,
      maxTokens: p.maxTokens ?? s.maxOutputTokens,
      temperature: supports('temperature') ? s.temperature : undefined,
      jsonMode: Boolean(p.json && info?.supportsStructuredOutputs),
      plugins: p.plugins,
    };
    const live = (type: string, data: unknown) =>
      this.deps.telemetry.live({ type, missionId: p.missionId, taskId: p.taskId, agent: p.agent, data });
    live('llm.start', { model: assignment.modelId });
    const res = await this.deps.provider(p.role).chat(req, {
      signal: p.signal,
      stream: p.stream ?? true,
      onDelta: (text) => live('llm.delta', { text }),
      onRetry: (reason) => live('llm.retry', { reason }),
    });
    const served = this.modelInfo(res.model) ?? info;
    const cost =
      res.usage.costUsd ??
      (served?.pricing.promptPerMTok != null && served.pricing.completionPerMTok != null
        ? (res.usage.promptTokens * served.pricing.promptPerMTok +
            res.usage.completionTokens * served.pricing.completionPerMTok) /
          1_000_000
        : null);
    p.budget?.addAi(res, cost);
    live('llm.end', { model: res.model, finishReason: res.finishReason });
    this.deps.telemetry.record({
      missionId: p.missionId,
      taskId: p.taskId,
      agent: p.agent,
      category: 'provider',
      level: res.incomplete ? 'warn' : 'info',
      type: 'llm.call',
      message: `${p.agent} → ${res.model} (${res.usage.promptTokens}+${res.usage.completionTokens} tokens${cost !== null ? `, ${cost.toFixed(5)} USD` : ', coût inconnu'})${res.incomplete ? ' — réponse incomplète' : ''}`,
      data: {
        model: res.model,
        usage: res.usage,
        costUsd: cost,
        latencyMs: res.latencyMs,
        attempts: res.attempts,
        finishReason: res.finishReason,
        incomplete: res.incomplete,
      },
    });
    return res;
  }
}

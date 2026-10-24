import { z } from 'zod';
import type { AgentId, ExecutorAgentId, RiskLevel } from '../shared/contracts';
import type { PolicyConfig, ResourceClaims } from '../policy-engine/policy';
import type { HermesStore } from '../persistence/store';
import type { Telemetry } from '../observability/telemetry';
import type { BrowserService } from './browser';
import type { DesktopAdapter } from './desktop';
import type { SearchProvider } from './web-search';

export interface Availability {
  available: boolean;
  reason?: string;
}

/** Services shared by tools. Each adapter is replaceable behind its interface. */
export interface ToolServices {
  store: HermesStore;
  telemetry: Telemetry;
  dataDir: string;
  getPolicy(): PolicyConfig;
  browser: BrowserService;
  desktop: DesktopAdapter;
  search: SearchProvider;
  missionControl: {
    pause(missionId: string, reason: string): void;
    cancel(missionId: string, reason: string): void;
    verifyTask(taskId: string, signal: AbortSignal): Promise<unknown>;
  };
}

export interface ToolContext {
  missionId: string;
  taskId: string | null;
  agent: AgentId;
  signal: AbortSignal;
  services: ToolServices;
}

export interface VerificationOutcome {
  verified: boolean;
  detail: string;
}

export interface ToolDefinition<I extends z.ZodType, O extends z.ZodType> {
  id: string;
  description: string;
  input: I;
  output: O;
  allowedAgents: readonly ExecutorAgentId[];
  permissions: readonly string[];
  risk: RiskLevel;
  timeoutMs: number;
  reversible: boolean;
  /** Non-idempotent tools are protected against duplicate execution (see ToolExecutor). */
  idempotent: boolean;
  verification: string;
  confirmation: string;
  availability(services: ToolServices): Promise<Availability>;
  resources(input: z.infer<I>, ctx: ToolContext): ResourceClaims;
  approvalReason?(input: z.infer<I>, ctx: ToolContext): string | null | Promise<string | null>;
  describe?(input: z.infer<I>): { description: string; consequences: string };
  run(input: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
  verify?(input: z.infer<I>, output: z.infer<O>, ctx: ToolContext): Promise<VerificationOutcome>;
}

/** Type-erased tool used by the registry; inputs are validated by the tool's own schemas first. */
export interface AnyTool {
  id: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  allowedAgents: readonly ExecutorAgentId[];
  permissions: readonly string[];
  risk: RiskLevel;
  timeoutMs: number;
  reversible: boolean;
  idempotent: boolean;
  verification: string;
  confirmation: string;
  availability(services: ToolServices): Promise<Availability>;
  resources(input: unknown, ctx: ToolContext): ResourceClaims;
  approvalReason(input: unknown, ctx: ToolContext): Promise<string | null>;
  describe(input: unknown): { description: string; consequences: string };
  run(input: unknown, ctx: ToolContext): Promise<unknown>;
  verify(input: unknown, output: unknown, ctx: ToolContext): Promise<VerificationOutcome | null>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): AnyTool {
  type In = z.infer<I>;
  type Out = z.infer<O>;
  return {
    id: def.id,
    description: def.description,
    inputSchema: def.input,
    outputSchema: def.output,
    allowedAgents: def.allowedAgents,
    permissions: def.permissions,
    risk: def.risk,
    timeoutMs: def.timeoutMs,
    reversible: def.reversible,
    idempotent: def.idempotent,
    verification: def.verification,
    confirmation: def.confirmation,
    availability: (s) => def.availability(s),
    resources: (input, ctx) => def.resources(input as In, ctx),
    approvalReason: async (input, ctx) =>
      def.approvalReason ? await def.approvalReason(input as In, ctx) : null,
    describe: (input) =>
      def.describe?.(input as In) ?? {
        description: `${def.id} : ${JSON.stringify(input).slice(0, 500)}`,
        consequences: def.reversible ? 'Action réversible.' : 'Action potentiellement irréversible.',
      },
    run: (input, ctx) => def.run(input as In, ctx),
    verify: async (input, output, ctx) => (def.verify ? def.verify(input as In, output as Out, ctx) : null),
  };
}

export const alwaysAvailable = async (): Promise<Availability> => ({ available: true });

/** Button/link labels that typically trigger an external, hard-to-reverse effect. Heuristic, not a guarantee. */
export const SENSITIVE_ACTION =
  /\b(envoyer|send|publier|publish|post(er)?|acheter|buy|purchase|payer|pay|commander|order|checkout|supprimer|delete|remove|effacer|confirmer|confirm|valider|submit|soumettre|transf[ée]rer|transfer|désinstaller|uninstall|formater|format)\b/i;

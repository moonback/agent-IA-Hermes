import { z } from 'zod';

export const TASK_STATUSES = [
  'pending',
  'ready',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'blocked',
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const MISSION_STATUSES = [
  'planning',
  'planned',
  'running',
  'paused',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
] as const;
export const MissionStatus = z.enum(MISSION_STATUSES);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const RiskLevel = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** Agents that can own a plan step. Planner, orchestrator and verifier never execute steps. */
export const EXECUTOR_AGENTS = [
  'computer',
  'files',
  'browser',
  'code',
  'research',
  'memory',
  'shell',
] as const;
export const ExecutorAgentId = z.enum(EXECUTOR_AGENTS);
export type ExecutorAgentId = z.infer<typeof ExecutorAgentId>;

export const AGENT_IDS = ['orchestrator', 'planner', 'verifier', 'voice', ...EXECUTOR_AGENTS] as const;
export const AgentId = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentId>;

export const MODEL_ROLES = ['primary', 'planning', 'execution', 'verification', 'voice'] as const;
export const ModelRole = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRole>;

export const PlanStep = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,32}$/i, 'identifiant alphanumérique court'),
    objective: z.string().min(3).max(2000),
    agent: ExecutorAgentId,
    inputs: z.record(z.string(), z.unknown()).default({}),
    dependsOn: z.array(z.string()).default([]),
    tools: z.array(z.string()).max(12).default([]),
    permissions: z.array(z.string()).default([]),
    risk: RiskLevel.default('low'),
    timeoutSec: z.number().int().min(5).max(1800).default(120),
    maxAttempts: z.number().int().min(1).max(3).default(2),
    successCriteria: z.array(z.string().min(3)).min(1).max(10),
    recovery: z.string().max(1000).optional(),
  })
  .strict();
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z
  .object({
    summary: z.string().min(3).max(2000),
    steps: z.array(PlanStep).min(1).max(20),
    successCriteria: z.array(z.string().min(3)).min(1).max(10),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

export const MissionBudget = z.object({
  maxAiCalls: z.number().int().min(1).max(500).default(40),
  maxCostUsd: z.number().min(0).max(100).default(1),
  maxDurationSec: z
    .number()
    .int()
    .min(10)
    .max(24 * 3600)
    .default(1800),
  maxToolCalls: z.number().int().min(1).max(1000).default(100),
  maxParallelTasks: z.number().int().min(1).max(4).default(2),
});
export type MissionBudget = z.infer<typeof MissionBudget>;

export const MissionUsage = z.object({
  aiCalls: z.number().default(0),
  toolCalls: z.number().default(0),
  promptTokens: z.number().default(0),
  completionTokens: z.number().default(0),
  costUsd: z.number().default(0),
  /** false as soon as one AI call returned no cost information. */
  costKnown: z.boolean().default(true),
});
export type MissionUsage = z.infer<typeof MissionUsage>;

export const Evidence = z.object({
  kind: z.enum(['tool_call', 'artifact', 'check']),
  ref: z.string(),
  summary: z.string(),
  verified: z.boolean().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const TaskResult = z.object({
  taskId: z.string(),
  status: TaskStatus,
  summary: z.string(),
  outputs: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(Evidence).default([]),
  errors: z.array(z.object({ code: z.string(), message: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
  approvalRequests: z.array(z.string()).default([]),
  metadata: z.object({
    agent: AgentId,
    attempt: z.number().int(),
    model: z.string().optional(),
    startedAt: z.string(),
    endedAt: z.string(),
    aiCalls: z.number().int(),
    toolCalls: z.number().int(),
  }),
});
export type TaskResult = z.infer<typeof TaskResult>;

export const Verdict = z
  .object({
    verdict: z.enum(['pass', 'partial', 'fail']),
    reasons: z.array(z.string()).min(1),
    unsupportedClaims: z.array(z.string()).default([]),
    correctionRequest: z.string().optional(),
  })
  .strict();
export type Verdict = z.infer<typeof Verdict>;

export const EVENT_CATEGORIES = [
  'application',
  'orchestration',
  'provider',
  'tools',
  'desktop',
  'browser',
  'security',
  'persistence',
  'voice',
  'scheduler',
] as const;
export const EventCategory = z.enum(EVENT_CATEGORIES);
export type EventCategory = z.infer<typeof EventCategory>;

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export interface MissionEvent {
  seq: number;
  id: string;
  missionId: string | null;
  taskId: string | null;
  agent: string | null;
  toolId: string | null;
  category: EventCategory;
  level: LogLevel;
  type: string;
  message: string;
  data: unknown;
  errorCode: string | null;
  createdAt: string;
}

export interface MissionResult {
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  verification: Verdict | null;
  tasks: { id: string; stepId: string; status: TaskStatus; verified: boolean }[];
}

export interface Mission {
  id: string;
  request: string;
  status: MissionStatus;
  plan: Plan | null;
  result: MissionResult | null;
  budget: MissionBudget;
  usage: MissionUsage;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Task {
  id: string;
  missionId: string;
  stepId: string;
  agent: ExecutorAgentId;
  objective: string;
  spec: PlanStep;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  result: TaskResult | null;
  error: string | null;
  blockReason: string | null;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'consumed', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export interface Approval {
  id: string;
  missionId: string;
  taskId: string | null;
  toolId: string;
  inputHash: string;
  input: unknown;
  description: string;
  consequences: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  consumedAt: string | null;
}

export const MemoryKind = z.enum(['mission_summary', 'preference', 'procedure', 'knowledge']);
export type MemoryKind = z.infer<typeof MemoryKind>;

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  origin: string;
  missionId: string | null;
  confidence: number | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type ToolCallStatus = 'started' | 'succeeded' | 'failed' | 'denied' | 'deduplicated' | 'abandoned';

export interface ToolCallRecord {
  id: string;
  missionId: string;
  taskId: string | null;
  agent: string;
  toolId: string;
  input: unknown;
  inputHash: string;
  idempotencyKey: string | null;
  status: ToolCallStatus;
  output: unknown;
  error: string | null;
  verified: boolean | null;
  policyDecision: string | null;
  approvalId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

/** Events sent to the desktop client (JSON text frames); audio travels as binary frames. */
export type VoiceServerEvent =
  | { type: 'ready'; model: string; voice: string | null; language: string | null }
  | { type: 'state'; state: 'connecting' | 'ready' | 'reconnecting' | 'closed'; detail?: string }
  | { type: 'transcript'; speaker: 'user' | 'agent'; text: string; final: boolean }
  | { type: 'tool'; name: string; ok: boolean; missionId?: string; message?: string }
  | {
      type: 'command';
      command: 'pause' | 'resume' | 'cancel' | 'emergency_stop' | 'report';
      ok: boolean;
      message: string;
      missionId?: string;
    }
  | { type: 'mission'; missionId: string }
  | { type: 'mission_update'; missionId: string; event: string; message: string }
  | { type: 'interrupted'; by: 'user' | 'server' }
  | { type: 'turn_end' }
  | { type: 'error'; code: string; message: string }
  | { type: 'closed'; reason: string };

export type {
  Approval,
  MemoryEntry,
  MemoryKind,
  Mission,
  MissionEvent,
  MissionStatus,
  Plan,
  PlanStep,
  Task,
  TaskStatus,
  ToolCallRecord,
  Verdict,
  MissionBudget,
} from '@hermes/core/contracts';

import type { Approval, Mission, Task, ToolCallRecord } from '@hermes/core/contracts';

export interface Availability {
  available: boolean;
  reason?: string;
}

export interface ConnectionTest {
  status:
    | 'config_missing'
    | 'auth_invalid'
    | 'network'
    | 'model_unavailable'
    | 'insufficient_credits'
    | 'rate_limited'
    | 'provider_error'
    | 'ok';
  ok: boolean;
  message: string;
  model: string | null;
  latencyMs: number | null;
  key: {
    label: string | null;
    usageUsd: number | null;
    limitUsd: number | null;
    limitRemainingUsd: number | null;
    isFreeTier: boolean | null;
  } | null;
  testedAt: string;
}

export interface ModelAssignment {
  modelId: string;
  fallbacks: string[];
}
export type Role = 'primary' | 'planning' | 'execution' | 'verification' | 'voice';
export type TextRole = Exclude<Role, 'voice'>;
export type RoleProviders = Record<TextRole, 'openrouter' | 'gemini'> & { voice: 'gemini-live' };
export type Assignments = Record<Role, ModelAssignment | null>;

export interface Status {
  version: string;
  uptimeSec: number;
  startupMs: number;
  halted: boolean;
  provider: {
    hasKey: boolean;
    source: string | null;
    lastTest: ConnectionTest | null;
    assignments: Assignments;
    roleProviders: RoleProviders;
    gemini: {
      hasKey: boolean;
      source: string | null;
      lastTest: ConnectionTest | null;
      liveTest: ConnectionTest | null;
    };
  };
  workers: { desktop: Availability; browser: Availability; search: Availability; activeLoops: number };
  unavailableTools: Record<string, string>;
  missions: { active: Mission[]; pendingApprovals: number };
  usage: { agentRuns: number; aiCalls: number; costUsd: number; outcomes: Record<string, number> };
  dataDir: string;
}

export interface MissionDetail {
  mission: Mission;
  tasks: Task[];
  toolCalls: ToolCallRecord[];
  approvals: Approval[];
  artifacts: Artifact[];
  active: boolean;
}

export interface Artifact {
  id: string;
  missionId: string | null;
  kind: string;
  path: string;
  mime: string | null;
  size: number | null;
  createdAt: string;
  description: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportsTools: boolean;
  supportsStructuredOutputs: boolean;
  supportsImages: boolean;
  pricing: { promptPerMTok: number | null; completionPerMTok: number | null };
}

export interface Catalog {
  models: ModelInfo[];
  fetchedAt: string | null;
  error: string | null;
}

export interface ProviderSettings {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
  maxOutputTokens: number;
}

export interface Policy {
  allowedRoots: string[];
  allowedDomains: string[];
  unknownDomains: 'deny' | 'ask';
  allowedCommands: string[];
  allowedApps: string[];
  disabledTools: string[];
  approvalRules: Record<string, 'always' | 'auto' | 'never'>;
}

export interface ToolInfo {
  id: string;
  description: string;
  allowedAgents: string[];
  permissions: string[];
  risk: 'low' | 'medium' | 'high';
  timeoutMs: number;
  reversible: boolean;
  idempotent: boolean;
  verification: string;
  confirmation: string;
  availability: Availability;
  enabled: boolean;
  approvalRule: 'always' | 'auto' | 'never';
  stats: { calls: number; failures: number; avgMs: number | null } | null;
}

export interface AgentInfo {
  id: string;
  activeTasks: number;
  activeMissionIds: string[];
  name: string;
  role: string;
  capabilities: string[];
  executes: boolean;
  limits: { maxIterations: number; maxToolCallsPerTask: number };
  modelRole: Role;
  model: ModelAssignment | null;
  tools: string[];
  stats: { runs: number; failures: number; lastError: string | null; lastRunAt: string | null } | null;
}

export interface LiveEvent {
  type: string;
  missionId?: string | null;
  taskId?: string | null;
  agent?: string | null;
  data?: unknown;
}

export interface GeminiSettings {
  backend: 'ai-studio' | 'vertex';
  baseUrl: string;
  vertexProject: string;
  vertexLocation: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface GeminiState {
  hasKey: boolean;
  source: string | null;
  settings: GeminiSettings;
  lastTest: ConnectionTest | null;
  liveTest: ConnectionTest | null;
}

export interface VoiceSettings {
  voiceName: string;
  languageCode: string;
  affectiveDialogue: boolean;
  mode: 'vad' | 'ptt';
  vadSensitivity: number;
}

export interface VoiceCatalog {
  voices: { name: string; style: string }[];
  languages: { code: string; label: string }[];
  defaultModel: string;
  model: string;
}

export type { VoiceServerEvent } from '@hermes/core/contracts';

// ------------------------------------------------------------------ proactive missions
export type TriggerSpec =
  | { kind: 'cron'; expression: string }
  | { kind: 'interval'; minutes: number }
  | {
      kind: 'event';
      event: 'created' | 'changed' | 'any';
      path: string;
      pattern: string;
      recursive: boolean;
      cooldownSec: number;
    }
  | {
      kind: 'condition';
      condition: 'mission_failed';
      sourceTriggerId: string | null;
      maxRetries: number;
      delayMinutes: number;
    };

export interface ScheduledTrigger {
  id: string;
  name: string;
  kind: TriggerSpec['kind'];
  spec: TriggerSpec;
  missionTemplate: string;
  budget: { maxCostUsd?: number; maxAiCalls?: number; maxToolCalls?: number; maxDurationSec?: number };
  enabled: boolean;
  autoStart: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastMissionId: string | null;
  lastError: string | null;
  runCount: number;
  createdAt: string;
  description: string;
  upcoming: string[];
}

export interface ProactiveSettings {
  enabled: boolean;
  maxCostUsd: number;
  maxRunsPerDay: number;
  desktopNotifications: boolean;
}

export interface TriggerRun {
  id: string;
  triggerId: string;
  missionId: string | null;
  firedAt: string;
  reason: string;
  status: string;
  error: string | null;
  attempt: number;
  request: string | null;
  mission: {
    id: string;
    status: string;
    usage: { costUsd: number; costKnown: boolean };
    endedAt: string | null;
  } | null;
}

export interface TriggersState {
  triggers: ScheduledTrigger[];
  status: { running: boolean; watching: number; settings: ProactiveSettings; launchedLast24h: number };
  variables: string[];
}

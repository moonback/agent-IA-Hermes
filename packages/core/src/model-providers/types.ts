export type ChatContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ChatToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  /** Tried in order only when the previous model is unavailable or its provider keeps failing. */
  fallbackModels?: string[];
  messages: ChatMessage[];
  tools?: ChatToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  plugins?: { id: string; max_results?: number }[];
}

export interface UrlCitation {
  url: string;
  title: string | null;
  content: string | null;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cost reported by OpenRouter in USD credits; null when the API did not return it. */
  costUsd: number | null;
}

export interface ChatResponse {
  id: string | null;
  model: string;
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  /** True when generation stopped because of the token limit or an interrupted stream. */
  incomplete: boolean;
  usage: ChatUsage;
  citations: UrlCitation[];
  latencyMs: number;
  attempts: number;
}

export interface ChatOptions {
  signal?: AbortSignal;
  stream?: boolean;
  onDelta?: (text: string) => void;
  /** Called when a streamed attempt is discarded before a retry, so the UI can reset partial text. */
  onRetry?: (reason: string) => void;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description: string | null;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  supportsTools: boolean;
  supportsStructuredOutputs: boolean;
  supportsImages: boolean;
  /** USD per million tokens, null when not published. */
  pricing: { promptPerMTok: number | null; completionPerMTok: number | null; request: number | null };
}

export interface KeyInfo {
  label: string | null;
  usageUsd: number | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  isFreeTier: boolean | null;
}

export type ConnectionStatus =
  | 'config_missing'
  | 'auth_invalid'
  | 'network'
  | 'model_unavailable'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'provider_error'
  | 'ok';

export interface ConnectionTestResult {
  status: ConnectionStatus;
  ok: boolean;
  message: string;
  model: string | null;
  latencyMs: number | null;
  key: KeyInfo | null;
  testedAt: string;
}

export interface ModelProvider {
  readonly id: string;
  chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  testConnection(model: string | null): Promise<ConnectionTestResult>;
  hasKey(): Promise<boolean>;
}

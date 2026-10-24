export type HermesErrorCode =
  | 'INVALID_TRANSITION'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'POLICY_DENIED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_MISMATCH'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_FAILED'
  | 'TOOL_TIMEOUT'
  | 'UNKNOWN_TOOL'
  | 'BUDGET_EXCEEDED'
  | 'LOOP_DETECTED'
  | 'CANCELLED'
  | 'PAUSED'
  | 'MAX_ITERATIONS'
  | 'EMERGENCY_STOP'
  | 'UNCERTAIN_EFFECT'
  | 'PLAN_INVALID'
  | 'CONFIG'
  | 'COLLISION'
  | 'PROVIDER';

export class HermesError extends Error {
  constructor(
    public readonly code: HermesErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HermesError';
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return 'UNKNOWN';
}

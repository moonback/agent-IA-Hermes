/**
 * Secret masking applied to everything that leaves the process boundary: logs, events,
 * persisted tool outputs, diagnostics and error messages shown to the user.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{16,}/g, // OpenRouter keys
  /sk-[A-Za-z0-9_-]{20,}/g, // generic OpenAI-style keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /\b(?:api[_-]?key|token|password|passwd|secret|cookie)\s*[=:]\s*["']?[^\s"'&,;]{4,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys (Gemini, Vertex express)
  /\bya29\.[0-9A-Za-z._-]{20,}/g, // Google OAuth access tokens
];

const SENSITIVE_KEYS =
  /^(authorization|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|set-cookie|x-api-key|x-goog-api-key)$/i;

const extraSecrets = new Set<string>();

/** Registers a literal value (e.g. the live API key) so it is masked wherever it appears. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) extraSecrets.add(value);
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of extraSecrets) out = out.split(secret).join('[REDACTED]');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return '[TRUNCATED]' as T;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    if (value instanceof Error) return redactString(value.message) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Truncates large strings inside a JSON-compatible value to keep events/DB rows bounded. */
export function truncateDeep<T>(value: T, maxString = 8000, depth = 0): T {
  if (depth > 12) return '[TRUNCATED]' as T;
  if (typeof value === 'string')
    return (
      value.length > maxString
        ? `${value.slice(0, maxString)}… [${value.length - maxString} caractères tronqués]`
        : value
    ) as T;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => truncateDeep(v, maxString, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = truncateDeep(v, maxString, depth + 1);
    return out as T;
  }
  return value;
}

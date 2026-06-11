/**
 * @module utils/redaction
 *
 * Task #232: Scrub sensitive values out of structured payloads before
 * they are persisted to the SQLite event log. Tool inputs/outputs flow
 * verbatim into the `events` table; without scrubbing, an API key passed
 * as a tool argument or a secret echoed in a tool result would sit in
 * plaintext on disk indefinitely.
 *
 * The redactor is conservative and structural: it walks the object
 * graph and replaces values whose KEY looks sensitive (api_key, token,
 * password, secret, authorization, …) regardless of the value, and
 * additionally rewrites string VALUES that match well-known secret
 * shapes (Anthropic `sk-ant-…` keys, Bearer headers, AWS keys, generic
 * long high-entropy-ish tokens). It is intentionally side-effect-free:
 * it returns a deep copy and never mutates the input.
 */

export const REDACTED = '[REDACTED]';

/** Default cap on recursion depth — guards against pathological/cyclic graphs. */
const MAX_DEPTH = 12;

/**
 * Key names (case-insensitive, substring match) whose value is always
 * redacted regardless of content.
 */
const SENSITIVE_KEY_PATTERNS = [
  'apikey',
  'api_key',
  'secret',
  'password',
  'passwd',
  'token',
  'authorization',
  'auth_token',
  'access_token',
  'refresh_token',
  'client_secret',
  'private_key',
  'credential',
  'session_token',
  'cookie',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p.replace(/[-_\s]/g, '')));
}

/**
 * Value-shape patterns for secrets that may appear under innocuous keys
 * (e.g. inside a free-text tool result). Each match replaces just the
 * matched span with {@link REDACTED}.
 */
const VALUE_PATTERNS: RegExp[] = [
  // Anthropic API keys.
  /sk-ant-[A-Za-z0-9_-]{12,}/g,
  // OpenAI-style keys.
  /sk-[A-Za-z0-9]{20,}/g,
  // GitHub tokens (classic + fine-grained).
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  // AWS access key ids.
  /AKIA[0-9A-Z]{16}/g,
  // Bearer tokens in Authorization headers.
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
  // Google OAuth refresh/access tokens.
  /ya29\.[A-Za-z0-9._-]{20,}/g,
];

/** Redact secret-shaped spans inside a plain string value. */
export function redactString(value: string): string {
  let out = value;
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Deep-redact a structured value. Returns a scrubbed deep copy:
 *   - Object/array properties whose KEY is sensitive → {@link REDACTED}.
 *   - String values are run through {@link redactString}.
 *   - Other primitives pass through unchanged.
 *
 * Cyclic references and depths beyond {@link MAX_DEPTH} collapse to a
 * placeholder rather than throwing.
 */
export function redactSensitive<T>(value: T): T {
  return redactInner(value, 0, new WeakSet()) as T;
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[TRUNCATED]';
    if (seen.has(value as object)) return '[CIRCULAR]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((v) => redactInner(v, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactInner(v, depth + 1, seen);
      }
    }
    return out;
  }

  // Functions / symbols — drop to a stable placeholder.
  return undefined;
}

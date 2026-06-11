/**
 * @module orchestration/model-fallback
 *
 * Task #230 — classification + detection for "model unavailable / forbidden /
 * not entitled" failures.
 *
 * Such failures are PERMANENT: retrying the identical call with backoff will
 * never conjure entitlement to a gated/unknown model. The executor treats them
 * as permanent in its error classifier AND uses {@link isModelUnavailableMessage}
 * to trigger graceful degradation to the next-best available tier from the
 * model registry (e.g. an unavailable mythos model → opus) before giving up.
 *
 * Detection is message-pattern based so it works regardless of whether the
 * failure surfaces as a raw Anthropic API error, an SDK result error, or a
 * {@link TaggedRetryError} wrapping the bridge's message.
 */

/**
 * A distinct, classified error for a requested model that is unavailable,
 * forbidden, or not entitled. Carries the requested model id and the
 * underlying reason so the executor can record requested→fallback telemetry.
 */
export class ModelUnavailableError extends Error {
  readonly requestedModel: string;
  readonly reason: string;

  constructor(requestedModel: string, reason: string) {
    super(`Model "${requestedModel}" is unavailable: ${reason}`);
    this.name = 'ModelUnavailableError';
    this.requestedModel = requestedModel;
    this.reason = reason;
  }
}

/**
 * Patterns that identify a model-level access failure (as opposed to a generic
 * auth failure, a transient 5xx, or a validation error). Kept intentionally
 * model-scoped — a bare "forbidden"/"403" is more likely an API-key problem
 * that a different model wouldn't fix, so those are left to the generic
 * permanent classifier and do NOT trigger tier fallback.
 */
const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /not entitled/i,
  /entitlement/i,
  /does not have access/i,
  /no access to (?:the )?model/i,
  /model_not_found/i,
  /unknown model/i,
  /invalid model/i,
  /unsupported model/i,
  /access[- ]gated/i,
  /this model requires/i,
  // "model <id> is not available / not found / not allowed / is gated / ..."
  /\bmodel\b[^.\n]{0,60}\b(?:not found|not available|unavailable|not allowed|not permitted|is restricted|requires access|is gated)\b/i,
  // "... not found/available for model <id>"
  /\b(?:not found|not available|unavailable|not allowed|not permitted)\b[^.\n]{0,60}\bmodel\b/i,
];

/**
 * True when `message` indicates the requested model is unavailable / forbidden
 * / not entitled. Empty/undefined messages return false.
 */
export function isModelUnavailableMessage(message: string | undefined | null): boolean {
  if (!message) return false;
  return MODEL_UNAVAILABLE_PATTERNS.some((re) => re.test(message));
}

/** True when `err` is a {@link ModelUnavailableError} or its message matches. */
export function isModelUnavailableError(err: unknown): boolean {
  if (err instanceof ModelUnavailableError) return true;
  if (err instanceof Error) return isModelUnavailableMessage(err.message);
  if (typeof err === 'string') return isModelUnavailableMessage(err);
  return false;
}

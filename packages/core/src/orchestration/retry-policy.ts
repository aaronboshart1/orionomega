/**
 * @module orchestration/retry-policy
 *
 * Retry / backoff / timeout policy for the graph executor (Task #237 split
 * out of `executor.ts`). Pure, side-effect-free decisions about:
 *   - whether an error is transient (retryable) or permanent;
 *   - how long to back off before the next attempt;
 *   - the effective per-node wall-clock timeout (applying per-type floors);
 *   - the per-attempt timeout multiplier;
 *   - resolving the effective retry cap given the config-level sentinel.
 *
 * Keeping these decisions in one collaborator lets them be unit-tested in
 * isolation and keeps the executor focused on orchestration.
 */

import type { WorkflowNode } from './types.js';
import { TaggedRetryError } from './retry-error.js';
import { ModelUnavailableError, isModelUnavailableMessage } from './model-fallback.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('retry-policy');

export type ErrorClassification = 'transient' | 'permanent';

export const PERMANENT_ERROR_PATTERNS = [
  /authentication failed/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid api key/i,
  /invalid.*token/i,
  /permission denied/i,
  /access denied/i,
  /validation error/i,
  /invalid.*parameter/i,
  /invalid.*argument/i,
  /missing required/i,
  /schema.*validation/i,
  /not found/i,
  /404/,
  /401/,
  /403/,
  /422/,
];

export const TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /socket hang up/i,
  /network error/i,
  /rate limit/i,
  /too many requests/i,
  /429/,
  /500/,
  /502/,
  /503/,
  /504/,
  /service unavailable/i,
  /internal server error/i,
  /bad gateway/i,
  /gateway timeout/i,
  /overloaded/i,
];

/**
 * Classify an error as transient (retryable) or permanent.
 *
 * - A model-unavailable/forbidden/not-entitled failure is PERMANENT — the same
 *   call will keep failing; the executor degrades to another tier instead of
 *   backing off. Checked first so it wins over any pattern below.
 * - An explicit decision from the bridge (`TaggedRetryError`) is trusted over
 *   message-pattern matching.
 */
export function classifyError(err: Error): ErrorClassification {
  if (err instanceof ModelUnavailableError) return 'permanent';
  if (err instanceof TaggedRetryError) {
    return err.retryable ? 'transient' : 'permanent';
  }
  const msg = err.message;
  if (isModelUnavailableMessage(msg)) return 'permanent';
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(msg)) return 'transient';
  }
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (pattern.test(msg)) return 'permanent';
  }
  return 'transient';
}

export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30000;

/** Exponential backoff with full jitter (0.5×–1.0× the exponential value). */
export function computeBackoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
  const jitter = exponential * (0.5 + Math.random() * 0.5);
  return Math.round(jitter);
}

/**
 * Minimum wall-clock timeout per node type, applied as a floor regardless of
 * what the planner LLM emits or the user passes via config.
 *
 * Rationale: the planner has historically emitted node-level `timeout: 120`
 * (the JSON example value) which silently overrode the user's higher
 * `workerTimeout`. That triggered AbortController-driven aborts that the SDK
 * surfaced as "Claude Code process aborted by user" — confusing every
 * downstream operator. Floors below catch that class of bug at execution time.
 *
 * - AGENT:        900s  — research/analysis tasks need real headroom.
 * - CODING_AGENT: 1800s — multi-turn coding loops are long-running by design.
 * - TOOL:         60s   — short-lived shell invocations.
 */
export const TIMEOUT_FLOOR_SEC = {
  AGENT: 900,
  CODING_AGENT: 1800,
  TOOL: 60,
} as const;

/**
 * Resolve the effective wall-clock timeout for a node, applying the per-type
 * floor so a too-small planner-supplied value (e.g. `timeout: 120` for a
 * coding agent) cannot cause a guaranteed timeout-driven abort.
 */
export function resolveNodeTimeoutSec(
  node: WorkflowNode,
  defaults: { workerTimeout: number; codingAgentTimeout: number },
): number {
  const requested = node.timeout
    ?? (node.type === 'CODING_AGENT' ? defaults.codingAgentTimeout : defaults.workerTimeout);
  const floor = node.type === 'CODING_AGENT'
    ? TIMEOUT_FLOOR_SEC.CODING_AGENT
    : node.type === 'TOOL'
      ? TIMEOUT_FLOOR_SEC.TOOL
      : TIMEOUT_FLOOR_SEC.AGENT;
  if (requested < floor) {
    log.info(
      `Node '${node.id}' has timeout=${requested}s below the ${node.type} floor of ${floor}s — clamping up`,
    );
    return floor;
  }
  return requested;
}

/**
 * Per-attempt timeout multiplier. The first attempt gets the base budget;
 * each retry gets progressively more time, since a transient timeout on
 * attempt N often means the workload is genuinely larger than the planner
 * estimated. This prevents the same-budget-every-time loop where every
 * attempt times out at exactly the same point.
 */
export const RETRY_TIMEOUT_MULTIPLIERS = [1.0, 1.5, 2.0, 2.0, 2.0] as const;

export function timeoutMultiplierForAttempt(attempt: number): number {
  return RETRY_TIMEOUT_MULTIPLIERS[Math.min(attempt, RETRY_TIMEOUT_MULTIPLIERS.length - 1)];
}

/**
 * Resolve the effective retry cap for a node.
 *
 * The config-level `maxRetries: 0` is a sentinel meaning "unlimited transient
 * retries" (permanent errors still short-circuit via {@link classifyError}).
 * A per-node `retries` overrides the global cap, and at the per-node level `0`
 * keeps its original meaning of "no retries" — so the sentinel translation is
 * applied only when falling back to the global config value.
 */
export function resolveMaxRetries(
  nodeRetries: number | undefined,
  configMaxRetries: number,
): number {
  const cfgMax = configMaxRetries <= 0 ? Number.POSITIVE_INFINITY : configMaxRetries;
  return nodeRetries ?? cfgMax;
}

/**
 * Collaborator wrapper around the retry / backoff / timeout decisions so the
 * executor can hold a single injected policy object rather than reaching for
 * module-level functions. Stateless — safe to share across runs.
 */
export class RetryPolicy {
  classify(err: Error): ErrorClassification {
    return classifyError(err);
  }

  backoffDelay(attempt: number): number {
    return computeBackoffDelay(attempt);
  }

  resolveTimeoutSec(
    node: WorkflowNode,
    defaults: { workerTimeout: number; codingAgentTimeout: number },
  ): number {
    return resolveNodeTimeoutSec(node, defaults);
  }

  timeoutMultiplier(attempt: number): number {
    return timeoutMultiplierForAttempt(attempt);
  }

  resolveMaxRetries(nodeRetries: number | undefined, configMaxRetries: number): number {
    return resolveMaxRetries(nodeRetries, configMaxRetries);
  }
}

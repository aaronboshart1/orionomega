/**
 * Typed abort reasons passed through `AbortController.abort(reason)`.
 *
 * These let the SDK bridge — which sees only the AbortError after the fact —
 * unambiguously tell whether the abort came from the user or from a wall-clock
 * timeout. Without this, every abort surfaces as the SDK's stock
 * "Claude Code process aborted by user" message, even when the *real* cause
 * was the executor's own timeout.
 *
 * The reason flows through `signal.reason` and is read by the bridge's
 * AbortError catch sites to produce a faithful, operator-friendly error
 * message.
 */

export type OrionOmegaAbortReason =
  | { kind: 'user'; message?: string }
  | { kind: 'timeout'; timeoutSec: number; lastTool?: string; nodeLabel?: string };

/** Type guard — distinguishes our typed abort reason from arbitrary values. */
export function isOrionOmegaAbortReason(value: unknown): value is OrionOmegaAbortReason {
  return (
    typeof value === 'object'
    && value !== null
    && 'kind' in value
    && ((value as { kind: unknown }).kind === 'user' || (value as { kind: unknown }).kind === 'timeout')
  );
}

/**
 * Format an abort reason as a human-readable string for error messages
 * and logs. Falls back gracefully for unknown reasons.
 */
export function describeAbortReason(reason: unknown): string {
  if (!isOrionOmegaAbortReason(reason)) {
    if (reason instanceof Error) return reason.message;
    if (typeof reason === 'string') return reason;
    return 'aborted';
  }
  if (reason.kind === 'user') {
    return reason.message ?? 'cancelled by user';
  }
  const ctx: string[] = [];
  ctx.push(`timed out after ${reason.timeoutSec}s`);
  if (reason.lastTool) ctx.push(`last tool: ${reason.lastTool}`);
  if (reason.nodeLabel) ctx.push(`node: ${reason.nodeLabel}`);
  return ctx.join(' — ');
}

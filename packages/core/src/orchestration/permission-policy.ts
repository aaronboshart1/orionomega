/**
 * @module orchestration/permission-policy
 *
 * Defense-in-depth permission layer for the Claude Agent SDK bridge.
 *
 * The SDK can pause an agent and request approval to run a tool. OrionOmega
 * runs the SDK headlessly inside `executeAgent()` / `executeCodingAgent()`,
 * so any prompt that escapes our `permissionMode` floor would hang the node.
 *
 * This module provides three pieces of plumbing:
 *
 *   1. {@link evaluatePermission} — a pure, synchronous policy evaluator
 *      that turns `(toolName, toolInput, allowedTools, humanGates)` into an
 *      `allow` / `deny(reason)` decision. Trivially unit-testable.
 *   2. {@link buildCanUseTool} — wraps {@link evaluatePermission} into the
 *      SDK's `CanUseTool` callback shape, honors the abort `signal`, and
 *      emits an audit log entry per decision.
 *   3. {@link buildPermissionRequestHook} — a passive `PermissionRequest`
 *      audit hook that warns whenever the SDK *would* prompt, so operators
 *      can see what's escalating in practice. (`canUseTool` is the actual
 *      decision authority; this hook is purely observational.)
 *
 * Net effect: the SDK can never block on a permission prompt, decisions are
 * auditable, and `humanGates` is honored by code rather than bypassed.
 */

import type { CanUseTool, HookCallback, PermissionRequestHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../logging/logger.js';
import { emitAuditEvent } from '../logging/audit.js';

const log = createLogger('agent-permission');

export type PermissionDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string };

export interface PermissionPolicyInput {
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  /**
   * Per-call list of tool names the orchestrator pre-approved for this
   * agent invocation. The allow-list is the *authority*: when provided
   * (including as an empty array), any tool not in it is denied. Pass
   * `undefined` only to opt out of allow-list checking entirely (gates
   * still apply).
   */
  allowedTools: readonly string[] | undefined;
  /**
   * Substring/keyword patterns from `autonomous.humanGates` that, if found
   * in the tool name OR serialized tool input (case-insensitive), force a
   * deny. Mirrors the substring-style gate matching used elsewhere.
   */
  humanGates: readonly string[] | undefined;
}

/**
 * Pure synchronous policy evaluator. No I/O, no logging — caller decides
 * how/when to record the decision. Order of checks:
 *
 *   1. If an allow-list is provided and the tool isn't on it → deny.
 *   2. If any gate keyword appears in the tool name or serialized input
 *      (case-insensitive substring) → deny with the matched keyword.
 *   3. Otherwise → allow.
 */
export function evaluatePermission(input: PermissionPolicyInput): PermissionDecision {
  const { toolName, toolInput, allowedTools, humanGates } = input;

  if (allowedTools !== undefined && !allowedTools.includes(toolName)) {
    return {
      decision: 'deny',
      reason: `Tool '${toolName}' is not in the per-call allowedTools list`,
    };
  }

  if (humanGates && humanGates.length > 0) {
    const haystack = (toolName + ' ' + safeStringify(toolInput)).toLowerCase();
    for (const gate of humanGates) {
      const needle = gate.trim().toLowerCase();
      if (!needle) continue;
      if (haystack.includes(needle)) {
        return {
          decision: 'deny',
          reason: `Tool '${toolName}' matches humanGates pattern '${gate}'`,
        };
      }
    }
  }

  return { decision: 'allow' };
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    // Circular or non-serializable input — fall back to the tool-name-only check.
    return '';
  }
}

export interface CanUseToolFactoryOptions {
  allowedTools: readonly string[] | undefined;
  humanGates: readonly string[] | undefined;
  /** Optional context tag for audit entries (e.g. 'agent', 'coding-agent'). */
  actor?: string;
  /**
   * Optional human-in-the-loop approval callback. When the policy would deny
   * a tool because of `humanGates`, this callback is invoked with the tool
   * name, the policy's deny reason, and an `AbortSignal` that fires whenever
   * the policy stops waiting for an answer (timeout, SDK abort, callback
   * error). Implementations should listen for `signal.abort` and clean up
   * any UI/pending-request state so prompts don't leak past the moment the
   * policy has already moved on.
   *
   * Returning `true` overrides the deny and allows the tool through;
   * returning `false` (or rejecting / timing out) preserves the original
   * deny. When this option is `undefined` the policy behaviour is
   * unchanged: every gated tool is denied automatically (the
   * autonomous-mode default).
   */
  requestApproval?: (
    toolName: string,
    reason: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  /**
   * How long to wait for `requestApproval` to resolve before falling back to
   * deny. Defaults to 5 minutes. Ignored when `requestApproval` is not set.
   */
  approvalTimeoutMs?: number;
}

/**
 * Default approval timeout. Long enough that a human reviewer can read the
 * prompt and respond; short enough that an unattended workflow doesn't sit
 * forever waiting for a human who isn't there.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build the SDK's `canUseTool` callback. The callback:
 *   - short-circuits to `deny` if its `signal` is already aborted, without
 *     consulting the policy (we cannot meaningfully authorize a tool whose
 *     in-flight request has been cancelled);
 *   - otherwise runs {@link evaluatePermission} and maps the result onto
 *     the SDK's `PermissionResult` shape;
 *   - emits an audit log entry per invocation (allow or deny) routed
 *     through the same logger as `auditToolInvocation`.
 *
 * Allowed responses preserve the original `input` unchanged — we are not
 * rewriting tool inputs, just gating them.
 */
export function buildCanUseTool(options: CanUseToolFactoryOptions): CanUseTool {
  const { allowedTools, humanGates, actor, requestApproval } = options;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  return async (toolName, toolInput, ctx) => {
    const { signal, toolUseID, agentID } = ctx;

    if (signal.aborted) {
      const reason = 'Permission request received after cancellation';
      logPermissionDecision({
        toolName,
        decision: 'deny',
        reason,
        toolUseID,
        agentID,
        actor,
      });
      return { behavior: 'deny', message: reason, toolUseID };
    }

    const result = evaluatePermission({
      toolName,
      toolInput,
      allowedTools,
      humanGates,
    });

    // If the policy would deny purely because of a humanGates match AND a
    // human-in-the-loop callback is wired, give the user a chance to
    // approve. Allow-list denials are *not* escalated — those are
    // configuration errors, not gated actions.
    if (
      result.decision === 'deny' &&
      requestApproval &&
      isHumanGateDeny(result.reason)
    ) {
      logPermissionDecision({
        toolName,
        decision: 'deny',
        reason: `${result.reason} — requesting human approval`,
        toolUseID,
        agentID,
        actor,
      });

      const approval = await requestApprovalWithTimeout({
        requestApproval,
        toolName,
        reason: result.reason,
        timeoutMs: approvalTimeoutMs,
        signal,
      });

      const finalReason =
        approval.outcome === 'approved'
          ? `${result.reason} — approved by human`
          : approval.outcome === 'denied'
            ? `${result.reason} — denied by human`
            : approval.outcome === 'timeout'
              ? `${result.reason} — no human response within ${approvalTimeoutMs}ms`
              : approval.outcome === 'aborted'
                ? `${result.reason} — cancelled while awaiting approval`
                : `${result.reason} — approval callback failed: ${approval.error}`;

      logPermissionDecision({
        toolName,
        decision: approval.outcome === 'approved' ? 'allow' : 'deny',
        reason: finalReason,
        toolUseID,
        agentID,
        actor,
      });

      if (approval.outcome === 'approved') {
        return { behavior: 'allow', updatedInput: toolInput, toolUseID };
      }
      return { behavior: 'deny', message: finalReason, toolUseID };
    }

    logPermissionDecision({
      toolName,
      decision: result.decision,
      reason: result.decision === 'deny' ? result.reason : undefined,
      toolUseID,
      agentID,
      actor,
    });

    if (result.decision === 'allow') {
      return { behavior: 'allow', updatedInput: toolInput, toolUseID };
    }

    return { behavior: 'deny', message: result.reason, toolUseID };
  };
}

/**
 * Returns true when the policy deny reason was produced by a humanGates
 * match (and therefore a candidate for human override). Allow-list denies
 * are not escalated — see {@link evaluatePermission}.
 */
function isHumanGateDeny(reason: string): boolean {
  return reason.includes('humanGates pattern');
}

type ApprovalOutcome =
  | { outcome: 'approved' }
  | { outcome: 'denied' }
  | { outcome: 'timeout' }
  | { outcome: 'aborted' }
  | { outcome: 'error'; error: string };

/**
 * Race the user's approval callback against a wall-clock timeout and the
 * SDK's abort signal. Any of (callback resolves false, callback throws,
 * timer fires, signal aborts) collapses to a deny — the SDK is never
 * left waiting on a human who isn't going to respond.
 */
async function requestApprovalWithTimeout(args: {
  requestApproval: (toolName: string, reason: string, signal: AbortSignal) => Promise<boolean>;
  toolName: string;
  reason: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ApprovalOutcome> {
  const { requestApproval, toolName, reason, timeoutMs, signal } = args;

  // A second AbortController so we can notify the requestApproval callback
  // whenever the policy stops waiting (timeout, upstream abort, callback
  // error). This lets implementations clean up any pending-prompt state
  // they kept on our behalf.
  const cleanupController = new AbortController();

  return new Promise<ApprovalOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ApprovalOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
      // Only abort the cleanup controller for non-approved outcomes — the
      // approved branch has already produced a value via resolveGate, no
      // need to re-signal cancellation.
      if (outcome.outcome !== 'approved' && !cleanupController.signal.aborted) {
        cleanupController.abort();
      }
      resolve(outcome);
    };

    const abortHandler = (): void => settle({ outcome: 'aborted' });
    if (signal.aborted) {
      cleanupController.abort();
      resolve({ outcome: 'aborted' });
      return;
    }
    signal.addEventListener('abort', abortHandler);

    const timer: ReturnType<typeof setTimeout> | null =
      timeoutMs > 0 && Number.isFinite(timeoutMs)
        ? setTimeout(() => settle({ outcome: 'timeout' }), timeoutMs)
        : null;
    timer?.unref?.();

    Promise.resolve()
      .then(() => requestApproval(toolName, reason, cleanupController.signal))
      .then(
        (approved) => settle({ outcome: approved ? 'approved' : 'denied' }),
        (err) => settle({ outcome: 'error', error: err instanceof Error ? err.message : String(err) }),
      );
  });
}

interface DecisionLogFields {
  toolName: string;
  decision: 'allow' | 'deny';
  reason?: string;
  toolUseID?: string;
  agentID?: string;
  actor?: string;
}

function logPermissionDecision(fields: DecisionLogFields): void {
  emitAuditEvent({
    category: 'tool_invocation',
    action: `permission:${fields.decision}:${fields.toolName}`,
    actor: fields.actor,
    detail: fields.reason,
    meta: {
      toolName: fields.toolName,
      decision: fields.decision,
      ...(fields.reason ? { reason: fields.reason } : {}),
      ...(fields.toolUseID ? { toolUseID: fields.toolUseID } : {}),
      ...(fields.agentID ? { agentID: fields.agentID } : {}),
    },
  });
}

/**
 * Build the passive `PermissionRequest` audit hook. The hook does NOT make
 * a permission decision (`canUseTool` is the decision authority); it only
 * logs a structured warning so operators can spot which tools the SDK is
 * still escalating in practice. Hook output is empty so the SDK falls
 * through to `canUseTool` as normal.
 */
export function buildPermissionRequestHook(actor?: string): HookCallback {
  return async (input, toolUseID) => {
    const evt = input as PermissionRequestHookInput;
    log.warn('[permission] SDK raised PermissionRequest', {
      actor,
      tool_name: evt.tool_name,
      ...(evt.permission_suggestions
        ? { permission_suggestions: evt.permission_suggestions }
        : {}),
      ...(toolUseID ? { toolUseID } : {}),
      ...(evt.agent_id ? { agentID: evt.agent_id } : {}),
    });
    // Return an empty sync hook output — let canUseTool decide.
    return {};
  };
}

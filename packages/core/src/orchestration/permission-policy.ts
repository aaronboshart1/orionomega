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
}

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
  const { allowedTools, humanGates, actor } = options;

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

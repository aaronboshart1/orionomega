/**
 * @module orchestration/__tests__/permission-policy
 *
 * Unit tests for the agent-SDK permission policy:
 *   (a) allowed tool → allow
 *   (b) gated tool name (matches a humanGates keyword) → deny
 *   (c) tool not in allowedTools → deny
 *   (d) aborted signal → deny without invoking policy
 *   (e) PermissionRequest hook fires and logs a warning
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluatePermission,
  buildCanUseTool,
  buildPermissionRequestHook,
} from '../permission-policy.js';

// The policy module emits decisions through the audit logger, which uses
// the project logger. We don't need to assert log output for the policy
// itself (evaluatePermission is pure), only for the PermissionRequest
// hook test below — so we spy on console.warn instead of mocking the
// logger module wholesale.

describe('evaluatePermission', () => {
  const humanGates = ['deploy', 'merge', 'delete', 'destroy_vm'];
  const allowedTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

  it('(a) allows a tool that is on the allowedTools list and not gated', () => {
    const result = evaluatePermission({
      toolName: 'Read',
      toolInput: { file_path: '/tmp/foo.txt' },
      allowedTools,
      humanGates,
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('(b) denies a tool whose name matches a humanGates keyword', () => {
    // Synthetic tool name — `delete` is in the default humanGates list.
    const result = evaluatePermission({
      toolName: 'DeleteFile',
      toolInput: { path: '/tmp/x' },
      // Permissive allow-list so the gate is the reason for the deny.
      allowedTools: ['DeleteFile'],
      humanGates,
    });
    expect(result.decision).toBe('deny');
    if (result.decision === 'deny') {
      expect(result.reason).toMatch(/humanGates/);
      expect(result.reason).toMatch(/delete/);
    }
  });

  it('(b2) denies when a humanGates keyword appears in the tool input', () => {
    const result = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf / && deploy --prod' },
      allowedTools,
      humanGates,
    });
    expect(result.decision).toBe('deny');
    if (result.decision === 'deny') {
      expect(result.reason).toMatch(/deploy/);
    }
  });

  it('(c) denies a tool that is not on the allowedTools list', () => {
    const result = evaluatePermission({
      toolName: 'Task',
      toolInput: {},
      allowedTools, // Task is not in this list
      humanGates,
    });
    expect(result.decision).toBe('deny');
    if (result.decision === 'deny') {
      expect(result.reason).toMatch(/allowedTools/);
      expect(result.reason).toMatch(/Task/);
    }
  });

  it('allows when allowedTools is undefined (no allow-list opt-out) and gates pass', () => {
    const result = evaluatePermission({
      toolName: 'AnythingGoes',
      toolInput: {},
      allowedTools: undefined,
      humanGates,
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('denies every tool when allowedTools is an empty array (deny-all)', () => {
    const result = evaluatePermission({
      toolName: 'Read',
      toolInput: { file_path: '/tmp/foo' },
      allowedTools: [],
      humanGates,
    });
    expect(result.decision).toBe('deny');
    if (result.decision === 'deny') {
      expect(result.reason).toMatch(/allowedTools/);
    }
  });

  it('treats empty/whitespace gate entries as no-ops', () => {
    const result = evaluatePermission({
      toolName: 'Read',
      toolInput: { file_path: '/tmp/foo' },
      allowedTools,
      humanGates: ['', '   '],
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('handles non-serializable input by falling back to tool-name-only matching', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = evaluatePermission({
      toolName: 'Read',
      toolInput: circular,
      allowedTools,
      humanGates,
    });
    // Tool name is benign and input is unstringifiable — should still allow.
    expect(result).toEqual({ decision: 'allow' });
  });
});

describe('buildCanUseTool', () => {
  const humanGates = ['deploy', 'merge', 'delete', 'destroy_vm'];
  const allowedTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

  function makeCtx(overrides: Partial<Parameters<ReturnType<typeof buildCanUseTool>>[2]> = {}) {
    const controller = new AbortController();
    return {
      controller,
      ctx: {
        signal: controller.signal,
        toolUseID: 'tu_test_001',
        ...overrides,
      },
    };
  }

  it('returns allow with the original input passed through unchanged', async () => {
    const canUse = buildCanUseTool({ allowedTools, humanGates, actor: 'agent' });
    const { ctx } = makeCtx();
    const input = { file_path: '/tmp/x' };
    const result = await canUse('Read', input, ctx);
    expect(result.behavior).toBe('allow');
    if (result.behavior === 'allow') {
      expect(result.updatedInput).toBe(input);
      expect(result.toolUseID).toBe('tu_test_001');
    }
  });

  it('returns deny with the policy reason for a gated tool', async () => {
    const canUse = buildCanUseTool({
      allowedTools: ['DeleteThing'],
      humanGates,
      actor: 'agent',
    });
    const { ctx } = makeCtx();
    const result = await canUse('DeleteThing', {}, ctx);
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/humanGates/);
      expect(result.toolUseID).toBe('tu_test_001');
    }
  });

  it('(f) escalates a humanGates deny through the requestApproval callback and allows when approved', async () => {
    const requestApproval = vi.fn(async () => true);
    const canUse = buildCanUseTool({
      allowedTools: ['DeleteThing'],
      humanGates,
      actor: 'agent',
      requestApproval,
    });
    const { ctx } = makeCtx();
    const result = await canUse('DeleteThing', { path: '/x' }, ctx);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0]).toBe('DeleteThing');
    expect(result.behavior).toBe('allow');
  });

  it('(g) preserves the deny when the human declines', async () => {
    const requestApproval = vi.fn(async () => false);
    const canUse = buildCanUseTool({
      allowedTools: ['DeleteThing'],
      humanGates,
      actor: 'agent',
      requestApproval,
    });
    const { ctx } = makeCtx();
    const result = await canUse('DeleteThing', {}, ctx);
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/denied by human/);
    }
  });

  it('(h) falls back to deny when the approval callback exceeds the timeout', async () => {
    const requestApproval = vi.fn(
      () => new Promise<boolean>(() => { /* never resolves */ }),
    );
    const canUse = buildCanUseTool({
      allowedTools: ['DeleteThing'],
      humanGates,
      actor: 'agent',
      requestApproval,
      approvalTimeoutMs: 25,
    });
    const { ctx } = makeCtx();
    const result = await canUse('DeleteThing', {}, ctx);
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/no human response/);
    }
  });

  it('(i) does not escalate when no requestApproval callback is wired (autonomous default)', async () => {
    const canUse = buildCanUseTool({
      allowedTools: ['DeleteThing'],
      humanGates,
      actor: 'agent',
    });
    const { ctx } = makeCtx();
    const result = await canUse('DeleteThing', {}, ctx);
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/humanGates/);
      expect(result.message).not.toMatch(/approved by human/);
      expect(result.message).not.toMatch(/denied by human/);
    }
  });

  it('(j) does not escalate allow-list denials — only humanGates denials are escalated', async () => {
    const requestApproval = vi.fn(async () => true);
    const canUse = buildCanUseTool({
      // 'Task' is not in the allow-list, so it should deny without ever
      // consulting the human callback (allow-list errors are config issues,
      // not gated actions).
      allowedTools: ['Read'],
      humanGates,
      actor: 'agent',
      requestApproval,
    });
    const { ctx } = makeCtx();
    const result = await canUse('Task', {}, ctx);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(result.behavior).toBe('deny');
  });

  it('(k) cancels the pending approval prompt when the SDK abort fires mid-wait', async () => {
    let resolveApproval: ((v: boolean) => void) | undefined;
    const requestApproval = vi.fn(
      () => new Promise<boolean>((res) => { resolveApproval = res; }),
    );
    const canUse = buildCanUseTool({
      allowedTools: ['DeleteThing'],
      humanGates,
      actor: 'agent',
      requestApproval,
      approvalTimeoutMs: 60_000,
    });
    const { controller, ctx } = makeCtx();
    const p = canUse('DeleteThing', {}, ctx);
    // Abort while the human is still "thinking".
    setTimeout(() => controller.abort(), 5);
    const result = await p;
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/cancelled while awaiting approval/);
    }
    // Late resolution must not throw.
    resolveApproval?.(true);
  });

  it('(l) signals the requestApproval callback when the policy stops waiting (timeout/abort)', async () => {
    // Captures the cleanup signal so we can assert the policy fires it on
    // timeout/abort. Bridge uses this to drop stale pendingGates entries.
    const captured: { signal?: AbortSignal } = {};
    const requestApproval = vi.fn(
      (_tool: string, _reason: string, signal: AbortSignal) =>
        new Promise<boolean>(() => {
          captured.signal = signal;
        }),
    );

    const canUse = buildCanUseTool({
      allowedTools: ['DeleteThing'],
      humanGates,
      actor: 'agent',
      requestApproval,
      approvalTimeoutMs: 25,
    });
    const { ctx } = makeCtx();
    const result = await canUse('DeleteThing', {}, ctx);
    expect(result.behavior).toBe('deny');
    expect(captured.signal).toBeDefined();
    expect(captured.signal!.aborted).toBe(true);
  });

  it('(d) short-circuits to deny when the signal is already aborted', async () => {
    // Spy via a humanGates value that would otherwise *allow* (no match)
    // to prove the policy was not consulted — the deny reason must be the
    // cancellation message, not a policy reason.
    const canUse = buildCanUseTool({ allowedTools, humanGates, actor: 'agent' });
    const { controller, ctx } = makeCtx();
    controller.abort();
    const result = await canUse('Read', { file_path: '/tmp/x' }, ctx);
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/cancellation/i);
    }
  });
});

describe('buildPermissionRequestHook', () => {
  // The project logger writes through console.log (see logging/logger.ts);
  // it formats `[WARN]` into the line itself, so spy on console.log here.
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('(e) fires and logs a warning containing the tool name', async () => {
    const hook = buildPermissionRequestHook('agent');
    const result = await hook(
      {
        hook_event_name: 'PermissionRequest',
        session_id: 'sess_1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        permission_suggestions: [],
      } as Parameters<typeof hook>[0],
      'tu_perm_001',
      { signal: new AbortController().signal },
    );

    // The hook returns an empty sync output (canUseTool is the decision
    // authority); we only care that it logged.
    expect(result).toEqual({});
    expect(logSpy).toHaveBeenCalled();
    const call = logSpy.mock.calls.find((args) =>
      args.some(
        (a) => typeof a === 'string' && a.includes('PermissionRequest') && a.includes('WARN'),
      ),
    );
    expect(call, 'expected a WARN log mentioning PermissionRequest').toBeTruthy();
    // tool_name should appear in the serialized payload that the logger
    // appends after the message string.
    const serialized = JSON.stringify(call);
    expect(serialized).toMatch(/Bash/);
  });
});

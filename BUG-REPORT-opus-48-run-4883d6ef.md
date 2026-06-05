# Bug Report: Run `4883d6ef454208ea` — Opus 4.8 API Compatibility Failures

**Filed:** 2026-06-05  
**Run ID:** `4883d6ef454208ea`  
**Session:** MCS Legal 2 (cannabis B2B marketplace research)  
**Severity:** P1 — Blocks all opus-4-8 orchestration nodes  
**Status:** Open  

---

## Executive Summary

Run `4883d6ef454208ea` dispatched 9 nodes. The `arch-agentic` node (the only one assigned `claude-opus-4-8`) failed on both attempts within ~1 second of starting, producing a 400 API error. A separate `max_tokens` error also fired in the same session's conversational agent. Both bugs were introduced in commit `2d7dc5d` (the Opus 4.8 compatibility update pushed earlier that day).

**Impact:** 1 of 9 nodes failed; 6 of 9 succeeded (all on `claude-sonnet-4-6`). The run completed in `error` status with `$9.71` cost, missing only the `arch-agentic` deliverable.

---

## Bug 1: `thinking.type.enabled` Rejected by Opus 4.8 API

### Error (exact from `partial-output.md`)

```
API Error: 400 {"type":"error","error":{"type":"invalid_request_error",
  "message":"\"thinking.type.enabled\" is not supported for this model. 
  Use \"thinking.type.adaptive\" and \"output_config.effort\" to control 
  thinking behavior."},
  "request_id":"req_011CbkXx32iWDFaRiZq2c1ek"}
```

### Timeline

| Time (UTC) | Event |
|---|---|
| `17:48:57.844` | `agent-sdk-bridge` starts `arch-agentic` with `model: claude-opus-4-8` |
| `17:48:59.422` | `agent-sdk-bridge` ERROR: "Claude Code process exited with code 1" |
| `17:48:59.423` | Executor retries (attempt 2/2, 566ms backoff) |
| `17:49:02.463` | Retry starts, timeout scaled 900s × 1.5 → 1350s |
| `17:49:03.527` | Same error. Node permanently failed. |

**Total wall time per attempt: ~1.5 seconds** — the API rejection is immediate.

### Root Cause

The `agent-sdk-bridge.ts` sends this to the Claude Agent SDK `query()`:

```typescript
// Line 1916-1919 of agent-sdk-bridge.ts
thinking: {
  type: 'adaptive',
  ...(thinkingBudgetTokens !== undefined ? { budget_tokens: thinkingBudgetTokens } : {}),
},
```

The code correctly sets `type: 'adaptive'`, but **also passes `budget_tokens`** (derived from `EFFORT_TO_BUDGET_TOKENS` / `EFFORT_TO_BUDGET_TOKENS_OPUS_48`). 

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@^0.2.71`) **does not support `budget_tokens` on adaptive thinking**. When it sees `budget_tokens` present, it translates the config to `{ type: 'enabled', budget_tokens: N }` in the underlying API call. Opus 4.8 only accepts `{ type: 'adaptive' }` — no `budget_tokens`, no `type: 'enabled'`.

**The adaptive thinking spec is clear:** Claude decides autonomously how much to think. The `budget_tokens` parameter is only valid with `type: 'enabled'`, which Opus 4.8 does not support at all (returns 400).

### Affected Code Path

```
executor.ts → worker.ts → agent-sdk-bridge.ts:executeCodingAgent()
  → ROLE_THINKING_CONFIG['architect'].effort = 'high'
  → EFFORT_TO_BUDGET_TOKENS_OPUS_48['high'] = 32_000
  → thinkingBudgetTokens = 32_000
  → query({ thinking: { type: 'adaptive', budget_tokens: 32000 } })
  → SDK converts to: { type: 'enabled', budget_tokens: 32000 }
  → API 400: "thinking.type.enabled" is not supported
```

### Fix Required

**In `agent-sdk-bridge.ts` lines 1916-1919:**

For opus-4-8 models, **never pass `budget_tokens`** in the thinking config. The adaptive mode is self-regulating.

```typescript
// BEFORE (broken):
thinking: {
  type: 'adaptive',
  ...(thinkingBudgetTokens !== undefined ? { budget_tokens: thinkingBudgetTokens } : {}),
},

// AFTER (fixed):
thinking: isOpus48Model(model)
  ? { type: 'adaptive' }  // Opus 4.8: adaptive only, no budget_tokens
  : {
      type: 'adaptive',
      ...(thinkingBudgetTokens !== undefined ? { budget_tokens: thinkingBudgetTokens } : {}),
    },
```

Apply the same fix at line ~1386 (the general AGENT path):

```typescript
// Line 1386 — already clean: { type: 'adaptive' } with no budget_tokens
// But should guard against future changes adding budget_tokens here too
```

**Additionally:** The `EFFORT_TO_BUDGET_TOKENS_OPUS_48` map (lines 311-320) should either be deleted or gated so it's never used for opus-4-8. It was added in commit `2d7dc5d` but is fundamentally incompatible with adaptive-only thinking.

---

## Bug 2: `max_tokens: 131072 > 128000` for Opus 4.8

### Error (from orionomega.log line 45939)

```
[2026-06-05T18:01:36.537Z] [ERROR] [main-agent] Conversational response error 
{"error":"Anthropic API error (400): {\"type\":\"invalid_request_error\",
  \"message\":\"max_tokens: 131072 > 128000, which is the maximum allowed 
  number of output tokens for claude-opus-4-8\"}"}
```

### Root Cause

`maxOutputTokensForModel()` in `client.ts` returns `131_072` (128 × 1024 = 131,072) for opus-4-8:

```typescript
// Line 142 of client.ts
if (lower.includes('opus-4-8')) return 131_072;
```

But the Anthropic API maximum for opus-4-8 is **128,000** (not 128 × 1024). The value `131_072` assumes the limit is `128K` in the binary sense (128 × 1024 = 131,072), but Anthropic uses `128K` to mean **128,000 tokens** (decimal).

### Fix Required

```typescript
// BEFORE (broken):
if (lower.includes('opus-4-8')) return 131_072;

// AFTER (fixed):
if (lower.includes('opus-4-8')) return 128_000;
```

Also update the test file `client-opus-48.test.ts` which asserts `131072`.

---

## Bug 3 (Minor): Error Message Truncation in UI Progress Stream

### Observation

The UI progress log shows the error as:

```
API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"\"thinking.type.en
```

The error message is truncated at ~100 characters. The full message (`"thinking.type.enabled" is not supported for this model...`) is only preserved in the per-node `partial-output.md` file, not in the main log or UI stream.

### Root Cause

The progress event handler in `agent-sdk-bridge.ts` (line ~1966-1971) truncates thinking/error text:

```typescript
message: thinkingText.slice(0, 100),
```

Error messages from the API are likely routed through the same truncation path or the executor's progress relay truncates at a fixed width.

### Fix Suggested

For `type: 'error'` progress events, preserve the full message (or at least 500 chars) to aid debugging. Truncation should only apply to `type: 'thinking'` events which can be very long.

---

## Summary of Required Changes

| File | Line(s) | Change | Priority |
|---|---|---|---|
| `agent-sdk-bridge.ts` | 1916-1919 | Don't pass `budget_tokens` for opus-4-8 models | **P1** |
| `agent-sdk-bridge.ts` | 311-320 | Remove or gate `EFFORT_TO_BUDGET_TOKENS_OPUS_48` | **P1** |
| `client.ts` | 142 | Change `131_072` → `128_000` | **P1** |
| `client-opus-48.test.ts` | assertion | Update expected value `131072` → `128000` | **P2** |
| `agent-sdk-bridge.ts` | ~1966 | Increase error message truncation limit | **P3** |

---

## Reproduction Steps

1. Create a DAG spec with any node using `model: claude-opus-4-8` and a role that has `thinking.enabled = true` in `ROLE_THINKING_CONFIG` (architect, implementer, debugger, etc.)
2. Run the workflow
3. The opus-4-8 node will fail within 1-2 seconds with the `thinking.type.enabled` 400 error
4. Both retry attempts will fail identically

## Verification

After fix, re-run the same DAG. The `arch-agentic` node should:
1. Start without API errors
2. Use `thinking: { type: 'adaptive' }` with no `budget_tokens`
3. Complete its deliverable within the 900s timeout

For Bug 2, send a conversational message with `model: claude-opus-4-8` and confirm no `max_tokens` 400 error.

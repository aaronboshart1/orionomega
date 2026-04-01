# Audit Deferred Items — Requires Human Review

Generated: 2026-03-31
Branch: `audit/cleanup-2026-03-31`

These items are deferred from the main audit plan because they change runtime behavior, require testing infrastructure that doesn't yet exist, or involve architectural decisions that need team consensus.

---

## 1. Security Fixes (all change runtime behavior)

These must be reviewed and tested carefully. Each item may affect client-facing behavior.

### SEC-1 — Unvalidated JSON.parse crashes route handler
**File:** `packages/gateway/src/routes/config.ts:284`
**Risk:** A malformed JSON body causes an unhandled exception, crashing the route handler.
**Fix:** Wrap `JSON.parse(body)` in try/catch; return HTTP 400 with error message on parse failure.
**Why deferred:** Changes HTTP response behavior for malformed requests.

### SEC-2 — Message validation bypass
**File:** `packages/gateway/src/websocket.ts:24`
**Risk:** `validateClientMessage()` return value is not checked on all code paths. Invalid messages can reach handlers.
**Fix:** Ensure return value is checked before every message dispatch; reject and log invalid messages.
**Why deferred:** Could reject currently-accepted messages if validation is stricter than expected.

### SEC-3 — Unbounded session ID length
**File:** `packages/gateway/src/sessions.ts:309`
**Risk:** No max-length on session IDs allows memory/storage abuse.
**Fix:** Change regex to `/^[a-z0-9_-]{1,64}$/`.
**Why deferred:** Could reject existing long session IDs in production.

### SEC-4 — Legacy SHA-256 password hashes accepted
**File:** `packages/gateway/src/auth.ts:114–118`
**Risk:** SHA-256 is not brute-force resistant. Legacy hashes remain valid.
**Fix:** Reject SHA-256 hashes with a clear error message; accept only scrypt/argon2.
**Why deferred:** Breaks auth for users with old password hashes. Needs migration path.

### SEC-5 — API key env var fallback leaks keys
**File:** `packages/gateway/src/server.ts:129`
**Risk:** `process.env.ANTHROPIC_API_KEY` used as fallback. Key could appear in error messages or logs.
**Fix:** Remove env var fallback; require explicit config entry; fail startup with clear message.
**Why deferred:** Changes startup behavior; could break deployments relying on env var.

### SEC-6 — Env var blacklist leaks new secrets
**File:** `packages/core/src/orchestration/executor.ts:23–35`
**Risk:** `SENSITIVE_ENV_PATTERNS` is a blacklist. New secret env vars not matching patterns leak to child processes.
**Fix:** Switch to explicit allowlist of permitted env vars for child processes.
**Why deferred:** Could break child processes that depend on currently-inherited env vars.

### SEC-7 — Hindsight API key env var fallback
**File:** `packages/hindsight/src/client.ts:65`
**Risk:** Same issue as SEC-5 but for Hindsight API key.
**Fix:** Remove `process.env.HINDSIGHT_API_KEY` fallback; require explicit config.
**Why deferred:** Changes initialization behavior; could break deployments.

### SEC-8 — Auth cooldown reset logic bug
**File:** `packages/gateway/src/rate-limit.ts:134`
**Risk:** `tracker.failures` may reset before threshold is reached, allowing unlimited auth attempts.
**Fix:** Add guard: only reset when `tracker.failures >= AUTH_FAILURE_THRESHOLD`. Add unit test.
**Why deferred:** Changes auth rate-limiting behavior; needs careful testing.

### SEC-9 — No per-connection WebSocket message throttling
**File:** `packages/gateway/src/websocket.ts`
**Risk:** An established connection can flood the server with unlimited messages.
**Fix:** Implement per-connection token bucket rate limiting (e.g., 10 messages/second).
**Why deferred:** New feature; needs performance benchmarking and client-side error handling.

### SEC-10 — Silent gateway spawn failure
**File:** `packages/core/src/commands/gateway.ts:73`
**Risk:** Empty `catch {}` around gateway process spawn. Failure is invisible.
**Fix:** Log error and re-throw.
**Why deferred:** Changes error propagation behavior.

---

## 2. Empty Catch Blocks (change error visibility)

All replace silent failures with logged warnings. Could surface errors that were previously hidden.

| ID | File | Lines | Count | Notes |
|----|------|-------|-------|-------|
| P-1 | `gateway/routes/skills.ts` | 85, 104, 119 | 3 | Skill route handlers silently swallow errors |
| P-2 | `tui/index.ts` | 64, 110, 262, 576, 638–640 | 6 | TUI init and event handling can silently freeze |
| P-10 | `gateway/routes/config.ts` | 284 | 1 | Overlaps with SEC-1 |

**Recommended approach:** Replace each with `catch (err) { log.warn('context', { error: err }); }` at minimum. For user-visible operations, surface error state to UI.

---

## 3. Type Safety Improvements (may surface hidden bugs)

| ID | File | Lines | Issue |
|----|------|-------|-------|
| P-4 | `tui/components/layer-group.ts` | 53, 80, 88 | `(this as any).children` bypasses type system |
| P-6 | `tui/components/plan-overlay.ts` | 59, 86 | `nodes.get(nodeId) as any` defeats Map type safety |
| P-7 | Hindsight + Core types | Multiple | `tokens_used` vs `tokensUsed` naming split |
| P-11 | `gateway/routes/*.ts` | Multiple | REST bodies cast without Zod validation |

**Why deferred:** Fixing `as any` may reveal type errors that currently compile silently. Naming standardization requires coordinated changes across Hindsight API boundary.

---

## 4. Major Refactors (need test coverage first)

These are the largest, highest-impact changes but also the riskiest without tests.

### CPX-01 — MainAgent god class (1,251 lines)
**File:** `packages/core/src/agent/main-agent.ts`
**Proposed decomposition:**
- `MainAgentInitializer` — setup and initialization
- `CommandRouter` — command dispatch
- `CheckpointCoordinator` — crash recovery
- `SessionLifecycle` — setup and teardown
- `MainAgent` — thin coordinator

### CPX-02 — streamConversation (288 lines, 4+ nesting levels)
**File:** `packages/core/src/agent/conversation.ts:316–604`
**Proposed decomposition:**
- `ToolExecutionManager` — tool call tracking + circuit breaker
- `TokenBudgetManager` — budget enforcement
- `streamConversation()` — coordination loop only

### CPX-10 — GraphExecutor god class (1,532 lines)
**File:** `packages/core/src/orchestration/executor.ts`
**Proposed decomposition:**
- `LayerExecutor` — layer-level execution
- `LoopExecutor` — loop constructs
- `NodeStateMachine` — individual node lifecycle
- `GraphExecutor` — thin orchestrator

### CPX-12 — Mixed API/internal types
**File:** `packages/core/src/orchestration/types.ts:1–347`
**Proposed:** Separate into `api-types.ts` (external input shapes) and `internal-types.ts` (runtime execution shapes).

### DC-06 — ServerMessage lacks discriminated union
**File:** `packages/gateway/src/types.ts:49–127`
**Proposed:** Convert 20+ variant `ServerMessage` union type to a proper discriminated union with literal `type` field.

---

## 5. Needs Investigation

Items where the correct fix is unclear without further analysis.

| ID | File | Question |
|----|------|----------|
| DC-04 | `core/memory/context-assembler.ts:248–301` | Does missing braces on `external_action` conditional cause `emitMemoryEvent` to be skipped? |
| DC-05 | `gateway/websocket.ts:306–310` | Do any clients depend on the intermediate `ack` message? |
| DC-08 | `web/lib/gateway.ts:25–36` | Is `statusFromToolCall()` redundant with DAG progress events? |
| DC-10 | `hindsight/client.ts:123–141` | Does Hindsight API support a lighter existence-check endpoint? |
| DC-11 | `gateway/sessions.ts` | Can session collection mutation be safely generalized? |
| DUP-16 | `core/memory` + `agent` | Can `HIGH_SIGNAL_PATTERNS` / `LOW_SIGNAL_PATTERNS` share a `PatternMatcher`? |
| DUP-24 | `core/orchestration/planner.ts:51–150` | Does planner duplicate model discovery or extend it? |
| CPX-23 | `hindsight/bank-manager.ts:47–66` | Does the Hindsight API return 409 on duplicate bank creation? |
| CPX-24 | `hindsight/self-knowledge.ts:71–91` | Does the API support batch existence checks? |
| P-8 | Cross-package | Can config types be consolidated without breaking package boundaries? |
| P-12 | `skills-sdk/validator.ts` | Is Zod migration justified given manifest validation complexity? |

---

## 6. Prerequisite: Test Infrastructure

Many deferred items cannot be safely executed without test coverage. This is the recommended first step before tackling any deferred item.

1. **Install Vitest** as the test framework (compatible with TypeScript, fast, ESM-native)
2. **Add `test` scripts** to all 6 `package.json` files
3. **Write tests for critical paths first:**
   - `core/orchestration/executor.ts` — execution state machine
   - `core/agent/conversation.ts` — streaming, tool execution
   - `gateway/auth.ts` — authentication, rate limiting
   - `gateway/websocket.ts` — message validation
   - `hindsight/client.ts` — recall, deduplication
4. **Add GitHub Actions CI** — lint + typecheck + build + test on PRs
5. **Add JSDoc to public APIs** — executable documentation via tests + hover docs

---

*Generated 2026-03-31. No source files were modified.*

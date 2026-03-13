# OrionOmega — GitHub Readiness Execution Plan

**Date:** 2026-03-13
**Source:** Synthesized from Hindsight memory (bank: `core`), GitHub repo analysis, and codebase scan

---

## 1. Master Task Registry

### Legend
- `DONE` — Completed and verified
- `PENDING` — Ready to start
- `BLOCKED` — Cannot start until blocker is resolved

---

### Completed Tasks (5)

| ID | Task | Commit / Evidence |
|----|------|-------------------|
| C1 | TUI Hindsight status indicator with animated braille spinner | `a1e7f3c` (13 files, 577 insertions) |
| C2 | Hindsight API fixes and TUI status indicator/spinner feature | `8026fcb` |
| C3 | Hindsight memory integration (session summarization, persistent core bank, corrected API endpoints) | Verified in `packages/hindsight/src/client.ts` |
| C4 | Local deployment to `10.0.0.9` — `orionomega.service` running on `127.0.0.1:7800` | Service active |
| C5 | Two-tier architecture refactor (CHAT/ACTION/ORCHESTRATE → CHAT/CHAT_ASYNC/ORCHESTRATE) | `97ea353` (~111 lines removed) |

---

### Pending Tasks (10)

| ID | Task | Status | Priority | Est. Effort |
|----|------|--------|----------|-------------|
| P1 | Implement ESLint v9 flat config (`eslint.config.js`) | PENDING | HIGH | 1–2 hours |
| P2 | Set up test framework (Vitest) and base config | PENDING | HIGH | 2–3 hours |
| P3 | Write unit tests for core packages | PENDING | HIGH | 6–10 hours |
| P4 | Write unit tests for TUI components | PENDING | MEDIUM | 4–6 hours |
| P5 | Wire Hindsight busy status end-to-end (fix Gateway health-check overwrite) | PENDING | HIGH | 1–2 hours |
| P6 | Remove legacy `WorkflowTracker` component | PENDING | MEDIUM | 1 hour |
| P7 | Investigate workflow runs stopping midway (async fire-and-forget) | PENDING | CRITICAL | 2–4 hours |
| P8 | Verify async CHAT_ASYNC fire-and-forget in production | BLOCKED | CRITICAL | 1–2 hours |
| P9 | Set up GitHub Actions CI/CD pipeline | PENDING | HIGH | 2–3 hours |
| P10 | Resolve SSH access to remote system `10.0.0.42` | BLOCKED | MEDIUM | 0.5–1 hour |

---

## 2. Dependency Graph

```
P10 (SSH to 10.0.0.42)
 └──► P8 (Verify fire-and-forget in prod) ←── P7 (Investigate stopping midway)

P1 (ESLint config)
 └──► P9 (CI/CD pipeline) ←── P2 (Vitest setup)
                                └──► P3 (Core unit tests)
                                └──► P4 (TUI unit tests)

P5 (Hindsight busy wiring) ── independent
P6 (Remove WorkflowTracker) ── independent
```

### Dependency Details

| Task | Depends On | Reason |
|------|-----------|--------|
| P3 (Core tests) | P2 (Vitest setup) | Need test framework before writing tests |
| P4 (TUI tests) | P2 (Vitest setup) | Need test framework before writing tests |
| P8 (Verify prod) | P7 (Investigate), P10 (SSH) | Must diagnose root cause first; need SSH for remote verification |
| P9 (CI/CD) | P1 (ESLint), P2 (Vitest) | CI pipeline runs lint + test; both must exist first |

---

## 3. Parallel Execution Layers (WorkflowGraph)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        LAYER 0 — Foundation                            │
│                     (all independent, run in parallel)                  │
│                                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ P1: ESLint   │  │ P2: Vitest   │  │ P5: Hindsight│  │ P6: Remove │ │
│  │ v9 config    │  │ framework    │  │ busy wiring  │  │ Workflow-  │ │
│  │              │  │ setup        │  │ fix           │  │ Tracker    │ │
│  │ ~1-2h        │  │ ~2-3h        │  │ ~1-2h        │  │ ~1h        │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────┘ │
│                                                                        │
│  ┌──────────────────┐  ┌──────────────────┐                            │
│  │ P7: Investigate  │  │ P10: Resolve SSH │                            │
│  │ async stopping   │  │ to 10.0.0.42     │                            │
│  │ midway           │  │                  │                            │
│  │ ~2-4h            │  │ ~0.5-1h          │                            │
│  └──────────────────┘  └──────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      LAYER 1 — Testing & Verification                  │
│                  (after Layer 0 dependencies complete)                  │
│                                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ P3: Core unit    │  │ P4: TUI unit     │  │ P8: Verify async     │ │
│  │ tests            │  │ tests            │  │ fire-and-forget      │ │
│  │ (needs P2)       │  │ (needs P2)       │  │ in production        │ │
│  │ ~6-10h           │  │ ~4-6h            │  │ (needs P7 + P10)     │ │
│  └──────────────────┘  └──────────────────┘  │ ~1-2h               │ │
│                                               └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        LAYER 2 — CI/CD Integration                     │
│                    (after lint + tests are in place)                    │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ P9: GitHub Actions CI/CD pipeline                                │  │
│  │ (needs P1 + P2 + P3 minimum)                                    │  │
│  │ ~2-3h                                                            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Total estimated effort:** 21–34 hours
**Critical path:** P2 → P3 → P9 (~10–16 hours)
**With full parallelism:** ~12–19 hours wall-clock time

---

## 4. Detailed Implementation Steps

---

### P1: Implement ESLint v9 Flat Config

**Priority:** HIGH | **Effort:** 1–2 hours | **Dependencies:** None

**Current State:**
- ESLint 9.0.0 is installed (`package.json` devDependency)
- `@typescript-eslint/eslint-plugin` ^8.0.0 and `@typescript-eslint/parser` ^8.0.0 installed
- Lint script exists: `"lint": "eslint packages/*/src/**/*.ts"`
- **No config file exists** — running `npm run lint` will fail or use defaults

**Steps:**
1. Create `/home/kali/orionomega/eslint.config.js` using ESLint v9 flat config format:
   ```js
   import eslint from '@eslint/js';
   import tseslint from 'typescript-eslint';

   export default tseslint.config(
     eslint.configs.recommended,
     ...tseslint.configs.recommended,
     {
       files: ['packages/*/src/**/*.ts'],
       languageOptions: {
         parserOptions: {
           project: './tsconfig.json',
         },
       },
       rules: {
         '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
         '@typescript-eslint/no-explicit-any': 'warn',
         '@typescript-eslint/no-require-imports': 'off',
       },
     },
     {
       ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs'],
     }
   );
   ```
2. Install `@eslint/js` and `typescript-eslint` if not already present
3. Run `npm run lint` and fix or suppress any critical errors
4. Verify lint passes cleanly (warnings OK, errors must be zero)

**Verification:** `npm run lint` exits 0

---

### P2: Set Up Test Framework (Vitest) and Base Config

**Priority:** HIGH | **Effort:** 2–3 hours | **Dependencies:** None

**Current State:**
- Root `package.json` has `"test": "npm run test --workspaces --if-present"`
- No test framework installed (no vitest, jest, mocha in deps)
- No `*.test.ts` or `*.spec.ts` files exist
- Only manual test: `test/ws-test.mjs`

**Steps:**
1. Install Vitest as a dev dependency:
   ```bash
   npm install -D vitest @vitest/coverage-v8
   ```
2. Create `/home/kali/orionomega/vitest.config.ts`:
   ```ts
   import { defineConfig } from 'vitest/config';

   export default defineConfig({
     test: {
       globals: true,
       environment: 'node',
       include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
       coverage: {
         provider: 'v8',
         reporter: ['text', 'lcov'],
         include: ['packages/*/src/**/*.ts'],
         exclude: ['**/*.test.ts', '**/dist/**'],
       },
     },
   });
   ```
3. Add test scripts to root `package.json`:
   ```json
   "test": "vitest run",
   "test:watch": "vitest",
   "test:coverage": "vitest run --coverage"
   ```
4. Create a trivial smoke test to validate setup:
   ```ts
   // packages/hindsight/src/client.test.ts
   import { describe, it, expect } from 'vitest';
   import { HindsightClient } from './client.js';

   describe('HindsightClient', () => {
     it('should instantiate with default config', () => {
       const client = new HindsightClient({ baseUrl: 'http://localhost:8888' });
       expect(client).toBeDefined();
       expect(client.connected).toBe(false);
     });
   });
   ```
5. Run `npm test` and verify output

**Verification:** `npm test` exits 0, smoke test passes

---

### P3: Write Unit Tests for Core Packages

**Priority:** HIGH | **Effort:** 6–10 hours | **Dependencies:** P2

**Target Packages (by priority):**

1. **`@orionomega/hindsight`** — HindsightClient (HTTP client, stateless, easy to mock)
   - Test `store()`, `recall()`, `banks()` with mocked fetch
   - Test `connected` / `busy` state transitions
   - Test `emitActivity()` callback firing
   - Test error handling (network failures, non-200 responses)

2. **`@orionomega/skills-sdk`** — Skill loading, validation, scaffolding
   - Test skill manifest parsing and validation
   - Test `scaffold.ts` template generation
   - Test skill registry operations

3. **`@orionomega/core`** — Agent intent classification, orchestration
   - Test `classifyIntent()` with mocked Anthropic client
   - Test `isFastConversational()` and `isOrchestrateRequest()` pattern matchers
   - Test DAG construction (`buildDAG`, `planDAG`)
   - Test MainAgent routing logic (CHAT vs CHAT_ASYNC vs ORCHESTRATE)

4. **`@orionomega/gateway`** — WebSocket handler, message routing
   - Test message serialization/deserialization
   - Test broadcast logic
   - Test health-check endpoint

**Recommended test count target:** 40–60 tests across packages

---

### P4: Write Unit Tests for TUI Components

**Priority:** MEDIUM | **Effort:** 4–6 hours | **Dependencies:** P2

**Components to Test:**
- `StatusBar` — status rendering, Hindsight indicator states, spinner lifecycle
- `WorkflowPanel` / `WorkflowBox` — node state rendering
- `LayerGroup` / `NodeDisplay` — DAG visualization
- `GatewayClient` — WebSocket message parsing, event emission

**Approach:**
- Mock `pi-tui` Container/Text primitives
- Test state updates and `updateDisplay()` output
- Test event handler wiring

---

### P5: Fix Hindsight Busy Status Wiring

**Priority:** HIGH | **Effort:** 1–2 hours | **Dependencies:** None

**Root Cause Identified:**

The wiring chain is: `HindsightClient.onActivity` → `MainAgent.callbacks.onHindsightActivity` → `Gateway.wsHandler.broadcast` → `TUI.statusBar`

However, there is a **competing signal** in `packages/gateway/src/server.ts` (lines 295-316):

```typescript
// Periodic health check — runs every 15 seconds
const hindsightHealthTimer = setInterval(async () => {
  // ...
  wsHandler.broadcast({
    type: 'hindsight_status',
    hindsightStatus: { connected, busy: false },  // ← ALWAYS false!
  }, 15_000);
}, 15_000);
```

This health-check broadcast **overwrites** the real `busy` status from `HindsightClient` every 15 seconds, resetting it to `false` even if the client is actively performing I/O.

**Fix Steps:**
1. **In `packages/gateway/src/server.ts`:** Track the last known busy state from MainAgent callbacks:
   ```typescript
   let lastHindsightBusy = false;

   // In the onHindsightActivity callback:
   onHindsightActivity(status) {
     lastHindsightBusy = status.busy;
     wsHandler.broadcast({ ... });
   }
   ```
2. **In the health-check interval:** Use tracked busy state instead of hardcoded `false`:
   ```typescript
   hindsightStatus: { connected, busy: lastHindsightBusy },
   ```
3. **Optional improvement:** Only broadcast from health-check when `connected` state actually changes (it already does this check, but the `busy` override is the bug).
4. **Test:** Trigger a Hindsight API call, verify TUI spinner activates and stays active for the duration of the operation.

**Verification:** TUI braille spinner appears during Hindsight I/O and stops when idle.

---

### P6: Remove Legacy WorkflowTracker Component

**Priority:** MEDIUM | **Effort:** 1 hour | **Dependencies:** None

**Current State:**
- `WorkflowTracker` and `MultiWorkflowTracker` defined in `packages/tui/src/components/workflow-tracker.ts` (lines 45-513)
- Superseded by `WorkflowPanel` in `packages/tui/src/components/workflow-panel.ts`
- Referenced in `MULTI_WORKFLOW_SPEC.md`

**Steps:**
1. Search all imports/references to `WorkflowTracker` and `MultiWorkflowTracker`:
   ```bash
   grep -rn "WorkflowTracker\|MultiWorkflowTracker" packages/
   ```
2. Remove or replace all imports with `WorkflowPanel` equivalents
3. Delete `packages/tui/src/components/workflow-tracker.ts`
4. Update `MULTI_WORKFLOW_SPEC.md` if it references the old component (mark as completed/superseded)
5. Build and verify: `npm run build`

**Verification:** Build succeeds, no references to `WorkflowTracker` remain in `packages/`

---

### P7: Investigate Workflow Runs Stopping Midway

**Priority:** CRITICAL | **Effort:** 2–4 hours | **Dependencies:** None

**Current State:**
- Async fire-and-forget pattern in `main-agent.ts` line 380:
  ```typescript
  void this.respondConversationally(trimmed).catch(...)
  ```
- Observed: workflow runs stop midway during sessions
- Root cause: unclear — could be unhandled rejection, timeout, or resource exhaustion

**Investigation Steps:**
1. **Add structured logging** to `respondConversationally()`:
   - Log entry with timestamp and message hash
   - Log exit (success) with duration
   - Log error with full stack trace
2. **Check for unhandled promise rejections** — ensure `.catch()` on line 380 actually handles all failure modes
3. **Check for resource leaks:**
   - Are there concurrent fire-and-forget calls that overlap?
   - Is there a queue/throttle mechanism? (If not, implement one)
4. **Check Anthropic API timeouts:**
   - What happens if the Claude API call in `respondConversationally()` takes >60s?
   - Is there an AbortController or timeout wrapper?
5. **Check DAG dispatch path** (`dispatchFullDAG`):
   - Does `return` on line 363 actually allow the DAG to continue?
   - Is the DAG lifecycle managed independently of the request handler?
6. **Add a simple heartbeat/progress log** to long-running operations
7. **Reproduce locally** — trigger a multi-step workflow and monitor logs

**Potential Fixes:**
- Add timeout wrapper to fire-and-forget calls
- Add concurrency limit (e.g., max 3 concurrent fire-and-forget operations)
- Ensure all async paths have proper error boundaries
- Add health monitoring / watchdog for stalled workflows

---

### P8: Verify Async Fire-and-Forget in Production

**Priority:** CRITICAL | **Effort:** 1–2 hours | **Dependencies:** P7, P10

**Steps:**
1. SSH into `10.0.0.42` (requires P10)
2. Deploy latest code with P7 fixes
3. Trigger test workflows:
   - Simple CHAT (should respond directly)
   - CHAT_ASYNC (should fire-and-forget and complete)
   - ORCHESTRATE (should build and execute DAG)
4. Monitor logs for completion vs stalling
5. Run 5-10 sequential test cases, verify 100% completion rate

**Verification:** All test workflows complete without stalling

---

### P9: Set Up GitHub Actions CI/CD Pipeline

**Priority:** HIGH | **Effort:** 2–3 hours | **Dependencies:** P1, P2 (P3 helpful but not blocking)

**Current State:**
- `.github/workflows/` directory does not exist
- No CI/CD configured at all
- Enterprise readiness assessment rates CI/CD at 1/5

**Steps:**
1. Create `.github/workflows/ci.yml`:
   ```yaml
   name: CI
   on:
     push:
       branches: [main, develop]
     pull_request:
       branches: [main]

   jobs:
     build-and-test:
       runs-on: ubuntu-latest
       strategy:
         matrix:
           node-version: [20.x, 22.x]
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: ${{ matrix.node-version }}
             cache: 'npm'
         - run: npm ci
         - run: npm run build
         - run: npm run lint
         - run: npm test
         - run: npm run test:coverage
         - uses: actions/upload-artifact@v4
           with:
             name: coverage-${{ matrix.node-version }}
             path: coverage/
   ```
2. Create `.github/workflows/pr-checks.yml` for PR-specific checks (optional)
3. Push to a feature branch and verify pipeline runs
4. Add branch protection rules requiring CI to pass

**Verification:** Green CI badge on push to main

---

### P10: Resolve SSH Access to Remote System `10.0.0.42`

**Priority:** MEDIUM | **Effort:** 0.5–1 hour | **Dependencies:** None (but blocks P8)

**Current State:**
- SSH auth error preventing connection
- Remote deployment status unknown

**Steps:**
1. Diagnose SSH error:
   ```bash
   ssh -vvv user@10.0.0.42
   ```
2. Common fixes:
   - Regenerate/copy SSH key: `ssh-copy-id user@10.0.0.42`
   - Check `~/.ssh/config` for correct key path
   - Verify remote `sshd_config` allows key auth
   - Check firewall rules on remote host
3. Once connected:
   - Verify `orionomega.service` status
   - Check running commit vs latest
   - Verify port 7800 is active

**Mitigation if unresolvable:** Test production behavior on local `10.0.0.9` deployment instead

---

## 5. Blockers & Mitigations

| Blocker | Affects | Mitigation |
|---------|---------|------------|
| SSH auth failure to `10.0.0.42` | P8 (prod verification) | Test on local `10.0.0.9` deployment instead; escalate SSH issue to infra |
| Zero test coverage | P9 (CI/CD is meaningless without tests) | Prioritize P2+P3 before P9 |
| No ESLint config | P9 (lint step will fail) | P1 must complete before P9 |
| Unknown root cause of workflow stalling | P8 (can't verify a fix without diagnosis) | P7 investigation must complete first; add logging even if root cause unclear |
| Gateway health-check overwriting busy status | P5 (Hindsight indicator non-functional) | Isolated fix, no external blockers |

---

## 6. Recommended Execution Order

### Sprint 1 (Day 1) — Foundation Layer
**Run in parallel:**
- `P1` ESLint v9 config (1–2h)
- `P2` Vitest setup (2–3h)
- `P5` Fix Hindsight busy wiring (1–2h)
- `P6` Remove WorkflowTracker (1h)
- `P10` Resolve SSH (0.5–1h)

**End-of-day gate:** ESLint passes, Vitest runs, Hindsight spinner works, WorkflowTracker gone

### Sprint 2 (Day 2) — Testing & Investigation
**Run in parallel:**
- `P3` Core unit tests (6–10h, may span into Day 3)
- `P4` TUI unit tests (4–6h)
- `P7` Investigate async stopping (2–4h)

**End-of-day gate:** 30+ tests passing, async stalling root cause identified

### Sprint 3 (Day 3) — Integration & Verification
**Sequential:**
- `P8` Verify async fire-and-forget in production (1–2h, needs P7 + P10)
- `P9` GitHub Actions CI/CD pipeline (2–3h, needs P1 + P2 + P3)

**End-of-day gate:** CI pipeline green, production verified

---

## 7. Progress Tracking

```
Layer 0:  P1[⬜]  P2[⬜]  P5[⬜]  P6[⬜]  P7[⬜]  P10[⬜]
Layer 1:  P3[⬜]  P4[⬜]  P8[⬜]
Layer 2:  P9[⬜]

Completed: 0/10 pending tasks
Overall:   5/15 total tasks (33%)
```

---

## 8. Enterprise Readiness Scorecard (Current → Target)

| Dimension | Current | Target | Key Task |
|-----------|---------|--------|----------|
| **Linting** | 0/5 (no config) | 4/5 | P1 |
| **Test Coverage** | 0/5 (0%) | 3/5 (60%+) | P2, P3, P4 |
| **CI/CD** | 0/5 (none) | 4/5 | P9 |
| **Code Hygiene** | 2/5 (dead code) | 4/5 | P6 |
| **Feature Complete** | 3/5 (wiring gap) | 4/5 | P5 |
| **Production Stability** | 2/5 (stalling) | 4/5 | P7, P8 |
| **Deployment** | 3/5 (local only) | 4/5 | P10 |
| **Overall** | **1.4/5** | **3.9/5** | All |

---

*Generated by OrionOmega Orchestration — Worker: execution-planner*

# Codebase Audit Plan

Generated: 2026-03-31
Branch: `audit/cleanup-2026-03-31`
Baseline LOC: 38,451
Stack: TypeScript monorepo (pnpm, 6 packages), Node.js >=22, Next.js 15

---

## Changes to Apply (in execution order)

### Pass 1: Dead Code Removal

Safe removals that eliminate confusion without changing behavior.

- [ ] **DC-01** `packages/core/src/agent/conversation.ts:169–173` — Remove deprecated `isFastTask()` wrapper; update all call sites to use `isOrchestrateRequest()` directly
- [ ] **DC-07** `packages/hindsight/src/client.ts:551–554` — Remove unreachable `else` branch; call `emitActivity()` unconditionally after the `if`
- [ ] **DC-09** `packages/web/src/components/chat/MessageBubble.tsx:21–29` — Inline `formatPlainText()` at its single call site (line 220)
- [ ] **DC-14** `packages/web/src/components/chat/ChatInput.tsx` — Verify `<ChatInput />` is rendered in `ChatPane.tsx`; remove import if unused
- [ ] **DC-03** `packages/core/src/anthropic/client.ts:1–10` — Audit all import sites for `@deprecated` client; delete file if no active call sites remain, otherwise remove `@deprecated` marker and document fallback paths
- [ ] **DC-13** `packages/skills-sdk/src/settings.ts:39–98` — Search all skill manifests for `setup.fields`; if none exist, remove `shimFieldsToSettings()` and `shimField()` shim code
- [ ] **DC-02** `packages/core/src/agent/conversation.ts:28–50` — Audit call sites of `isFastConversational`, `isOrchestrateRequest`; if LLM classifier handles all routing, remove `CONVERSATIONAL_FAST`, `ORCHESTRATE_FAST`, `GUARDED_PATTERNS` regex arrays
- [ ] **DC-12** `packages/tui/src/` — Grep all TUI component files for inline formatting logic (cost, duration, truncation) that duplicates `packages/tui/src/utils/format.ts`; replace with imports from the consolidated utility file
- [ ] **S-3** `packages/core/src/agent/` — Add deprecation notice to deprecated `agent-loop` module or delete if genuinely unused

### Pass 2: Consolidation & Deduplication

Extract shared utilities and eliminate copy-paste duplication. Ordered by number of affected files (widest impact first).

#### Cross-package utilities (create shared modules)

- [ ] **DUP-13 + DUP-22** Create `packages/core/src/utils/deep-merge.ts` — consolidate `deepMerge()` from `core/config/loader.ts:115–142` and `gateway/routes/config.ts:50–77`; export from core, import in gateway
- [ ] **DUP-21** Move `formatTokens()` and `formatElapsed()`/`formatElapsedMs()` to `packages/core/src/utils/format.ts` — remove duplicates from `packages/web/src/utils/format.ts` and `packages/tui/src/utils/format.ts`
- [ ] **DUP-12** Create `packages/core/src/utils/text.ts` with `truncate(text: string, maxLen: number): string` — replace inline implementations in `core/logging/logger.ts:154–159`, `core/agent/conversation.ts:217`, `core/anthropic/tools.ts:45–48`
- [ ] **DUP-15** Create `packages/core/src/utils/error.ts` with `classifyError(error: Error): 'transient'|'permanent'` — consolidate from `core/orchestration/executor.ts:74–82` and `core/agent/conversation.ts:566–595`

#### Gateway package deduplication

- [ ] **DUP-01** Extract `readBody()` from `gateway/routes/config.ts:33–48` and `gateway/routes/skills.ts:27–42` into `gateway/src/routes/utils.ts`
- [ ] **DUP-02** Extract `checkAuth()` from `gateway/routes/config.ts:228–256` and `gateway/routes/skills.ts:44–72` into `gateway/src/routes/auth-utils.ts`
- [ ] **DUP-03** Extract `validateBindAddress(bind, fieldName)` from `gateway/routes/config.ts:88–110` and `214–221`
- [ ] **DUP-04** Extract `checkHindsightHealth(): Promise<boolean>` from `gateway/server.ts:463–504` (duplicated between startup IIFE and periodic timer)
- [ ] **DUP-05** Extract `storeSessionMessage(sessionId, role, content, type, metadata)` from `gateway/websocket.ts:295–302` and `389–396`
- [ ] **DUP-06** Extract `sendRateLimitError(res, retryAfter)` from `gateway/rate-limit.ts:61–88` (three functions repeat the same 429 response block)
- [ ] **DUP-07** Extract `addToSessionArray<T>(array, item, maxSize, session)` from `gateway/sessions.ts:140–153` and `164–170`
- [ ] **DUP-08** Extract `loadAndDeduplicateSkills(dir, seen)` from `gateway/routes/skills.ts:74–123` (two identical discovery/dedup loops)
- [ ] **DUP-26** Extract `getFullContent(streaming, text)` from `gateway/server.ts:186,219` (duplicated in both branches of `workflowId` conditional)

#### Hindsight package deduplication

- [ ] **DUP-09** Extract `applyRelevanceFilter(results, minRelevance)` and `applyDeduplication(results, threshold)` as private methods on `hindsight/client.ts` (shared between `recall()` and `recallWithTemporalDiversity()` at lines 238–315, 454–459)
- [ ] **DUP-10** Extract `emitRecallIO(type, detail, meta)` helper from `hindsight/client.ts:329–372`
- [ ] **DUP-11** Extract `safeRecall<T>(fn, fallback, context)` from `hindsight/session-bootstrap.ts:145–157` (three methods share identical try/catch pattern)

#### Other package deduplication

- [ ] **DUP-14** Simplify `interpolateEnvVars()` in `core/config/loader.ts:158–175` — use a generic recursive tree walker
- [ ] **DUP-17** Consolidate `toolSignature()` and `toolCategory()` in `core/agent/conversation.ts:279–309` into single `analyzeToolCall(tool)` function
- [ ] **DUP-18** Extract `buildNodeState(node, layerMap, nodes)` from `tui/components/workflow-box.ts:141–182,204–223`
- [ ] **DUP-19** Extract `computeLayerStatus(nodes)` from `tui/components/workflow-box.ts:378–382,417–422`
- [ ] **DUP-20** Extract `createRegisteredTools(toolDefs, executor)` from `skills-sdk/loader.ts:173–175,287–296`
- [ ] **DUP-25** Extract `renderSection(label, value, color)` from `tui/components/status-bar.ts` (`updateDisplay()` inline section rendering)

### Pass 3: File Structure Reorganization

Verify repo hygiene and ensure no build artifacts are tracked.

- [ ] **S-1** Verify `.gitignore` properly excludes `packages/web/.next/`; if tracked, remove from git index with `git rm -r --cached`
- [ ] **S-2** Verify `node_modules/` is excluded at all package levels in `.gitignore`; clean index if tracked
- [ ] **DX-L3** Add `coverage/` to `.gitignore` (preparation for test framework)
- [ ] Ensure `packages/core/src/utils/` directory exists for new shared utilities created in Pass 2

### Pass 4: Pattern Standardization

Fix inconsistent patterns. Ordered by safety (purely additive changes first, behavior-affecting changes last).

#### Logging & error visibility (safe — adds logging where none exists)

- [ ] **P-9** Document and enforce logging tiers across all packages: `error` = unrecoverable, `warn` = recoverable issue, `info` = lifecycle milestone, `verbose` = operational detail
- [ ] **P-3** `packages/web/src/lib/gateway.ts:578` — Replace `.catch(() => {})` with `.catch(err => { log.warn('gateway reconnect error', { error: err }); })`

#### TypeScript type safety (safe — tightens types)

- [ ] **P-5** `packages/gateway/src/server.ts:262,822,824` — Replace `(plan as any)?.graph` with typed `PlanGraph` interface; remove `as any` casts

#### Complexity reduction (safe extractions)

- [ ] **CPX-05** `packages/core/src/agent/memory-bridge.ts:154–171` — Move hardcoded bootstrap thresholds into `MemoryBootstrapConfig` interface; extract `MemoryComponentFactory`
- [ ] **CPX-07** `packages/core/src/anthropic/tools.ts:81–117` — Extract `formatToolError(e)` and `assembleToolOutput(stdout, stderr, maxLen)` from exec tool handler
- [ ] **CPX-09** `packages/core/src/memory/context-assembler.ts:656–694` — Extract `MarkerClassifier` with `categorize(line)` method; replace 4 regex conditionals in `buildCausalChain()`
- [ ] **CPX-21** `packages/hindsight/src/session-bootstrap.ts:203–227` — Extract `filterAnchorResults()` and `sortByTimestamp()` from `recallSessionAnchor()`
- [ ] **CPX-22** `packages/hindsight/src/mental-models.ts:80–105` — Extract `shouldRefresh(key, lastRefreshAt)` and `refreshModelSafely(model)` from `onRetain()` loop
- [ ] **CPX-25** `packages/hindsight/src/similarity.ts:51–86` — Extract `computeKeywordScore(query, text)`; add comment documenting weighting formula
- [ ] **CPX-26** `packages/skills-sdk/src/loader.ts:348–394` — Extract `matchByCriteria(manifests, query, strategy)` from `matchSkills()`
- [ ] **CPX-27** `packages/skills-sdk/src/settings.ts:203–270` — Extract `checkStringConstraints()` and `checkNumberConstraints()` from `checkConstraints()`
- [ ] **CPX-28** `packages/tui/src/components/chat-log.ts:89–188` — Extract `renderModelUsageTable()`, `renderArtifacts()`, `renderStatusLine()` from `addRunStats()`
- [ ] **CPX-34** `packages/web/src/components/chat/MessageBubble.tsx:88–229` — Extract per-type components: `<DAGDispatchedMessage>`, `<DAGConfirmationMessage>`, `<ToolCallMessage>`, etc.
- [ ] **CPX-36** `packages/tui/src/components/workflow-panel.ts:118–157` — Replace `getAggregateStats()` for-loop with `.reduce()`

### Pass 5: Documentation

- [ ] **DOC-H1** Add `README.md` to each of 6 packages (`core`, `gateway`, `hindsight`, `skills-sdk`, `tui`, `web`) — purpose, key exports, usage example
- [ ] **DOC-M1** Add `config.example.yaml` at repo root documenting all supported configuration keys
- [ ] **DOC-L2** Move `docs/mobile-optimization-plan.md` content behind a `[DRAFT]` marker or move to internal planning location
- [ ] **DOC-L1** Add `CHANGELOG.md` at repo root with initial `0.1.0` entry

### Pass 6: DX & Repo Polish

- [ ] **DX-M1** Add Prettier config (`.prettierrc.json`) and root `"format"` script
- [ ] **DX-L1** Add `.editorconfig` — standardize indent (2 spaces), line endings (LF), trailing whitespace trimming
- [ ] **DX-M2** Add Husky + lint-staged — run `eslint --fix` + `prettier --write` on pre-commit
- [ ] **DX-M3** Upgrade ESLint rules from `warn` to `error` for `no-explicit-any`, `ban-ts-comment`, `no-non-null-assertion` in `eslint.config.js:22–36`
- [ ] **DX-L2** Add `dev` watch scripts to `packages/core`, `packages/hindsight`, `packages/skills-sdk` (currently missing)

---

## Deferred (requires human review)

Items that change runtime behavior, require extensive testing, or involve architectural decisions that need team consensus. See `AUDIT-DEFERRED.md` for full details.

### Security (changes runtime behavior — all need testing)

- [ ] **SEC-1** `gateway/routes/config.ts:284` — Add try/catch around `JSON.parse(body)`; return HTTP 400 on parse failure
- [ ] **SEC-2** `gateway/websocket.ts:24` — Ensure `validateClientMessage()` return value is checked on ALL call paths before message processing
- [ ] **SEC-3** `gateway/sessions.ts:309` — Add max-length to session ID regex: `/^[a-z0-9_-]{1,64}$/`
- [ ] **SEC-4** `gateway/auth.ts:114–118` — Deprecate legacy SHA-256 password hashes; enforce scrypt/argon2 only
- [ ] **SEC-5** `gateway/server.ts:129` — Remove `process.env.ANTHROPIC_API_KEY` fallback; require explicit config
- [ ] **SEC-6** `core/orchestration/executor.ts:23–35` — Replace env var blacklist (`SENSITIVE_ENV_PATTERNS`) with explicit allowlist
- [ ] **SEC-7** `hindsight/client.ts:65` — Remove `process.env.HINDSIGHT_API_KEY` fallback; require explicit config
- [ ] **SEC-8** `gateway/rate-limit.ts:134` — Fix auth cooldown reset-before-threshold logic
- [ ] **SEC-9** `gateway/websocket.ts` — Add per-connection WebSocket message rate limiting
- [ ] **SEC-10** `core/commands/gateway.ts:73` — Replace empty `catch {}` with error logging + re-throw

### Empty catch blocks (changes error visibility — needs testing)

- [ ] **P-1** `gateway/routes/skills.ts:85,104,119` — Replace 3 empty `catch {}` blocks with `catch (err) { log.warn(...) }`
- [ ] **P-2** `tui/index.ts:64,110,262,576,638–640` — Replace 6 empty `catch {}` blocks with error logging
- [ ] **P-10** `gateway/routes/config.ts:284` — Add try/catch around `JSON.parse(body)` (overlaps SEC-1)

### Type safety (may surface hidden type errors)

- [ ] **P-4** `tui/components/layer-group.ts:53,80,88` — Replace `(this as any).children` with properly typed property
- [ ] **P-6** `tui/components/plan-overlay.ts:59,86` — Replace `nodes.get(nodeId) as any` with typed Map
- [ ] **P-7** Cross-package — Standardize `tokens_used` vs `tokensUsed` naming; enforce conversion at Hindsight client boundary only
- [ ] **P-11** `gateway/routes/*.ts` — Add Zod validation to all REST route request bodies (currently unvalidated casts)

### Major refactors (need test coverage first)

- [ ] **CPX-01** `core/agent/main-agent.ts` (1,251 lines) — Decompose into `MainAgentInitializer`, `CommandRouter`, `CheckpointCoordinator`, `SessionLifecycle`
- [ ] **CPX-02** `core/agent/conversation.ts:316–604` — Extract `ToolExecutionManager` and `TokenBudgetManager` from 288-line `streamConversation()`
- [ ] **CPX-10** `core/orchestration/executor.ts` (1,532 lines) — Decompose into `LayerExecutor`, `LoopExecutor`, `NodeStateMachine`
- [ ] **CPX-12** `core/orchestration/types.ts:1–347` — Separate API input types from internal execution types
- [ ] **DC-06** `gateway/types.ts:49–127` — Convert `ServerMessage` to discriminated union with literal `type` field

### Needs investigation

- [ ] **DC-04** `core/memory/context-assembler.ts:248–301` — Fix missing braces on `external_action` conditional; verify `emitMemoryEvent` behavior
- [ ] **DC-05** `gateway/websocket.ts:306–310` — Verify redundant `ack` send can be safely removed (client behavior unknown)
- [ ] **DC-08** `web/lib/gateway.ts:25–36` — Verify `statusFromToolCall()` is redundant with DAG progress events
- [ ] **DC-10** `hindsight/client.ts:123–141` — Investigate lighter API for duplicate content check
- [ ] **DC-11** `gateway/sessions.ts` — Extract `modifySessionCollection()` generic helper (needs testing of session lifecycle)
- [ ] **DUP-16** `core/memory` + `agent/conversation.ts` — Build unified `PatternMatcher` for `HIGH_SIGNAL_PATTERNS`/`LOW_SIGNAL_PATTERNS`
- [ ] **DUP-24** `core/orchestration/planner.ts:51–150` — Ensure model discovery delegates to `model-discovery.ts` (needs-testing)
- [ ] **DUP-23** Cross-package — Shared WebSocket message dispatcher pattern (long-term)
- [ ] **CPX-23** `hindsight/bank-manager.ts:47–66` — Switch `ensureProjectBank()` to optimistic create + catch 409
- [ ] **CPX-24** `hindsight/self-knowledge.ts:71–91` — Batch `isDuplicateContent()` checks if API supports it
- [ ] **P-8** Cross-package — Consolidate scattered config types and defaults into single config loader
- [ ] **P-12** `skills-sdk/validator.ts` — Migrate manifest validation from manual checks to Zod schema

### Medium complexity refactors (needs testing)

- [ ] **CPX-03** `core/agent/orchestration-bridge.ts:644–730` — Extract section formatters from `onExecutionComplete()`
- [ ] **CPX-04** `core/agent/orchestration-bridge.ts:177–216` — Extract `recallMemoriesForPlanning()` and `resolveConfirmationFlow()` from `dispatchFullDAG()`
- [ ] **CPX-06** `core/anthropic/agent-loop.ts:139–279` — Extract `TokenBudgetManager`, `ToolExecutor`, `StreamingAssembler` from `runAgentLoop()`
- [ ] **CPX-08** `core/memory/context-assembler.ts:221–328` — Apply Strategy pattern to `assemble()`
- [ ] **CPX-11** `core/orchestration/planner.ts:51–150` — Extract `ModelSelector`, `PlanningPromptBuilder`, `PlanParser` from `plan()`
- [ ] **CPX-13** `gateway/server.ts:164–237` — Extract `handleWorkflowText()` and `handleDefaultText()` from `onText` callback
- [ ] **CPX-14** `gateway/server.ts:450–630` — Break `handleRequest` into route-group setup functions
- [ ] **CPX-15** `gateway/routes/config.ts:79–226` — Break `validateConfig()` into per-section validators
- [ ] **CPX-16** `gateway/websocket.ts:156–189` — Batch 5 sequential welcome messages into single `welcome` message
- [ ] **CPX-17** `gateway/websocket.ts:219–282` — Extract `parseClientMessage()` + per-type handler functions from `handleMessage()`
- [ ] **CPX-18** `hindsight/client.ts:163–373` — Break `recall()` into `fixZeroRelevance()`, `filterByRelevance()`, `deduplicateResults()`, `emitRecallIO()`
- [ ] **CPX-19** `hindsight/client.ts:547–590` — Extract `handleFetchError()`, `handleHttpError()`, `parseResponse()` from `request()`
- [ ] **CPX-20** `hindsight/session-bootstrap.ts:51–74` — Fix `Promise.all` tuple destructuring with named keys
- [ ] **CPX-29** `tui/components/node-display.ts:228–278` — Replace switch in `rebuild()` with status-keyed lookup table
- [ ] **CPX-30** `tui/gateway-client.ts:283–432` — Extract 18-case switch in `handleMessage()` to named handler methods
- [ ] **CPX-31** `tui/index.ts:479–630` — Extract `handlePlanResponse()` and `handleUserMessage()` from `onSubmit` handler
- [ ] **CPX-32** `web/lib/gateway.ts:257–558` — Extract `ws.onmessage` cases to named handlers with `MESSAGE_HANDLERS` dispatch map
- [ ] **CPX-33** `web/lib/gateway.ts:115–238` — Extract `deduplicateByDAGKey()`, `deduplicateByContent()`, `deduplicateByTimestamp()`
- [ ] **CPX-35** `web/components/chat/ChatPane.tsx:34–75` — Replace while-loop `buildRenderItems()` with `Array.reduce()`

### Test infrastructure (prerequisite for many deferred items)

- [ ] **DOC-H3 / DX-H1** Install test framework (Vitest), configure, add `test` scripts to all 6 packages
- [ ] **DX-L4** Add GitHub Actions CI — lint + typecheck + build + test on PRs
- [ ] **DOC-H2** Add JSDoc to public APIs — prioritize `core/orchestration/`, `gateway/src/`, `core/memory/`

---

## Statistics

| Category | Pass 1–6 (safe) | Deferred | Total |
|----------|-----------------|----------|-------|
| Dead Code | 9 | 5 | 14 |
| Duplication | 22 | 4 | 26 |
| Complexity | 11 | 25 | 36 |
| Structure | 4 | 0 | 4 |
| Patterns | 3 | 9 | 12 |
| Security | 0 | 10 | 10 |
| Documentation | 4 | 3 | 7 |
| DX | 5 | 2 | 7 |
| **Total** | **58** | **58** | **116** |

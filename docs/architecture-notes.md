# OrionOmega — Detailed Architecture Notes

This file holds the in-depth architecture-decision and task-history notes that used to live in `replit.md`. The README keeps only Run/Stack/Where-things-live/Gotchas; everything else lives here.

## Claude Agent SDK version (Task #228)

`@anthropic-ai/claude-agent-sdk` is pinned at **`^0.3.172`** in `packages/core/package.json` (R1 / 4.2-P0). The bump from the previous `^0.3.165` unblocks running Opus 4.8 + Fable 5 through the SDK.

**What 0.3.170–0.3.172 changed (relevant to OrionOmega):**
- **Fable 5 model support.** The SDK's model union now recognises the `fable` alias and the `claude-fable-5` full model ID (added in 0.3.170), alongside existing aliases (`opus`, `sonnet`, `haiku`) and full IDs (`claude-sonnet-4-6`, `claude-opus-4-8`). The bridge passes `model` as a plain `string` into `query()` options, so these new identifiers type-check without any code change — they flow through the existing `discoverModels`/`coerceModel` validation pipeline at plan time.
- **`skipMcpDiscovery` plugin option.** SDK plugin configs now accept `skipMcpDiscovery?: boolean`. OrionOmega does not set it today; noted here so a future MCP-discovery-skipping optimisation knows the field exists.

**Verification done for the bump:** `packages/core` builds clean (`tsc`), the full monorepo typecheck (`tsc --build`) passes, and the core test suite is green (743 tests). No source changes were required — the SDK upgrade is purely a dependency/lockfile bump because the bridge already treats `model` as an open `string`.

**Out of scope (separate tasks):** the model capability registry (R2) and any Fable 5 routing/fallback behaviour.

## Native multi-agent sessions as a sub-DAG substrate — pilot (Task #240 / R3)

A scoped pilot that lets ONE eligible sub-DAG layer run via a single Anthropic **native multi-agent session** (a coordinator query with an `agents` roster) instead of OrionOmega's in-house per-node dispatch. It is **OFF by default** and changes nothing on the common path.

**Config flag.** `agentSdk.nativeSessions?: { enabled?: boolean; maxAgentsPerLayer?: number }`. `getDefaultConfig()` seeds `{ enabled: false, maxAgentsPerLayer: 8 }`. `resolveNativeSessionConfig` normalises a missing block to disabled and clamps the cap to `>= 1` so a misconfigured `0` can't silently disable every layer.

```yaml
agentSdk:
  nativeSessions:
    enabled: false        # pilot — leave off; set true to route eligible layers natively
    maxAgentsPerLayer: 8   # layers larger than this fall back to per-node dispatch
```

**Where it lives.** All substrate logic is in `packages/core/src/orchestration/native-session-substrate.ts` (pure helpers + one SDK-touching dispatch). The executor wires it in behind the flag: `executor.ts` `execute()` evaluates `evaluateLayerEligibility` before the default `Promise.allSettled`, and `executeLayerViaNativeSession()` runs the native path and returns results in the **same** `PromiseSettledResult<WorkerResult>[]` shape, so the downstream processing loop, checkpointing and artifact model are untouched.

**Eligibility (conservative).** A layer is eligible iff: the flag is on; it has `>= 2` runnable nodes (a single node gains nothing from a coordinator); every node is a `CODING_AGENT` (the only node type the substrate models); and the count is `<= maxAgentsPerLayer`. Anything it can't model cleanly (mixed types, oversized, single-node) falls back to the in-house path. The pilot is scoped to the **first** eligible layer per workflow via the `nativeSessionUsed` guard — subsequent eligible layers use the normal path.

**Context isolation.** `buildAgentRoster` emits one `AgentDefinition` per node; `buildCoordinatorPrompt` instructs the coordinator to fan each independent task out to its named subagent via the Task tool (never doing the work in the main thread), so each node runs in its **own** isolated subagent context over a shared sandbox cwd. This is the native equivalent of our per-node context separation, but provided by the platform.

**Persistent follow-ups.** The dispatch fires `query()` with `persistSession: true` and captures the `session_id`. `submitNativeSessionFollowUp` resumes that exact thread (`resume: sessionId`) — demonstrating the platform retains what each subagent did without OrionOmega re-supplying context. The session id is surfaced in `ExecutionResult.nativeSessions` and `run-summary.md`.

**Result mapping + fail-closed.** The coordinator must emit one fenced JSON `results[]` report (`{ nodeId, status, summary, outputPaths }`). `parseCoordinatorReport` extracts the last `results`-bearing JSON block and maps it onto the expected node ids; **any** node missing from the report — or an unparseable report — is marked `error` so the executor's normal error path handles it, never a silent success. Aggregate token usage / cost from the single shared session is split across the nodes (cost attributed once, tokens floor-split with remainder on the first node) so per-model cost aggregation stays correct without double-counting.

**Ownership decision (retries / budgets / checkpointing across the hybrid).** The executor — **not** the platform — remains the system of record:
- **Retries.** OrionOmega owns retry/fallback. The native path runs the layer **once**; a node the coordinator marks failed comes back as a rejected settled result and re-enters the executor's existing retry/replan/model-fallback machinery. Per-node *retry within* a native session is intentionally **out of scope** for the pilot — mixing the SDK's internal turn loop with our retry policy would create two competing controllers. Documented tradeoff: a transient subagent failure costs a full executor-level retry rather than a cheap in-session one.
- **Budgets.** `agentSdk.maxBudgetUsd` is passed through to the session, but the executor's own cost aggregation and burn-rate accounting stay authoritative (cost is read back from the session result and folded into `modelUsage`/`totalCostUsd` exactly like the per-node path).
- **Checkpointing.** Unchanged and executor-owned. Because the native path returns the standard settled-result shape, the post-layer checkpoint write, artifact scan and `run-summary.md` rendering all run as before — there is no SDK-side checkpoint we depend on.
- **Failure of the whole session.** A hard throw from `executeNativeSessionLayer` (or a missing API key) fails every node in the layer via rejected results; the executor records and handles it. The substrate never throws past the executor boundary on a per-node basis.

**Build-vs-adopt recommendation.** *Adopt the native session as a substrate, keep the orchestrator as the controller.* The pilot shows the platform's coordinator + subagent roster gives us context isolation and persistent threads for free, which is genuinely better than re-implementing them. But retries, budgets, checkpointing, artifacts and cross-layer DAG semantics are OrionOmega's differentiators and must stay in-house — the native session is the right tool for *intra-layer fan-out of independent coding tasks*, not for whole-workflow orchestration. Recommended next steps before widening past the pilot: (1) richer per-node result extraction (today we lean on the coordinator's JSON summary rather than structured per-subagent telemetry); (2) a decision on in-session retry once the SDK exposes per-subagent restart; (3) lifting the single-layer scope once budget/cost attribution from multi-agent sessions is validated against real runs. Until then the flag stays off by default.

**Tests.** `native-session-substrate.test.ts` covers eligibility gating (flag off, single node, mixed types, oversize, happy path), roster build (one agent per node, name sanitisation, tools/model pass-through), coordinator-report parsing (happy, fenced-block extraction, fail-closed on missing node / unparseable), result mapping + token splitting via an injected fake `queryFn`, and the persistent follow-up resume path. The flag-off invariant (eligibility returns false → executor untouched) is asserted directly.

## Native context editing on agent queries (R4 / 4.3-P1)

For unattended long runs, context exhaustion is a real failure mode. Anthropic's **native context editing** auto-trims stale tool calls/results as the context window fills, preserving conversation flow so a run continues instead of degrading or hard-failing. The Agent SDK surfaces this as conversation **auto-compaction**: the SDK `Settings` interface exposes `autoCompactEnabled` (master switch) and `autoCompactWindow` (post-compaction token window the SDK keeps). Both are passed through the `query()` `settings` option.

**Wiring.** `buildContextEditingSettings(sdkConfig)` in `agent-sdk-bridge.ts` resolves a `Settings` fragment from the `agentSdk.contextEditing` config and is spread into the `settings` option of **both** SDK query paths — `executeAgent` (AGENT nodes) and `executeCodingAgent` (CODING_AGENT nodes). These are exactly the long-running orchestration nodes that benefit, and the only two code paths that reach the SDK. The coding path already passes `settingSources: ['project']`; `settings` is a separate, higher-priority "flag settings" layer, so the two coexist.

**Defaults & config.** On by default — `getDefaultConfig()` seeds `agentSdk.contextEditing = { enabled: true }`. The helper defaults `enabled` to `true` when the block (or the field) is absent, so existing on-disk configs that predate this key get context editing automatically via the defaults merge. The fragment is **always emitted explicitly**: `enabled: false` yields `{ autoCompactEnabled: false }` (provably off, not merely omitted). An optional `autoCompactWindow` override is only applied when editing is enabled and the value is a positive number; otherwise the SDK's own tuned default is used.

```yaml
agentSdk:
  contextEditing:
    enabled: true          # set false to disable native context editing
    autoCompactWindow: 50000  # optional; omit to use the SDK default
```

**Interaction with timeout floors.** This pairs directly with the executor's per-node wall-clock timeout floors (`TIMEOUT_FLOOR_SEC` in `executor.ts`: AGENT 900s, CODING_AGENT 1800s). The floors guarantee a run gets enough wall-clock budget to make progress; context editing guarantees the *context window* doesn't fill before that budget is spent. Without auto-trimming, a long CODING_AGENT loop could exhaust context well before its timeout; together they let long unattended runs run to completion.

**Tests.** `buildContextEditingSettings` is a pure function unit-tested in `agent-sdk-bridge-opus-48.test.ts`: default-on, explicit-on, disabling turns it off (`autoCompactEnabled: false`), window pass-through, and non-positive/disabled window dropping.

## Hindsight hybrid recall, fast dedup, cross-project lessons, and the native-memory boundary (Task #241)

> **Superseded — historical record.** This section describes Task #241 as it was
> built. The memory system was subsequently rebuilt on self-hosted Redis and
> Hindsight was removed entirely, taking with it banks, mental models, the
> hybrid vector channel, and `LessonsRollup`. Retrieval is now lexical-only and
> spans every scope in one in-process index, which is precisely why the rollup
> is no longer needed. Only the dedup pre-filter survives, in
> `@orionomega/shared`. Kept here as a record of what was decided and why; see
> [memory-architecture-v2.md](memory-architecture-v2.md) for the current design.

**Hybrid lexical+vector recall.** Hindsight servers in the v0.4.x line without an embedding backend return `relevance=0` for every recalled memory. The client already detected this all-zero case and re-scored results with a lexical proxy (`computeClientRelevance`: trigram overlap + keyword Jaccard). Task #241 adds an *optional* vector channel: pass an `EmbeddingProvider` (and optional `vectorWeight`, default 0.5) to `HindsightClientOptions`. In the all-zero fallback path the client batch-embeds `[query, ...contents]`, computes a per-result cosine, and blends it with the lexical score via `combineRelevance` (`lexical*(1-w) + max(0,cos)*w`, clamped to [0,1]; negative cosine is "no signal", not a penalty). Synonym/paraphrase matches that share few literal trigrams now surface. The blend is engaged **only** in the client-side fallback — when the server returns real relevance scores, embeddings are never invoked. Failure handling is defensive: an embedding throw or a batch-size mismatch logs a warning and degrades to lexical-only; the recall never throws because embeddings were unavailable. `localEmbedding` is a deterministic, dependency-free signed-feature-hashed vector (L2-normalised); it is a *lexical* vector — robust to word order/structural noise but **not** semantic (it won't capture synonyms) — provided as a drop-in so the pipeline behaves consistently with or without a real provider wired up. `client.vectorRecallEnabled` reports whether a provider is configured.

**Dedup pre-filter (bloom + size-blocked trigram).** Naive dedup over a large ingest is O(n²) trigram comparisons. The optimisation precomputes a `TrigramProfile` (normalised text + trigram set) per item once, then prunes candidate pairs two ways before doing the expensive set-overlap: (1) an **admissible size-ratio gate** — for a Jaccard-style trigram similarity `s = |A∩B| / |A∪B|`, a hard upper bound is `min(|A|,|B|) / max(|A|,|B|)`, so any pair whose trigram-set sizes differ by more than the threshold allows *cannot* reach it and is skipped without a false negative; (2) a **bloom-gated exact-fingerprint fast path** for exact-content repeats (similarity 1, always ≥ threshold) so huge ingests don't pay an exact-Set memory cost. The critical invariant, enforced by property tests against a brute-force reference on randomised corpora across thresholds: **the pre-filtered output is byte-for-byte identical to the naive O(n²) scan** — this is a speedup, never a behaviour change. `BloomFilter` guarantees no false negatives (an added key always reports present) with a bounded false-positive rate. `DedupIndex` packages the same bloom+blocking as a streaming "is this a near-duplicate of anything seen so far?" structure for `isDuplicateContent`-style hot loops and across-pass dedup.

**Cross-project lessons rollup.** Project banks (`project-*`) accumulate lessons in isolation, so an insight learned in one project is invisible to the next. `LessonsRollup` (in `packages/hindsight/src/lessons-rollup.ts`) periodically promotes high-signal lessons up into the shared `core` bank. A pass: lists banks, filters to `project-*` (never `core`, never empty), seeds a `DedupIndex` from lessons already in `core` (so we never re-promote a near-duplicate, and we dedup across project banks *within the same pass*), then for each project bank pulls memories whose context is a lesson (`lesson`/`decision` by default) and long enough to be worth keeping, and `retain`s the survivors into `core` with context `lesson`, tags `source:<bank>` + `cross-project-rollup`, and a **stable `document_id` derived from a content hash** so repeated rollups upsert rather than duplicate (idempotent). A failed bank scan or promotion is recorded in the result's `errors[]` and the pass continues. `start(intervalMs)` runs it periodically on an `unref`'d timer (min 60s) so it never keeps the process alive; `stop()` clears it. The engine is wired **defensively** into `MemoryBridge.init()` behind a `typeof LessonsRollup === 'function'` guard so test doubles of `@orionomega/hindsight` that omit the export don't break init; the interval is overridable via `ORIONOMEGA_LESSONS_ROLLUP_MS` (default 6h).

**Boundary: Hindsight vs. Anthropic-native memory.** These are complementary layers, not competitors, and the split is deliberate:

- **Anthropic-native memory** (model/SDK-side: the context window, prompt caching, and SDK thinking/effort budgeting) is *intra-session, ephemeral, and model-managed*. It governs what the model can attend to *right now* within one run. We do not persist application knowledge there; it is reconstructed every turn and is bounded by the token budget.
- **Hindsight** is *cross-session, durable, and application-managed*. It is the long-term substrate: project-scoped banks for per-project knowledge, the shared `core` bank for cross-project lessons (fed by the rollup above), mental models, and session anchors. It owns retrieval (recall + the hybrid scoring above), retention policy/TTL, dedup, and federation across banks.

The contract between them: Hindsight **recalls** a bounded, relevance-ranked, deduplicated, token-budgeted slice of durable memory, and the bridge **injects** that slice into the model's native context at session bootstrap and on demand. Hindsight decides *what is worth remembering across time and how to find it*; native memory decides *what the model reasons over in the moment*. Embeddings/vector recall live on the Hindsight side because relevance ranking is a retrieval concern, not a generation concern — keeping it there means the boundary holds regardless of which model or SDK version is in use (see the model-constraint notes in agent memory for why we avoid coupling durable behaviour to SDK-version-specific knobs).

## Persistent distributed task queue + checkpoint-as-source-of-truth (Task #238, R5)

**Goal.** Make a run survive a worker-process restart and resume from its checkpoint *without re-running completed nodes*, while keeping local dev zero-setup. Two pieces: a pluggable dispatch **queue** and a **checkpoint store** that is authoritative for graph/node state.

**Queue abstraction (`packages/core/src/orchestration/queue/`).** `task-queue.ts` defines the seam: a `TaskQueue` exposes `dispatchLayer(jobs, runner, onSettled)` + `close()`, where `NodeJob` carries `{ nodeId, layerIndex, ... }`, `NodeRunner` actually executes one node and returns a `NodeRunOutcome`, and `NodeSettledHandler` is invoked **once per node as it settles** (success or failure) so the executor can persist node-level progress immediately rather than only at end-of-layer. Two implementations behind `createTaskQueue(config)`:
- `in-process-queue.ts` — the **default**, zero-dependency, single-process queue. Runs each layer's jobs with bounded concurrency in the current process. This is what every test and every local/dev run uses; no Redis, no external infra.
- `redis-queue.ts` — a **BullMQ-backed** queue for true cross-process durability. BullMQ + ioredis are `optionalDependencies`; the module loads them via a **dynamic import behind a `const moduleName = 'bullmq'` indirection** so TypeScript never statically resolves them and the package builds/typechecks with the optional deps absent. If `backend: 'redis'` is configured but the deps aren't installed (or Redis is unreachable), `createTaskQueue` logs and **degrades to in-process** rather than crashing the run.

**Config.** `orchestration.queue` (in `config/types.ts`, defaulted in `getDefaultConfig()`): `backend` (`'in-process'` default | `'redis'`), `redisUrl` (falls back to the `REDIS_URL` env var), `queueName` (default `orionomega-nodes`), `concurrency` (default 8). The factory redacts credentials from the URL before logging (`redactUrl`).

**Per-workflow queue scoping (bridge).** `OrchestrationBridge.buildTaskQueue(workflowId)` returns `undefined` for the in-process default (the executor then builds its own zero-setup queue) and, only when `backend === 'redis'`, a queue whose name is scoped `"<queueName>:<workflowId>"` so concurrent runs never consume each other's node jobs from a shared Redis queue. It is injected into `ExecutorConfig.taskQueue` from `executePlan`.

**Checkpoint as source of truth (executor).** The in-memory maps (`nodeOutputs`, `nodeErrors`, `skippedNodes`) used to be the *only* holder of run state, so a fresh executor after a restart had amnesia. Now:
- On construct, `rehydrateFromState()` walks the graph and rebuilds those maps from each node's persisted `status`/`output`/`error`. For `done` nodes it repopulates **both** the in-process cache **and** `WorkflowState` (`setNodeOutput`) when the latter is missing the entry, so downstream nodes can read upstream outputs via `state.getNodeOutput()` after a resume — the checkpoint, not a lost in-memory map, is the source of truth. Idempotent and a no-op for a fresh run (all nodes `pending`).
- The dispatch loop routes each layer through `queue.dispatchLayer(jobs, runner, onSettled)`; `onSettled` processes the node's outcome and **saves the checkpoint per-node**, so a crash mid-layer still leaves every already-settled node durably recorded. The `finally` block always `close()`s the queue.
- Resume reuses the existing bridge path: `CheckpointManager.graphFromCheckpoint` → `WorkflowState.restore` (best-effort) → `new GraphExecutor(graph, bus, config, restoredState)` → `execute(checkpoint.currentLayer)`. `LayerScheduler.computeRunnableNodes` already skips `done` nodes, so completed work is never re-run.

**Tests.** `queue/__tests__/in-process-queue.test.ts` covers enqueue/dispatch, `onSettled` ordering, and error propagation. `__tests__/executor-resume.test.ts` proves the headline invariant **without an API key or Redis**: nodes are hermetic `bash` TOOL nodes that append a line to a per-node tally file, so line-counting reveals exactly how many times each node ran. A fake queue runs layer 0 for real, snapshots the on-disk checkpoint, then throws to simulate a hard worker crash before layer 1 dispatches; a second, default (in-process) executor reconstructed from that snapshot resumes and finishes `b`/`c` while the already-`done` `a` shows a tally of exactly 1 — i.e. completed nodes are not re-run.

## Hierarchical macro planning for very large coding specs (Task #197)

**Motivation.** Single-pass coding-mode planning fails with `stop_reason=max_tokens` on very large multi-phase specs (the canonical case is the Cannabis MSO Legal Operations Platform: ~150KB combined / 17 phases). The planner's tool output simply cannot fit one CODING_AGENT per phase plus all per-phase context inside Anthropic's max output budget.

**Fix.** Two-level planning. The macro planner emits one `MACRO_NODE` placeholder per spec phase; the executor invokes a per-phase sub-planner at run-time and splices the resulting sub-DAG into the live graph.

**Auto-gating** (`packages/core/src/agent/spec-loader.ts`):
- `shouldUseMacroPlanning(specs)` flips to macro mode at any of: combined contents ≥ 80KB / total phases ≥ 8 / any single phase body ≥ 12KB.
- `assertMacroPlanFeasible(specs)` runs immediately afterwards in `coding-dispatch.ts` and throws an actionable "Input too large for hierarchical planning — split the spec" error when total phases exceed `MACRO_PLAN_MAX_PHASES` (40). This is the input-layer rejection — `ExecutorConfig.macroMaxExpansions` (40) and `macroMaxTotalNodes` (200) are mid-execution last-resort caps.

**Macro plan output is small by construction.** The `MACRO_NODE` schema is `additionalProperties: false` with only `{specRef, phaseId, phaseTitle, phaseDependsOn}` — the model **cannot** echo phase bodies back into its tool output even if instructed to. The renderer (`renderSpecMacroPreambleBlock`) lists each phase by id/title/complexity/dependsOn but never inlines the body.

**Sub-planning** (`Planner.subPlan` in `packages/core/src/orchestration/planner.ts`):
- Accepts `(macroNode, repoPreamble, phaseBody)` — the body is resolved at expansion time from the trusted preloaded `SpecReference` list, NOT from planner output.
- Reuses `plan()`'s `discoverModels` + `coerceModel` pipeline so sub-DAG node model ids are validated/coerced identically (prevents hallucinated model IDs like "claude-opus-4-9" from crashing Claude Code processes; both "claude-opus-4-6" and "claude-opus-4-8" are valid and will be coerced to the correct discovered ID).
- Refuses external dependencies, duplicate sub-DAG ids, and nested `MACRO_NODE` (anti-recursion).
- Prefixes every sub-node id with `<phaseId>__` so splices remain unique across phases.

**Splice algorithm** (`GraphExecutor.expandMacroNodesInLayer` in `packages/core/src/orchestration/executor.ts`):
1. For each `MACRO_NODE` in the current layer: invoke `macroExpansionCallback`, take entries (sub-nodes whose deps don't intersect the sub-DAG's ids) and leaves (sub-nodes nobody inside the sub-DAG depends on); reject if either set is empty.
2. Inbound rewire: entries inherit the macro node's `dependsOn`. Outbound rewire: every live consumer that depended on the macro node now fans-in across all leaves (Set-deduped).
3. Run `validateGraph` (cycles / unknown / self-deps) on the spliced result and throw before recomputing layers — `topologicalSort` would otherwise silently turn dangling-dep nodes into runnable entries.
4. Recompute layers via `topologicalSort` and refresh entry/exit nodes.

**Bridge wiring** (`OrchestrationBridge.dispatchCodingWorkflow` and `executePlan`):
- Builds a `Map<\`${specRef}::${phaseId}\`, {title, body}>` from `prepared.specs` and threads it via `ExecutorOverrides.macroPhaseBodies`.
- The macro-expansion callback closure looks the body up at run-time, fails fast if missing, and forwards to `planner.subPlan(node, codingPreamble, body)`. Non-coding dispatches leave the callback unset so any stray `MACRO_NODE` fails immediately with a clear error (defense-in-depth — `executeNodeByType`'s `MACRO_NODE` case also throws).

**Upstream phase context.** `Planner.subPlan` accepts an optional `upstreamPhaseSummary` arg; the bridge builds it at expansion time from the macro's own `phaseDependsOn` declarations + the trusted bodies map (titles only — never bodies — to keep the sub-plan prompt small). The summary is appended to the sub-planner prompt with explicit "do NOT add upstream `dependsOn` entries — the executor wires inter-phase edges automatically" guidance so the sub-DAG stays focused on its own phase.

**Telemetry.** `Planner.subPlan` returns `{nodes, usage: {inputTokens, outputTokens}}` (`MacroExpansionResult`) and the executor's `macroExpansionCallback` accepts both that rich shape and the simpler `WorkflowNode[]` (back-compat for ad-hoc callbacks). Each expansion is recorded into `executor.macroExpansionRecords` and surfaced as `ExecutionResult.macroPlanning` (`{expansionsAttempted, expansionsSucceeded, subNodesAdded, expansions[]}` with per-record `inputTokens` / `outputTokens`). The run-summary writer renders a "## Macro Planning (Task #197)" section with sub-planner token sums + a per-expansion table only when records exist, so the common-path summary stays visually identical. Expansion failures are also pushed into `ExecutionResult.errors` with `worker: macro:<specRef>::<phaseId>` so the user-facing error list carries actionable phase context (not just the wrapped message text).

**Tests:** `packages/core/src/orchestration/__tests__/macro-planning.test.ts` covers thresholds, the input-layer size gate, the macro renderer contract (no `phaseBody`), splice semantics, hard caps, external-dep rejection, duplicate-id rejection, post-splice graph validation, the missing-callback failure mode, an integration-style bridge-wiring test that proves `subPlan` is invoked once per macro node with the right resolved body, and the new telemetry/error-surfacing contract. All 168 core tests pass.



## Chat-attachment staging for DAG workers (Task #192)

`MainAgent.handleMessage` now writes every uploaded attachment to disk at `<workspaceDir>/output/<convOutputId>/_attachments/<sanitised-name>` BEFORE any dispatch route runs (helper: `packages/core/src/agent/attachment-staging.ts`, exports `stageAttachments`, `renderStagedAttachmentsBlock`, `AttachmentStagingError`, `ATTACHMENTS_DIR_NAME='_attachments'`). The staging dir lives under the per-SESSION `convOutputId` (Task #173) so files uploaded in turn N stay reachable in turn N+1.

**Idempotency contract**: a re-stage with byte-identical payloads skips the disk write (mtime preserved); a re-stage with **differing bytes for the same filename throws `AttachmentStagingError`** rather than silently clobbering — the caller is responsible for choosing a unique filename.

**Failure contract**: every I/O error AND every attachment lacking both `data` and `textContent` throws `AttachmentStagingError`; the caller surfaces the verbatim message via `callbacks.onText` and aborts the dispatch (no orchestration call is made — we never let the planner hallucinate against a file the workers can't see). Filenames are sanitised to a basename (`../` defended). Decoder accepts `data:<mime>;base64,<…>` DataURLs, bare base64, and UTF-8 `textContent`.

The staged list flows through `OrchestrationBridge.dispatchFullDAG` / `dispatchCodingWorkflow` (new `stagedAttachments?` opt) which (a) prepends a "## Attached files (staged on disk — read via absolute paths)" preamble listing each `absPath  (mime: …, size: … bytes, name: …)` line to the planner task, and (b) forwards the same list via `ExecutorOverrides → ExecutorConfig.stagedAttachments` so the executor injects the same block into **every AGENT** `injectedContext` (prepended to contextParts), **every TOOL** node's `injectedContext` (set directly so shell-style workers and planner-emitted command templates can substitute the absolute paths), and **every CODING_AGENT** `codingTask` (prepended to the task body).

Tests: `packages/core/src/agent/__tests__/attachment-staging.test.ts` (helper unit tests including the throw-on-byte-diff and throw-on-missing-bytes contracts) and `__tests__/attachment-staging-dispatch.test.ts` (end-to-end through `handleMessage` for orchestrate + code routes, retry-reuses-without-overwrite, write-failure-aborts-dispatch).

## Per-Session Conversation Output Dir (Task #173)

Direct-mode `conv-<id>` is per-SESSION, not per-turn. The `conv-<id>` printed in the system prompt's "Output Directory (STRICT)" block and used to derive `runDir = <workspaceDir>/output/<convId>` is allocated once per session via `MainAgent.getOrAllocateConvOutputId(sid)` and reused across every turn until `clearSessionState(sid)` or `/reset` drops the entry.

The per-turn `runId` (now prefixed `run-` instead of `conv-`) is kept separate as a lifecycle handle for `foregroundRunId` / `backgroundConversations` / `workflowSessions` / `direct-${runId}` workflow ids — that's what makes detach-to-background continue to work. Detached background turns keep their already-captured runDir (which equals the session's convId at start time); a new foreground turn after detach uses the same convId, so both turns write into the same dir and prior artifacts stay reachable.

Test: `packages/core/src/agent/__tests__/conversation-output-dir.test.ts`.

## Deterministic high-complexity subdivision (Task #178)

`subdivideHighComplexityChunks` in `packages/core/src/orchestration/coding/fanout-expansion.ts` enforces the Task #174 "subdivide high chunks" contract in code instead of trusting the architect prompt. `CodingPlanner.materializeFanOut` calls it before `expandFanOut`, splitting any `estimatedComplexity: 'high'` chunk into 2–4 medium siblings (`<id>-part1..N`) that inherit the original `dependsOn`, partition `fileCluster` evenly, share `sharedFiles`, and carry an auto-generated sub-task description. Other chunks whose `dependsOn` referenced the split id are rewritten to fan-in to every sibling.

Capped at one pass via the existing `alreadyReplanned` flag (same one `analyzeFanOutComplexity` uses) so a high tag that survives the cap dispatches as-is. The legacy `materializeFanOutWithReplan` LLM re-plan path still exists for back-compat but is now effectively dormant — deterministic subdivision removes high tags before complexity analysis runs, so `requiresReplan` stays false. `materializeFanOut` returns `{ subdivision, effectiveDecision }` alongside `complexity`.

Tests: `packages/core/src/orchestration/coding/__tests__/fanout-expansion.test.ts` (helper) and `__tests__/planner-fanout-integration.test.ts` (end-to-end through the planner).

## Spec-aware multi-phase fan-out (Task #174)

`prepareCodingDispatch` now pre-loads any `*.md` / `*.txt` / `*.spec` reference in the user task via `packages/core/src/agent/spec-loader.ts` (workspace-root sandbox guard mirroring the gateway file-read endpoint, 5 MB cap). When a referenced spec contains ≥3 `## Phase N` / `## Step N` / numbered headings, the planner preamble appends a "Multi-phase fan-out (CRITICAL)" block that:

1. Inlines the spec contents.
2. Lists one `phase-N` chunk per phase with its `Depends on` line.
3. Mandates one CODING_AGENT implementer node per phase (no monolithic `implement` node).
4. Parallelises independent phases and serialises ones with explicit "depends on Phase N" / "after Phase N" / "requires Phase N" language.
5. Requires a one-pass subdivision of any phase tagged `estimatedComplexity: high`.

`FanOutDecision.chunks` gained an optional `dependsOn?: string[]` carrying inter-phase ordering; absent / empty preserves the historical all-parallel behaviour. The legacy template architect prompts (`feature-implementation.ts`, `refactor.ts`) were updated with the same multi-phase override + complexity rule + new chunk field.

Test: `packages/core/src/agent/__tests__/spec-multiphase-fanout.test.ts` feeds a synthetic 6-phase spec (with Phase 4 → Phase 3 and Phase 6 → Phase 4 dependencies) through `parseSpecPhases`, `loadSpecReferences`, `buildCodingTaskPreamble`, the end-to-end `prepareCodingDispatch`, and the feature-implementation template prompt, asserting all six phases are emitted and the dependency edges are preserved. Resolves the "monolithic implement node" bug (`attached_assets/BUG-REPORT-dag-planner-monolithic-implement-node_1778112748450.md`).

**Post-merge fix (May 2026)**: the reference-extraction regex `[\w./-]+\.(md|txt|spec)` did not capture the leading `/` of POSIX absolute paths. As a result, `/home/user/.../spec.md` was captured as `home/user/.../spec.md` and `resolvePath(workspaceDir, ref)` treated it as relative, double-prefixing the workspace root and silently dropping the spec. Fix: the pattern now starts with `\/?` so absolute paths are captured intact. Sandbox guard already handles absolute paths correctly (`startsWith(root + sep)` after `resolvePath`).

## Lenient repo hint parsing (post-#172)

`parseCodingRequest` in `packages/core/src/orchestration/coding/coding-orchestrator.ts` now accepts conversational repo hints in addition to the strict `repo:<url>` form, so a follow-up message like "the repo is aaronboshart1/orionomega" no longer fails with `RemoteResolutionError`.

Recognized forms (case-insensitive): `repo:<v>`, `repoUrl:<v>`, `repo=<v>`, `repo is <v>`, `the repo is <v>`, `use repo <v>`, `using repo <v>`, `with repo <v>`, `clone <v>`, `clone from <v>`. Values flow through a new `normalizeRepoHint(raw)` helper that:

- Trims trailing punctuation `.,;:!?)]` (so "the repo is foo/bar." resolves to `foo/bar`).
- Strips wrapping quotes/backticks.
- Expands bare GitHub slugs `owner/repo` (regex `^[\w.-]+/[\w.-]+$`) to `https://github.com/owner/repo.git`.
- Appends `.git` to GitHub HTTPS URLs that omit it.
- Passes through other full URLs / scp-like SSH refs unchanged.

`resolveCodingRemote` also normalizes `ctx.repoHint` (defense in depth) so any caller that pre-extracts the hint still gets a clone-ready URL. Same branch-hint relaxation: `branch=<v>` and `branch is <v>` join `branch:<v>`. Tests in `packages/core/src/orchestration/coding/__tests__/coding-orchestrator.test.ts` cover every new form plus the slug-expansion and URL-passthrough edge cases.

## Git tab + session-scoped persistent clones + per-node worktrees (Task #196)

The new Git tab in the orchestration pane (`packages/web/src/components/orchestration/GitPane.tsx`, lazy-loaded from `OrchestrationPane.tsx`, store union extended in `stores/orchestration.ts`) lets the user register repos (URL or `owner/repo` slug) into a known-repos registry and pick one for the current session.

The registry is JSON-backed at `~/.orionomega/repos.json` (`packages/gateway/src/repos-store.ts`, debounced atomic writes, singleton `getReposStore()`, types `KnownRepo` / `SelectedRepo`, defense-in-depth `SAFE_ID_RE` on every mutator).

REST (`packages/gateway/src/routes/git.ts`, wired in `server.ts` before the coding-sessions block):
- `GET/POST /api/git/repos`
- `PATCH/DELETE /api/git/repos/:id`
- `GET/PUT/DELETE /api/git/sessions/:sid/repo`
- `POST /api/git/sessions/:sid/repo/sync`

The `GET /api/git/sessions/:sid/repo` and sync responses include a `status: RepoStatus` snapshot (`branch`, `commitsAhead`, `commitsBehind`, `isClean`, `lastCommit { sha, shortSha, subject, author, date }`, optional `diagnostics`) read via `getRepoStatus()` plus the `getLastCommit()` helper in `repo-manager.ts`. The selected clone path defaults to `<workspaceDir>/repos/<sessionId>/<repoName>`; future sessions reuse the same on-disk clone (cheap fetch instead of cold clone).

On every code-mode dispatch, `MainAgent.handleMessage` reads the selection via `MainAgentConfig.getSessionRepo?(sid)` (server.ts wires it to `getReposStore().getSessionRepo`) and forwards through `OrchestrationBridge.dispatchCodingWorkflow → prepareCodingDispatch` (`opts.sessionRepo`). When present, `prepareCodingDispatch` skips the per-run clone and calls `ensureSessionClone(remoteUrl, localPath, branch)` which clones if absent or `git fetch` + fast-forwards if present (with remote-URL verification on existing clones to prevent silent cross-repo fetches). When no selection exists AND the legacy resolver chain throws `RemoteResolutionError`, `dispatchCodingWorkflow` appends an actionable suffix pointing the user at the Git tab.

**Post-merge robustness fixes (May 2026)**:
- `ensureSessionClone` retries without `-b <branch>` when the branch doesn't exist on the remote, so misconfigured `defaultBranch` doesn't hard-fail.
- Every `runGit` invocation passes `-c 'safe.directory=*'` (single-quoted to prevent shell glob expansion) to survive cross-user clones on multi-user VMs.
- Broken-clone detection wipes `localPath` when `.git` exists but `getHeadCommit` returns null (interrupted clone).
- `getRepoStatus` detects empty repos (clone succeeded, zero commits, `rev-parse HEAD` fails with "ambiguous argument 'HEAD'") and shows a friendly message instead of the raw git stderr; `branch` field becomes `<symbolic-ref> (empty)`.
- `RepoStatus.diagnostics` field surfaces per-probe failures (`branchErr`, `headErr`, `remoteErr`, `statusErr`) and the GitPane renders them in a yellow "Git probe failures" panel.

**Per-CODING_AGENT-node `git worktree` isolation** (opt-in tech preview, parallel implementers only): gated behind `ORIONOMEGA_ENABLE_WORKTREE_FANOUT=1` because the consolidation/validation/push ordering is sensitive to the user's planner output and needs per-deployment integration testing. When the flag is set AND a session repo is in use, `dispatchCodingWorkflow` registers an `onPlanReady` hook (new opt added to `dispatchFullDAG` in `orchestration-bridge.ts`) that runs after planning but before dispatch. The hook groups all CODING_AGENT nodes by their `dependsOn` set and allocates worktrees ONLY for groups of ≥2 siblings — true parallel implementer fan-out. Single-instance control-flow CODING_AGENT nodes (sync/clone, validate, commit/push) sit alone in their layer and remain on the session branch, so the planner-emitted final push reflects the merged state. Each selected node gets a worktree at `<sessionClone>/.worktrees/<safeNodeId>` on a fresh `wt-<runId>-<safeNodeId>` branch off the base; `node.codingAgent.cwd` is mutated to the worktree path. The hook returns a `postExecute(success)` callback that the bridge folds into `ExecutorOverrides` and invokes in `executePlan`'s finally — on success, sequentially merges each worker branch back to the base via `mergeBranchInto(baseClonePath, sourceBranch, mergeMessage)` with `--no-ff`, **collecting any merge failures and throwing a unified error** so the dispatch result reflects partial-integration as a failure. Either way, `removeWorktree` prunes each worktree so the next dispatch starts clean.

**Known drift from the original task spec**: the merge-back consolidation runs in `postExecute` (after the planner-emitted DAG finishes) rather than as an injected DAG node before final test/push. The planner is instructed (in the existing coding preamble) to put commit/push at the end of the DAG; with parallel implementers scoped correctly to fan-out only, the push node runs on the session branch — but the merges happen after the push completes. This is acceptable when the parallel work is staged for a follow-up turn or local commit-only flows, and explicit consolidation-as-a-DAG-node is left as a follow-up.

**Security**: `repo-manager.ts` exports `isValidGitRefName` / `assertValidGitRefName` (subset of git-check-ref-format + extra hardening: ASCII letters/digits/`_`/`-`/`.`/`/` only, no leading `-` or `.`, no `..`, no `@{`, no whitespace, etc.). Every git-shell-interpolation site (`ensureSessionClone(branch)`, `addWorktree(branch, baseBranch)`, `mergeBranchInto(sourceBranch)`) asserts before interpolating, and the gateway routes (`POST /api/git/repos`, `PATCH /api/git/repos/:id`, `PUT /api/git/sessions/:sid/repo`) reject invalid `branch` / `defaultBranch` at the API boundary with HTTP 400.

**Supersedes Task #172's per-run clone path** when a session has a Git-tab selection; the legacy path (`repo:<url>` hint → origin in `coding.repoDir` → `coding.defaultRemote` → cwd-origin → `RemoteResolutionError`) still runs as fallback when no selection exists. Helper unit tests live alongside `repo-manager.ts`; route, UI, and per-node worktree integration are exercised manually.

## Coding-Mode Per-Run Clones (Task #172)

The active path is `MainAgent → OrchestrationBridge.dispatchCodingWorkflow → prepareCodingDispatch (packages/core/src/agent/coding-dispatch.ts) → Planner → GraphExecutor`. Each code-mode dispatch:

1. Resolves a remote URL via priority order — `repo:<url>` hint in the task → `git remote get-url origin` inside `coding.repoDir` (`sourceRepoDir`) → `coding.defaultRemote` from `config.yaml` → `git remote get-url origin` in the gateway's cwd → fail with `RemoteResolutionError`.
2. Mints a fresh runId and clones into `<workspaceDir>/output/<runId>/<repoName>` BEFORE the planner is called.
3. Captures HEAD and builds a planner preamble carrying a Repository block (remote URL, branch, checkout path, HEAD).
4. Pins every CODING_AGENT cwd to the checkout via a per-dispatch `executorOverrides.codingRepoDir` plumbed through `dispatchFullDAG → dispatchAsync → executeBackground → executePlan` (defense-in-depth if the planner LLM forgets `node.codingAgent.cwd`).

The preamble mandates: commit message = user's task description verbatim (no `feat:` prefix / truncation); `git push` failure must exit non-zero with the verbatim git stderr (orchestrator fails the run). Follow-up messages are fresh runs with their own runId / clone. `RemoteResolutionError` and clone errors surface verbatim to the user via `callbacks.onText`.

The legacy `file://./` fallback and `repoDir = codingRepoDir ?? workspaceDir` fallback are both gone (they silently dropped runs into the install tree). `coding.defaultRemote` flows: gateway → `MainAgentConfig.codingDefaultRemote` → `OrchestrationConfig.codingDefaultRemote` → resolver context.

## Multi-account Google Workspace (Task #164)

### Storage layout (per-account files, single source of truth)
- `<skillsDir>/google-workspace/accounts/<accountId>.json` — one record per account `{ id, label, port, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI, USER_GOOGLE_EMAIL, createdAt }`.
- `<skillsDir>/google-workspace/accounts/index.json` — `{ version: 1, activeAccountId }`.
- `<skillsDir>/google-workspace/config.json` — keeps only shared fields (Programmable Search keys + aggregate `configured` flag).
- `<skillsDir>` resolves to `$ORIONOMEGA_SKILLS_DIR` first, then `~/.orionomega/skills` (Replit uses `./.orionomega/skills`).

### Migration
On first read, `_accounts.js` migrates legacy shapes one-shot into the per-file layout — the older single-account top-level fields become a `default` account, and an interim `fields.accounts` map (from earlier in this task) is split into files. Migrated fields are then stripped from `config.json`.

### Topology (option 3a from the task)
One workspace-mcp instance per account, each on a distinct loopback port `basePort + slot` (default base `9877`, override via `GOOGLE_WORKSPACE_MCP_BASE_PORT`). Each account also gets an isolated `$HOME` at `~/.google_workspace_mcp_accounts/<id>/` so workspace-mcp's hardcoded credentials path (`~/.google_workspace_mcp/credentials/<email>.json`) never collides across accounts even when two accounts authenticate the same Google email.

### Env vars
- `GOOGLE_WORKSPACE_MCP_BASE_PORT` — base port for per-account listeners; default `9877`, slot N → `basePort + N`.
- `GOOGLE_WORKSPACE_ACCOUNT_ID` — set by the gateway on hook spawn to scope a hook to a specific account; falls back to the active account from `accounts/index.json`.
- `ORIONOMEGA_SKILLS_DIR` — overrides `~/.orionomega/skills`; threaded into every spawned skill hook so they read the same per-account file layout as the gateway.

### Generic `PUT /api/skills/google-workspace/config` compatibility
Legacy callers can still pass `accountId` (query string or JSON body) and the gateway will route per-account fields (`GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`, `USER_GOOGLE_EMAIL`) into the matching `accounts/<id>.json` instead of the shared `config.json`. Without `accountId` the route only updates shared fields (PSE keys + `enabled`).

### Redirect URI guidance (UI surfaces both)
- **Self-hosted Linux VM** — register `http://localhost:<account.port>` in Google Cloud Console; the OAuth round-trip completes locally. SSH `-L <port>:localhost:<port>` if the browser is on a different machine.
- **Replit** — ports aren't reachable through the public proxy; users complete OAuth via the manual-code-entry path (paste the redirect URL back into Settings → Skills).

### Manual VM test checklist
1. Install on the VM.
2. Settings → Skills → Google Workspace → "+ Add account" twice with two distinct Google Cloud OAuth clients, registering each account's `http://localhost:<port>` as an Authorized redirect URI.
3. Authenticate each account.
4. Toggle the dropdown to switch active account and confirm the Connected-as email updates.
5. Restart the gateway and verify both accounts remain authenticated.

### Endpoints
Auth-required, account ID validated against `^[a-zA-Z0-9_-]{1,64}$`:
- `GET/POST /api/skills/google-workspace/accounts`
- `PUT/DELETE /api/skills/google-workspace/accounts/:id`
- `POST /api/skills/google-workspace/accounts/:id/activate`

The OAuth start/status/callback endpoints accept `accountId` (query for GET, body for POST).

## Gateway port-bind retry (Task #183)

On startup the gateway retries `EADDRINUSE` with exponential backoff (1s → 2s → 4s capped at 5s) inside a configurable total budget — default **60 seconds**, override via `ORIONOMEGA_BIND_RETRY_MS` (e.g. `ORIONOMEGA_BIND_RETRY_MS=120000` for two minutes).

Heavy subsystems (MainAgent, scheduler, skill discovery, PID file, rate-limit cleanup, boot-provenance banner) only start after the **first** listener reports `listening`, so a brief overlap with a dying predecessor no longer churns them on every retry. If the budget really is exhausted the process exits once with a single consolidated `Failed to bind to [...] after Ns of retries — exiting` line. SIGTERM mid-retry aborts the loop cleanly via per-address `AbortController`s — no more "All bind addresses failed — exiting" pair after a graceful restart.

Helper + tests: `packages/gateway/src/bind-retry.ts`, `packages/gateway/src/__tests__/bind-retry.test.ts`.

## Auth by default + per-session authorization (Task #231)

Security P0. The gateway is **authenticated by default** and one session can no longer reach another session's data.

### What changed
- **Default flip**: `getDefaultConfig()` now sets `gateway.auth.mode: 'api-key'`. `mode: 'none'` is an explicit, warned opt-in.
- **First-run key bootstrap**: on startup `ensureGatewayAuthSecret()` (core `loader.ts`) generates a random 48-byte base64url signing secret, stores it as `gateway.auth.keyHash`, and persists the config (0600). The raw key is logged once so it can be copied for external clients. Local clients (web proxy / TUI) read `keyHash` and mint signed tokens automatically. `GATEWAY_AUTH_SECRET` env override still works in `server.mjs`.
- **Insecure-bind refusal**: `assertSecureBind()` (core) throws `InsecureBindError` when `auth.mode === 'none'` **and** the gateway binds a non-localhost address, unless `ORIONOMEGA_ALLOW_INSECURE_BIND=1` is set. The gateway entry point treats the throw as **fatal** (`process.exit(1)`) and never falls back to an unauthenticated default in that case.
- **Central auth gate**: `handleRequest` authenticates **every** `/api/*` request (api-key mode) except a tiny public allowlist — `GET /api/health` and `GET /api/skills/atlassian/oauth/callback` (the external OAuth redirect URI that cannot carry our Bearer token; its follow-up `/oauth/exchange` POST *is* authenticated). Per-route `checkAuth` calls in `config`/`skills`/`schedules` handlers remain as defense-in-depth.
- **Per-session authZ (tokens)**: tokens are either *master* (no `data.sessionId` — minted by the trusted web proxy / TUI, valid for any session) or *scoped* (`data.sessionId` set — valid only for that one session). `isSessionAuthorized()` enforces the boundary. On REST, `handleRequest` derives the target session from `/api/sessions/:id...` (`extractSessionScope`) and a scoped token presented for a different session — or for a global/unscoped route — gets **403**. On WS, `handleConnection` rejects a scoped token binding a different `?session=` with close code **4003**, and pins a scoped token with no explicit `?session=` to its own session.
- **Web proxy REST token injection** (`packages/web/server.mjs`): `createHandler` now injects `Authorization: Bearer <master token>` on REST proxy requests (previously only the WS upgrade got a token, which silently broke REST once auth was on). `authorization` is deliberately **not** in `ALLOWED_HTTP_HEADERS`, so a browser can never forge or override it — the proxy sets it purely server-side.

### Hardening checklist (operator)
- [ ] Leave `gateway.auth.mode` at the default `api-key`. Only set `none` for a throwaway local-only gateway bound to `127.0.0.1`.
- [ ] Never expose `mode: 'none'` on a non-localhost bind. If you must (you almost never must), you have to opt in with `ORIONOMEGA_ALLOW_INSECURE_BIND=1` and accept full unauthenticated control of the agent.
- [ ] Treat `gateway.auth.keyHash` as a secret. It is the HMAC signing secret — anyone with it can mint master tokens. It lives in the 0600 config file; don't commit it.
- [ ] Rotate the key by clearing `keyHash` (the gateway regenerates on next start) or setting a new value; restart the gateway and the web server so both pick it up.
- [ ] Externally-issued tokens for a single session should be **scoped** (`data.sessionId`), never master.
- [ ] Out of scope here (downstream task): file containment, REST Zod validation, SSRF, audit redaction.

### Where it lives
- Core: `packages/core/src/config/loader.ts` (`getDefaultConfig`, `assertSecureBind`, `ensureGatewayAuthSecret`, `InsecureBindError`, `INSECURE_BIND_OVERRIDE_ENV`).
- Gateway: `packages/gateway/src/routes/auth-utils.ts` (`checkAuth(req,res,cfg,requiredSessionId?)`, `isSessionAuthorized`), `server.ts` (startup bootstrap + `handleRequest` central gate, `isPublicApiRoute`, `extractSessionScope`), `websocket.ts` (`handleConnection` scope enforcement).
- Web: `packages/web/server.mjs` (`createHandler` Bearer injection).
- Tests: `packages/core/src/config/__tests__/auth-defaults.test.ts`, `packages/gateway/src/routes/__tests__/auth-utils.test.ts`.

## Foundational baseline

- **Monorepo Structure**: pnpm for efficient dependency management across multiple packages (`web`, `gateway`, `core`, `shared`, `skills-sdk`, `tui`).
- **Persistent Default Session**: All clients automatically join a single, persistent "default" session for continuity across browsers and sessions.
- **WebSocket Proxying**: Frontend WebSocket traffic is proxied through a Next.js custom server to bypass Replit's direct port access limitations.
- **Context Optimization**: Aggressive token and cost optimizations including prompt caching, cheap model routing, hot window reduction, and dynamic project summaries.
- **File-Based Slash Commands**: Users define custom agent commands by placing Markdown files in `~/orionomega/commands/`.

## Model capability registry (Task #229)

Model-specific behaviour — tier, output-token ceilings (both the comfortably-supported `defaultMaxOutput` and the hard-400 `maxOutput`), thinking style (`adaptive` vs `budget`), sampling support, mid-conversation system support, pricing, beta headers, fast-mode, effort aliasing, and access gating — is consolidated into one declarative table in `packages/core/src/models/model-registry.ts`. Adding a model is now a data edit (a default entry, a discovery seed, or a `config.yaml` override) rather than a code change.

**Precedence (per field): config > discovery > defaults.**
- `DEFAULT_CAPABILITIES` seeds the base table (haiku-4-5, sonnet-4-6, opus-4-6, opus-4-8, fable-5).
- `seedRegistryFromDiscovery()` (called inside `discoverModels`) adds models learned from `/v1/models` that aren't already known — **additive only**, never overwrites, so defaults/config keep precedence.
- `applyRegistryOverrides()` (called from `readConfig` with `config.models.registry`) merges field-by-field on top — highest precedence.

Resolution (`getModelCapability(id)`): exact-ID match → alias/substring match (longest alias first, so `opus-4-8` beats a broader `opus`) → synthesise from the inferred tier's `TIER_DEFAULTS`. The `mythos` tier sits above `opus`; `inferModelTier` maps `fable`/`mythos` IDs to it (checked before `opus`).

Consumers all read through the registry instead of inline `model.includes(...)` branches: `client.ts` (`maxOutputTokensForModel`, `modelMaxOutputCeiling`, temperature/thinking/beta/mid-conv-system/effort), `model-discovery.ts` (`inferTier`, `buildModelGuide` mythos routing, `pickModelByTier`), `coding-budget.ts` (`MODEL_COST_RATES`, `calculateTokenCost`, `estimateTokenBudget`), `planner.ts` (`coerceModel` tier inference). `fable`/mythos is gated (`accessGated: true`); gated-model fallback is a separate task. Tests: `packages/core/src/models/__tests__/model-registry.test.ts` plus the existing opus-4-8 suites that pin the migrated behaviour.

## Build order & build-info (canonical)

**Build order.** Packages must be built in dependency order. `tsc --build` and
`pnpm -r build` both respect this automatically via project references /
workspace topology, but a manual or filtered build must follow it:

```
shared → skills-sdk → core → gateway   (→ tui, → web)
```

`@orionomega/shared` is the lowest layer (it owns the consolidated logger /
`truncate` utilities, the relevance scorer, and the Zod-derived WebSocket
contract); `core` depends on it. Building out of order yields the classic foot-gun:
`tsc` resolves a dependency's *type declarations* from its `dist/`, so a
not-yet-built dependency surfaces as spurious "cannot find module
`@orionomega/...`" errors downstream.

**Build-info.** `scripts/generate-build-info.mjs` bakes the current git commit
+ build timestamp into `packages/<pkg>/src/generated/build-info.ts` (gitignored)
so the runtime can detect a *stale build* (dist/ compiled from a different
commit than the source tree — see `getStaleBuildStatus` in
`packages/core/src/build-info.ts`). Generation is centralized:

- The canonical list of packages that carry build-info lives in ONE place —
  the `BUILD_INFO_PACKAGES` constant inside `scripts/generate-build-info.mjs`.
- Root scripts (`prebuild`, `build-info`, `pretypecheck`, `pretest`) invoke
  `node scripts/generate-build-info.mjs --all`, so a root `pnpm build` /
  typecheck / test generates every package's build-info up front.
- Per-package `prebuild` hooks still pass their own name as a safety net for
  filtered builds (`pnpm --filter <pkg> build`), so any build path regenerates
  it. Add a new build-info consumer by appending to `BUILD_INFO_PACKAGES` (and
  its own `prebuild` hook) — not by editing several root scripts.

# OrionOmega — Detailed Architecture Notes

This file holds the in-depth architecture-decision and task-history notes that used to live in `replit.md`. The README keeps only Run/Stack/Where-things-live/Gotchas; everything else lives here.

## Hierarchical macro planning for very large coding specs (Task #197)

**Motivation.** Single-pass coding-mode planning fails with `stop_reason=max_tokens` on very large multi-phase specs (the canonical case is the Cannabis MSO Legal Operations Platform: ~150KB combined / 17 phases). The planner's tool output simply cannot fit one CODING_AGENT per phase plus all per-phase context inside Anthropic's max output budget.

**Fix.** Two-level planning. The macro planner emits one `MACRO_NODE` placeholder per spec phase; the executor invokes a per-phase sub-planner at run-time and splices the resulting sub-DAG into the live graph.

**Auto-gating** (`packages/core/src/agent/spec-loader.ts`):
- `shouldUseMacroPlanning(specs)` flips to macro mode at any of: combined contents ≥ 80KB / total phases ≥ 8 / any single phase body ≥ 12KB.
- `assertMacroPlanFeasible(specs)` runs immediately afterwards in `coding-dispatch.ts` and throws an actionable "Input too large for hierarchical planning — split the spec" error when total phases exceed `MACRO_PLAN_MAX_PHASES` (40). This is the input-layer rejection — `ExecutorConfig.macroMaxExpansions` (40) and `macroMaxTotalNodes` (200) are mid-execution last-resort caps.

**Macro plan output is small by construction.** The `MACRO_NODE` schema is `additionalProperties: false` with only `{specRef, phaseId, phaseTitle, phaseDependsOn}` — the model **cannot** echo phase bodies back into its tool output even if instructed to. The renderer (`renderSpecMacroPreambleBlock`) lists each phase by id/title/complexity/dependsOn but never inlines the body.

**Sub-planning** (`Planner.subPlan` in `packages/core/src/orchestration/planner.ts`):
- Accepts `(macroNode, repoPreamble, phaseBody)` — the body is resolved at expansion time from the trusted preloaded `SpecReference` list, NOT from planner output.
- Reuses `plan()`'s `discoverModels` + `coerceModel` pipeline so sub-DAG node model ids are validated/coerced identically (prevents "claude-opus-4-7" hallucinations from crashing Claude Code processes).
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

Heavy subsystems (MainAgent, scheduler, hindsight health timer, skill discovery, PID file, rate-limit cleanup, boot-provenance banner) only start after the **first** listener reports `listening`, so a brief overlap with a dying predecessor no longer churns them on every retry. If the budget really is exhausted the process exits once with a single consolidated `Failed to bind to [...] after Ns of retries — exiting` line. SIGTERM mid-retry aborts the loop cleanly via per-address `AbortController`s — no more "All bind addresses failed — exiting" pair after a graceful restart.

Helper + tests: `packages/gateway/src/bind-retry.ts`, `packages/gateway/src/__tests__/bind-retry.test.ts`.

## Foundational baseline

- **Monorepo Structure**: pnpm for efficient dependency management across multiple packages (`web`, `gateway`, `core`, `hindsight`, `skills-sdk`, `tui`).
- **Persistent Default Session**: All clients automatically join a single, persistent "default" session for continuity across browsers and sessions.
- **WebSocket Proxying**: Frontend WebSocket traffic is proxied through a Next.js custom server to bypass Replit's direct port access limitations.
- **Context Optimization**: Aggressive token and cost optimizations including prompt caching, cheap model routing, hot window reduction, and dynamic project summaries.
- **File-Based Slash Commands**: Users define custom agent commands by placing Markdown files in `~/orionomega/commands/`.

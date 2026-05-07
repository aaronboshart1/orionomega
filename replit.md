# OrionOmega — AI Agent Orchestration System

## Run & Operate

To start the full application:
```bash
pnpm install
pnpm --filter @orionomega/hindsight build
pnpm --filter @orionomega/skills-sdk build
pnpm --filter @orionomega/core build
pnpm --filter @orionomega/gateway build
pnpm --filter @orionomega/web dev  # Web frontend on port 5000 (webview)
pnpm --filter @orionomega/gateway start # Gateway on port 8000 (console)
```

Environment Variables:
- `ANTHROPIC_API_KEY`: Required for AI agent functionality.
- `CONFIG_PATH`: Optional, overrides default `config.yaml` path.
- `GOOGLE_WORKSPACE_MCP_BASE_PORT`: Optional base port for per-account workspace-mcp listeners (default 9877; account N gets basePort + N).

## Stack

- **Frontend**: Next.js 15
- **Backend**: Node.js, WebSocket/HTTP
- **ORM**: Drizzle (for scheduled tasks)
- **Validation**: Zod
- **Build Tool**: pnpm (monorepo)
- **UI Framework**: Zustand (state management)
- **Runtime**: Node.js

## Where things live

- `/packages/web`: Next.js frontend.
- `/packages/gateway`: Node.js WebSocket/HTTP backend.
- `/packages/core`: AI agent orchestration engine.
- `/packages/hindsight`: Memory and context persistence.
- `/packages/skills-sdk`: Skills plugin system.
- `/packages/tui`: Terminal UI.
- `config.yaml`: Main configuration file (default: `~/.orionomega/config.yaml`, Replit: `.orionomega/config.yaml`).
- `packages/core/src/db/schema.ts`: Database schema for scheduled tasks.
- `packages/skills-sdk/docs/ARCHITECTURE.md`: Skills SDK architecture documentation.
- `packages/web/src/lib/z-index.ts`: Centralized z-index constants.
- `packages/web/src/components/orchestration/SchedulesPane.tsx`: Schedules tab in the orchestration pane (master/detail; previously lived under Settings → Schedules and was promoted in Task #163).
- `packages/web/src/components/orchestration/PromptComposer.tsx`: Reusable prompt input mirroring the chat composer (textarea + paperclip + drag-drop + attachment chips); used by the scheduler form so saved schedules can carry file attachments that get replayed on every fire.
- `packages/web/src/lib/cron-forecast.ts`: Client-side next-N runs forecaster for cron previews.
- `packages/web/src/app/layout.tsx`: Global layout and theme imports.
- `packages/gateway/src/sessions.ts`: Default session ID (`DEFAULT_SESSION_ID`).
- `packages/web/src/components/HomeClient.tsx`: Top-level chat / orch-pane layout. On mobile (< 768 px) the orch pane is auto-closed once on hydrated mount so the chat input stays reachable (the orch overlay is `fixed inset-0` and the chat container is `hidden md:block`, so a persisted `orchPaneOpen: true` would otherwise hide the chat entirely on phones).

## Architecture decisions

- **Monorepo Structure**: Uses pnpm for efficient dependency management across multiple packages (`web`, `gateway`, `core`, `hindsight`, `skills-sdk`, `tui`).
- **Persistent Default Session**: All clients automatically join a single, persistent "default" session for continuity across browsers and sessions.
- **WebSocket Proxying**: Frontend WebSocket traffic is proxied through a Next.js custom server to bypass Replit's direct port access limitations.
- **Context Optimization**: Aggressive token and cost optimizations implemented, including prompt caching, cheap model routing, hot window reduction, and dynamic project summaries.
- **File-Based Slash Commands**: Allows users to define custom agent commands by placing Markdown files in a designated directory (`~/orionomega/commands/`).
- **Per-Session Conversation Output Dir** (Task #173): direct-mode `conv-<id>` is per-SESSION, not per-turn. The `conv-<id>` printed in the system prompt's "Output Directory (STRICT)" block and used to derive `runDir = <workspaceDir>/output/<convId>` is allocated once per session via `MainAgent.getOrAllocateConvOutputId(sid)` and reused across every turn until `clearSessionState(sid)` or `/reset` drops the entry. The per-turn `runId` (now prefixed `run-` instead of `conv-`) is kept separate as a lifecycle handle for `foregroundRunId` / `backgroundConversations` / `workflowSessions` / `direct-${runId}` workflow ids — that's what makes detach-to-background continue to work. Detached background turns keep their already-captured runDir (which equals the session's convId at start time); a new foreground turn after detach uses the same convId, so both turns write into the same dir and prior artifacts stay reachable. Test: `packages/core/src/agent/__tests__/conversation-output-dir.test.ts`.
- **Deterministic high-complexity subdivision** (Task #178): `subdivideHighComplexityChunks` in `packages/core/src/orchestration/coding/fanout-expansion.ts` enforces the Task #174 "subdivide high chunks" contract in code instead of trusting the architect prompt. `CodingPlanner.materializeFanOut` calls it before `expandFanOut`, splitting any `estimatedComplexity: 'high'` chunk into 2–4 medium siblings (`<id>-part1..N`) that inherit the original `dependsOn`, partition `fileCluster` evenly, share `sharedFiles`, and carry an auto-generated sub-task description. Other chunks whose `dependsOn` referenced the split id are rewritten to fan-in to every sibling. Capped at one pass via the existing `alreadyReplanned` flag (same one `analyzeFanOutComplexity` uses) so a high tag that survives the cap dispatches as-is. The legacy `materializeFanOutWithReplan` LLM re-plan path still exists for back-compat but is now effectively dormant — deterministic subdivision removes high tags before complexity analysis runs, so `requiresReplan` stays false. `materializeFanOut` returns `{ subdivision, effectiveDecision }` alongside `complexity`. Tests: `packages/core/src/orchestration/coding/__tests__/fanout-expansion.test.ts` (helper) and `__tests__/planner-fanout-integration.test.ts` (end-to-end through the planner).
- **Spec-aware multi-phase fan-out** (Task #174): `prepareCodingDispatch` now pre-loads any `*.md` / `*.txt` / `*.spec` reference in the user task via `packages/core/src/agent/spec-loader.ts` (workspace-root sandbox guard mirroring the gateway file-read endpoint, 5 MB cap). When a referenced spec contains ≥3 `## Phase N` / `## Step N` / numbered headings, the planner preamble appends a "Multi-phase fan-out (CRITICAL)" block that (a) inlines the spec contents, (b) lists one `phase-N` chunk per phase with its `Depends on` line, (c) mandates one CODING_AGENT implementer node per phase (no monolithic `implement` node), (d) parallelises independent phases and serialises ones with explicit "depends on Phase N" / "after Phase N" / "requires Phase N" language, and (e) requires a one-pass subdivision of any phase tagged `estimatedComplexity: high`. `FanOutDecision.chunks` gained an optional `dependsOn?: string[]` carrying inter-phase ordering; absent / empty preserves the historical all-parallel behaviour. The legacy template architect prompts (`feature-implementation.ts`, `refactor.ts`) were updated with the same multi-phase override + complexity rule + new chunk field. Test: `packages/core/src/agent/__tests__/spec-multiphase-fanout.test.ts` feeds a synthetic 6-phase spec (with Phase 4 → Phase 3 and Phase 6 → Phase 4 dependencies) through `parseSpecPhases`, `loadSpecReferences`, `buildCodingTaskPreamble`, the end-to-end `prepareCodingDispatch`, and the feature-implementation template prompt, asserting all six phases are emitted and the dependency edges are preserved. Resolves the "monolithic implement node" bug (`attached_assets/BUG-REPORT-dag-planner-monolithic-implement-node_1778112748450.md`).
- **Coding-Mode Per-Run Clones** (Task #172): the active path is `MainAgent → OrchestrationBridge.dispatchCodingWorkflow → prepareCodingDispatch (`packages/core/src/agent/coding-dispatch.ts`) → Planner → GraphExecutor`. Each code-mode dispatch (1) resolves a remote URL via priority order — `repo:<url>` hint in the task → `git remote get-url origin` inside `coding.repoDir` (`sourceRepoDir`) → `coding.defaultRemote` from `config.yaml` → `git remote get-url origin` in the gateway's cwd → fail with `RemoteResolutionError`; (2) mints a fresh runId and clones into `<workspaceDir>/output/<runId>/<repoName>` BEFORE the planner is called; (3) captures HEAD and builds a planner preamble carrying a Repository block (remote URL, branch, checkout path, HEAD); (4) pins every CODING_AGENT cwd to the checkout via a per-dispatch `executorOverrides.codingRepoDir` plumbed through `dispatchFullDAG → dispatchAsync → executeBackground → executePlan` (defense-in-depth if the planner LLM forgets `node.codingAgent.cwd`). The preamble mandates: commit message = user's task description verbatim (no `feat:` prefix / truncation); `git push` failure must exit non-zero with the verbatim git stderr (orchestrator fails the run). Follow-up messages are fresh runs with their own runId / clone. `RemoteResolutionError` and clone errors surface verbatim to the user via `callbacks.onText`. The legacy `file://./` fallback and `repoDir = codingRepoDir ?? workspaceDir` fallback are both gone (they silently dropped runs into the install tree). `coding.defaultRemote` flows: gateway → `MainAgentConfig.codingDefaultRemote` → `OrchestrationConfig.codingDefaultRemote` → resolver context.
- **Multi-account Google Workspace** (Task #164):
  - **Storage layout** (per-account files, single source of truth):
    - `<skillsDir>/google-workspace/accounts/<accountId>.json` — one record per account `{ id, label, port, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI, USER_GOOGLE_EMAIL, createdAt }`.
    - `<skillsDir>/google-workspace/accounts/index.json` — `{ version: 1, activeAccountId }`.
    - `<skillsDir>/google-workspace/config.json` — keeps only shared fields (Programmable Search keys + aggregate `configured` flag).
    - `<skillsDir>` resolves to `$ORIONOMEGA_SKILLS_DIR` first, then `~/.orionomega/skills` (Replit uses `./.orionomega/skills`).
  - **Migration**: on first read, `_accounts.js` migrates legacy shapes one-shot into the per-file layout — the older single-account top-level fields become a `default` account, and an interim `fields.accounts` map (from earlier in this task) is split into files. Migrated fields are then stripped from `config.json`.
  - **Topology** (option 3a from the task): one workspace-mcp instance per account, each on a distinct loopback port `basePort + slot` (default base `9877`, override via `GOOGLE_WORKSPACE_MCP_BASE_PORT`). Each account also gets an isolated `$HOME` at `~/.google_workspace_mcp_accounts/<id>/` so workspace-mcp's hardcoded credentials path (`~/.google_workspace_mcp/credentials/<email>.json`) never collides across accounts even when two accounts authenticate the same Google email.
  - **Env vars**: `GOOGLE_WORKSPACE_MCP_BASE_PORT` (base port for per-account listeners; default `9877`, slot N → `basePort + N`); `GOOGLE_WORKSPACE_ACCOUNT_ID` (set by the gateway on hook spawn to scope a hook to a specific account; falls back to the active account from `accounts/index.json`); `ORIONOMEGA_SKILLS_DIR` (overrides `~/.orionomega/skills`; threaded into every spawned skill hook so they read the same per-account file layout as the gateway).
  - **Generic `PUT /api/skills/google-workspace/config` compatibility**: legacy callers can still pass `accountId` (query string or JSON body) and the gateway will route per-account fields (`GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`, `USER_GOOGLE_EMAIL`) into the matching `accounts/<id>.json` instead of the shared `config.json`. Without `accountId` the route only updates shared fields (PSE keys + `enabled`).
  - **Redirect URI guidance** (UI surfaces both):
    - **Self-hosted Linux VM** — register `http://localhost:<account.port>` in Google Cloud Console; the OAuth round-trip completes locally. SSH `-L <port>:localhost:<port>` if the browser is on a different machine.
    - **Replit** — ports aren't reachable through the public proxy; users complete OAuth via the manual-code-entry path (paste the redirect URL back into Settings → Skills).
  - **Manual VM test checklist**: (1) install on the VM, (2) Settings → Skills → Google Workspace → "+ Add account" twice with two distinct Google Cloud OAuth clients, registering each account's `http://localhost:<port>` as an Authorized redirect URI, (3) authenticate each account, (4) toggle the dropdown to switch active account and confirm the Connected-as email updates, (5) restart the gateway and verify both accounts remain authenticated.
  - **Endpoints** (auth-required, account ID validated against `^[a-zA-Z0-9_-]{1,64}$`): `GET/POST /api/skills/google-workspace/accounts`, `PUT/DELETE /api/skills/google-workspace/accounts/:id`, `POST /api/skills/google-workspace/accounts/:id/activate`. The OAuth start/status/callback endpoints accept `accountId` (query for GET, body for POST).

## Product

OrionOmega provides an AI agent orchestration platform with a web-based dashboard, a WebSocket/HTTP backend, and a core orchestration engine. It features advanced memory management (Hindsight), a pluggable skills system, and a robust set of token and cost optimization strategies. Users can interact with the agent via a web UI or a Terminal UI, define custom commands, and schedule tasks.

## User preferences

- _Populate as you build_

## Gotchas

- **Build Order**: Packages must be built in a specific order (`hindsight`, `skills-sdk`, `core`, `gateway`) before the first run.
- **Configuration Path**: On Replit, `config.yaml` is located at `.orionomega/config.yaml` for persistence. Use `CONFIG_PATH` to override.
- **Replit Port Mapping**: Next.js binds to `0.0.0.0:5000` (webview) and the gateway to `0.0.0.0:8000` (console) due to Replit's environment.
- **Skill Execution Security**: Skill handlers are validated to run within the skill directory, restricted to `.js`/`.mjs` extensions, and sensitive environment variables are filtered.
- **Skill Hook Resolution**: Gateway resolves skill hook scripts (e.g. OAuth start/status) from the configured skills dir first (user override) and falls back to `default-skills/`. The configured skills dir is injected into hook child processes via `ORIONOMEGA_SKILLS_DIR` so hooks can locate the user's saved `config.json`.
- **File Access Limits**: Gateway file read endpoint is restricted to the workspace root and has a 5MB size limit.

## Pointers

- **Skills SDK Docs**: `packages/skills-sdk/docs/ARCHITECTURE.md`
- **Skills SDK Migration**: `packages/skills-sdk/MIGRATION.md`
- **Replit Documentation**: Refer to Replit's official documentation for specific environment details.
- **Zustand Documentation**: For understanding state management in the web frontend.
- **Drizzle ORM Documentation**: For database interactions related to scheduled tasks.
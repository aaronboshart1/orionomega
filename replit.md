# OrionOmega — AI Agent Orchestration System

> Detailed architecture-decision and task-history notes live in [`docs/architecture-notes.md`](docs/architecture-notes.md). This README keeps only what you need to run, navigate, and avoid common foot-guns.

## Run & Operate

```bash
pnpm install
pnpm --filter @orionomega/hindsight build
pnpm --filter @orionomega/skills-sdk build
pnpm --filter @orionomega/core build
pnpm --filter @orionomega/gateway build
pnpm --filter @orionomega/web dev      # Web frontend on port 5000 (webview)
pnpm --filter @orionomega/gateway start # Gateway on port 8000 (console)
```

Environment variables:
- `ANTHROPIC_API_KEY` — required for AI agent functionality.
- `CONFIG_PATH` — optional, overrides default `config.yaml` path.
- `GOOGLE_WORKSPACE_MCP_BASE_PORT` — optional base port for per-account workspace-mcp listeners (default 9877; account N gets basePort + N).
- `ORIONOMEGA_BIND_RETRY_MS` — optional budget (ms) for the gateway port-bind retry loop (default 60000).
- `ORIONOMEGA_ENABLE_WORKTREE_FANOUT=1` — opt-in tech preview: per-CODING_AGENT-node `git worktree` isolation for parallel implementers (Task #196).
- `ORIONOMEGA_SKILLS_DIR` — overrides `~/.orionomega/skills`.

## Stack

- **Frontend**: Next.js 15
- **Backend**: Node.js, WebSocket/HTTP
- **ORM**: Drizzle (for scheduled tasks)
- **Validation**: Zod
- **Build Tool**: pnpm (monorepo)
- **State**: Zustand
- **Runtime**: Node.js

## Where things live

### Packages
- `/packages/web` — Next.js frontend.
- `/packages/gateway` — Node.js WebSocket/HTTP backend.
- `/packages/core` — AI agent orchestration engine.
- `/packages/hindsight` — Memory and context persistence.
- `/packages/skills-sdk` — Skills plugin system.
- `/packages/tui` — Terminal UI.

### Config & data
- `config.yaml` — main configuration (default `~/.orionomega/config.yaml`, Replit `.orionomega/config.yaml`).
- `~/.orionomega/repos.json` — known-repo registry + per-session selections (Git tab, Task #196).
- `packages/core/src/db/schema.ts` — database schema for scheduled tasks.

### Notable source files
- `packages/web/src/components/orchestration/SchedulesPane.tsx` — Schedules tab in the orchestration pane.
- `packages/web/src/components/orchestration/GitPane.tsx` — Git tab; register repos and pick one per session.
- `packages/web/src/components/orchestration/PromptComposer.tsx` — reusable prompt input (textarea + paperclip + drag-drop + attachment chips).
- `packages/web/src/components/HomeClient.tsx` — top-level chat / orch-pane layout (mobile-aware orch-pane auto-close).
- `packages/web/src/lib/cron-forecast.ts` — client-side next-N runs forecaster for cron previews.
- `packages/web/src/lib/z-index.ts` — centralised z-index constants.
- `packages/web/src/app/layout.tsx` — global layout & theme imports.
- `packages/gateway/src/repos-store.ts` — JSON-backed known-repo registry.
- `packages/gateway/src/routes/git.ts` — REST routes for the Git tab.
- `packages/gateway/src/sessions.ts` — `DEFAULT_SESSION_ID`.
- `packages/gateway/src/bind-retry.ts` — port-bind retry helper.
- `packages/core/src/orchestration/coding/repo-manager.ts` — clone, fetch+ff, worktree primitives, `getRepoStatus`.
- `packages/core/src/agent/coding-dispatch.ts` — per-run preparation for code-mode dispatches.
- `packages/core/src/agent/spec-loader.ts` — reference extraction & multi-phase spec parsing for the planner preamble.
- `packages/core/src/agent/orchestration-bridge.ts` — DAG dispatch glue between MainAgent and the planner/executor; wires the macro-expansion callback for code-mode dispatches (Task #197).
- `packages/core/src/orchestration/planner.ts` — `Planner.plan` (top-level / macro plan) and `Planner.subPlan` (per-phase expansion, Task #197) sharing one model-discovery + coercion pipeline.
- `packages/core/src/orchestration/executor.ts` — `GraphExecutor.expandMacroNodesInLayer` splices per-phase sub-DAGs into the live graph (Task #197).

## Product

OrionOmega is an AI agent orchestration platform with a web dashboard, WebSocket/HTTP backend, and a core orchestration engine. It features advanced memory management (Hindsight), a pluggable skills system, and aggressive token/cost optimisations. Users can interact via the web UI or a Terminal UI, define custom commands, and schedule tasks.

## User preferences

- _Populate as you build._

## Gotchas

- **Build order**: packages must be built in order (`hindsight`, `skills-sdk`, `core`, `gateway`) before the first run.
- **Configuration path**: on Replit, `config.yaml` is at `.orionomega/config.yaml` for persistence. Use `CONFIG_PATH` to override.
- **Replit port mapping**: Next.js binds to `0.0.0.0:5000` (webview) and the gateway to `0.0.0.0:8000` (console).
- **Skill execution security**: skill handlers are validated to run within the skill directory, restricted to `.js`/`.mjs`, and sensitive env vars are filtered.
- **Skill hook resolution**: gateway resolves skill hook scripts from the configured skills dir first (user override) and falls back to `default-skills/`. The configured skills dir is injected into hook child processes via `ORIONOMEGA_SKILLS_DIR`.
- **File access limits**: gateway file-read endpoint is restricted to the workspace root with a 5MB cap.
- **Gateway port-bind retry**: see [`docs/architecture-notes.md`](docs/architecture-notes.md#gateway-port-bind-retry-task-183) — `ORIONOMEGA_BIND_RETRY_MS` controls the budget.
- **Spec paths in code-mode prompts**: the spec-loader regex captures both relative and absolute POSIX paths; absolute paths must live under the workspace root or per-run checkout to pass the sandbox guard.
- **Git tab vs `repo:<url>` hint**: when a session has a Git-tab selection, that's the source of truth and the legacy resolver chain is bypassed. Without a selection, the resolver chain (`repo:<url>` → `coding.repoDir` origin → `coding.defaultRemote` → cwd origin → error) still runs.
- **Hierarchical macro planning (Task #197)**: code-mode dispatches with very large multi-phase specs auto-switch to macro planning at 80KB combined / 8 phases / 12KB single-phase thresholds. Above 40 total phases the dispatch is refused at input time with a "split the spec" error — see `docs/architecture-notes.md` for the splice algorithm and bridge wiring.
- **Safe commit & push in coding mode (Task #209)**: enforcement is layered — (1) `prepareCodingDispatch` calls `ensureSafeGitignore` + `installSafeCommitHook` after every clone (both Git-tab session-clone and per-run legacy paths). The hook is a self-contained Perl `.git/hooks/pre-push` (perl is a hard transitive dep of git itself) that walks `git ls-tree -r -l -z HEAD` with `local $/ = "\0"` for true NUL-record processing and refuses any blob >95 MB, anything under `node_modules/`/`.next/`/`dist/`/`build/`/`.cache/`/`.turbo/`/`coverage/`, any `.env*` (except `.env.example`/`.env.sample`), any `*.{pem,key,p12,pfx}`, and any path containing control bytes (0x01-0x1F, which catches embedded TAB/LF/CR — i.e. hostile filenames cannot smuggle past). (2) The dispatch preamble's commit step (a-f) is the secondary procedure agents follow; it explicitly forbids `git push --no-verify`. (3) When `.git` exists but the hook can't be installed, dispatch FAILS hard rather than downgrading to advisory — silent fallback was the gap the first architect review caught. The pure-FS helpers (`ensureSafeGitignore`, `findUnsafeFiles`, `prepareSafeCommit`, `installSafeCommitHook`) live in `packages/core/src/orchestration/coding/safe-commit.ts` and are git-free so they unit-test without forking processes; runtime hook behaviour is covered by integration tests that spin up real `git init`'d repos and invoke the installed hook directly.

## Pointers

- **Architecture deep-dive**: [`docs/architecture-notes.md`](docs/architecture-notes.md)
- **Skills SDK Docs**: `packages/skills-sdk/docs/ARCHITECTURE.md`
- **Skills SDK Migration**: `packages/skills-sdk/MIGRATION.md`
- **Replit Documentation**: refer to Replit's official docs for environment details.
- **Zustand Documentation**: for state management in the web frontend.
- **Drizzle ORM Documentation**: for scheduled-task DB interactions.

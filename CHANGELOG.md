# Changelog

All notable changes to OrionOmega are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-03-08

Initial public release. OrionOmega is a plan-first, graph-based AI agent orchestration
system: the main agent never does work itself — it decomposes tasks into a DAG, you
approve the plan, and parallel workers execute.

### Core Orchestration Engine

- **DAG execution** — tasks decomposed into directed acyclic graphs; workers execute in
  parallel layers via Kahn's topological sort
- **Plan-first UX** — every multi-step task produces a reviewable plan (worker count,
  model per worker, estimated cost, estimated time, planner reasoning) before a single
  token is spent on execution
- **LOOP nodes** — workers can re-plan and spawn sub-graphs for iterative tasks
- **Checkpointing** — workflow state saved every 30 seconds; full restart from last
  checkpoint via `/restart`
- **Autonomous mode** — configurable plan auto-approval for scripted pipelines
- **Dynamic model discovery** — zero hardcoded model IDs; model list fetched from the
  Anthropic API at runtime
- **ContextAssembler** — pulls relevant memories from Hindsight before each plan
  generation; planner is always context-aware
- **Claude Agent SDK integration** — workers handling coding tasks run through the
  Anthropic Agent SDK for richer tool use
- **Token efficiency** — prompt caching, output isolation, and parallel batch execution
  to minimize cost on multi-worker runs
- **Node types** — `AGENT`, `TOOL`, `ROUTER`, `PARALLEL`, `JOIN`
- **Worker retry** — configurable per-worker retry count (default: 2) with exponential
  backoff

### Skills System

- **Self-contained skill packages** — each skill is a directory with `manifest.json`,
  `SKILL.md`, `scripts/handler.ts`, and an optional `prompts/worker.md`
- **Declarative auth** — OAuth, API key, and token auth declared in the manifest;
  `orionomega skill setup <skill>` runs the interactive auth wizard
- **Tool definitions** — JSON Schema validated inputs; handlers receive JSON on stdin
  and return JSON on stdout
- **Trigger patterns** — keyword and regex triggers route relevant tasks to skilled
  workers automatically
- **Worker profiles** — each skill can specify model, timeout, and tool restrictions
  for its worker
- **Lifecycle hooks** — `post-install`, `pre-load`, and `health-check` hooks in the
  manifest
- **`orionomega skill create|install|list`** — scaffold, install, and inspect skills
  from the CLI
- **`/skills` slash command** — list loaded skills and their status at runtime
- **GitHub skill** — enterprise reference implementation covering repository operations,
  issues, pull requests, reviews, and CI status
- **Linear skill** — project management integration for issue creation, triage,
  sprint management, and status updates
- **`web_search` and `web_fetch` skills** — built-in search and fetch capabilities
  distributed as standard skills

### Terminal UI (TUI)

- **pi-tui renderer** — replaced Ink/React with `@mariozechner/pi-tui` differential
  rendering; zero-flicker output, no full-screen redraws
- **Status bar** — persistent footer showing gateway connection, Hindsight connection,
  active worker count, and current model
- **Braille Ω spinner** — high-res 14×4 pixel grid animation; builds and dissolves the
  Ω symbol dot-by-dot during planning and thinking
- **Rich plan display** — plan rendered inline in the chat stream with worker table,
  dependency graph, cost/time estimates, and `[Y]es / [N]o / [M]odify` controls
- **Workflow tracker** — per-worker status lines update in real-time during execution
- **Persistent sessions** — conversation history written to disk and restored on TUI
  restart; no session loss on crash or reconnect
- **Scrollable history** — keyboard (`j`/`k`, `PgUp`/`PgDn`) and mouse wheel scrolling
  through the full message history
- **Slash command autocomplete** — `Tab` completes slash commands; `/help` lists all
  available commands
- **Paste detection** — multi-line pastes handled correctly without triggering premature
  sends
- **Markdown rendering** — assistant messages rendered with headings, bold, code blocks,
  and lists
- **LLM-based intent classifier** — routes short conversational messages directly to
  the main agent; routes complex requests through orchestration; avoids unnecessary
  plan generation for simple questions
- **Rich completion summary** — workflow results delivered with output file paths,
  per-worker findings, and a synthesized summary

### Web UI

- **Next.js 15 dashboard** — split-pane layout: chat on the left, orchestration
  dashboard on the right
- **ReactFlow DAG visualization** — interactive graph with nodes colored by status
  (`pending` / `running` / `done` / `error`); click any node for full detail
- **Activity feed** — real-time stream of worker events (thinking, tool calls, findings)
- **Worker detail panel** — per-node event log, tool call trace, output, and timing
- **Inline plan approval** — approve / reject / modify controls appear inline when a
  plan is pending; no separate modal
- **200ms event batching** — Web UI receives events at higher frequency than TUI
  (500ms) for smoother visualization

### Gateway

- **Native Node.js server** — HTTP + WebSocket gateway with no framework dependencies
- **API key auth** — SHA-256 hashed key stored in config; zero native crypto deps
  (no bcrypt, no OpenSSL bindings)
- **Event bus** — ring buffer of 1,000 events; late-connecting clients receive recent
  history on connect
- **Configurable batching** — TUI and Web UI batching intervals set independently;
  `error`, `done`, and `finding` events always bypass batching for immediate delivery
- **LAN-accessible** — binds to `0.0.0.0` by default for local network access
- **`/restart` support** — gateway service restarts via passwordless `sudo systemctl`
  rule; no password prompt in TUI

### Memory (Hindsight)

- **Temporal knowledge graph client** — connects to a running Hindsight instance at
  `http://localhost:8888` (configurable)
- **Banks and mental models** — memories organized into named banks; models carry
  structured knowledge (entities, relationships, confidence scores)
- **Planner context recall** — planner queries Hindsight for relevant prior context
  before generating each plan; improves plan quality on recurring domains
- **Retain on complete / retain on error** — configurable policies for when findings
  are written to memory
- **Graceful degradation** — OrionOmega runs fully without Hindsight; memory features
  are no-ops when the server is unreachable

### Installer (`scripts/install.sh`)

- **One-liner** — `curl -fsSL https://orionomega.dev/install | bash`
- **Phases** — preflight checks → Node.js 22 (NodeSource) → pnpm → clone & build →
  CLI link → config scaffolding → Hindsight (Docker) → systemd gateway service
- **Idempotent** — safe to re-run; skips steps already completed
- **Workspace templates** — `SOUL.md`, `USER.md`, and `TOOLS.md` created in
  `~/.orionomega/workspace/` on first install
- **Hindsight via Docker** — pulls and runs the Hindsight image with health-check
  verification before marking the step complete
- **Gateway systemd service** — installs and enables `orionomega-gateway.service`
  so the gateway starts on boot

### Setup Wizard (`orionomega setup`)

- Interactive wizard for first-time configuration
- Fetches live model list from the Anthropic API (with manual entry fallback)
- Configures API key, planner model, worker model profiles, gateway port, Hindsight
  URL, workspace path, and skills directory
- Writes `~/.orionomega/config.yaml`; auto-restarts the gateway if it was running

### Security

- **Secret scanning** — `detect-secrets` baseline committed; `scripts/setup-hooks.sh`
  installs a pre-commit hook that blocks credential commits
- **SHA-256 API key hashing** — gateway auth uses native `crypto.createHash`; no
  native addon dependencies
- **Zero pre-built skills** — no bundled skills means no third-party auth surface
  by default

### Testing & Quality

- **Vitest unit tests** — `graph.test.ts`, `validator.test.ts`, `loader.test.ts`
  covering the orchestration graph, skill manifest validator, and skill loader
- **TypeScript strict mode** — all packages compiled with `strict: true`,
  `noImplicitAny`, `noUncheckedIndexedAccess`
- **ESLint** — typescript-eslint and React-specific rules across all packages;
  pre-push lint check

### Documentation

- [`docs/getting-started.md`](docs/getting-started.md) — installation walkthrough,
  setup wizard, first orchestrated task, plan approval flow, slash commands, Web UI,
  SOUL.md / USER.md customization, configuration deep-dive
- [`docs/architecture.md`](docs/architecture.md) — system design, package dependency
  graph, orchestration flow, WebSocket protocol, event system, node type reference
- [`docs/skills-guide.md`](docs/skills-guide.md) — skill authoring guide: manifest
  reference, tool handler contract, worker profiles, auth patterns, lifecycle hooks
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development setup, workspace structure,
  commit conventions (Conventional Commits + Linear issue refs), testing guidelines

### Bug Fixes

- Plan clone for WebSocket transport stripped non-serializable fields; plan display
  now renders cleanly after round-trip
- Plans and assistant messages persisted incorrectly in session history on reconnect;
  both now always written to the session log
- Plan nodes were invisible after transport because `Map` does not serialize to JSON;
  replaced with plain objects with `Array.from` round-trip
- Plan approval sent the wrong ID; now keyed on `graph.id` so approval reaches the
  correct pending plan
- Plan overlay was rendered as a floating panel, obscuring chat; moved inline into
  the chat stream
- TUI spinner animation stuttered on rapid re-renders; frame scheduling moved to a
  dedicated interval outside the render loop
- Masked input in setup wizard iterated paste content incorrectly (ESM ReadLine
  quirk); replaced with per-character iteration
- Skill setup wizard skipped auth prompts on non-interactive terminals; now always
  interactive when a TTY is present
- Duplicate "connected" message shown in TUI on gateway reconnect; deduplicated
- Planner `maxTokens` was capped at 2048, causing plans to be truncated for large
  tasks; raised to 8192
- Model alias resolution in workers failed when config used short names (e.g.
  `sonnet`) instead of full IDs; aliases now resolved before the API call
- Stable streaming message IDs — messages accumulated duplicate content when the
  gateway reconnected mid-stream; IDs are now deterministic per-stream
- LAN gateway access was blocked by `127.0.0.1` binding; changed default bind to
  `0.0.0.0`
- Immediate execution trigger patterns matched partial words in longer sentences;
  anchored to full message boundaries
- `/exit` crash when the TUI sent the command as a WebSocket message and the gateway
  tried to execute it server-side; slash commands now handled locally in the TUI
- Slash command double-slash — TUI prepended `/` to commands that already had it;
  normalized before sending
- Passwordless gateway restart required a sudo password prompt mid-session; resolved
  via a `sudoers` drop-in rule installed by the setup wizard
- Gateway not initialized before accepting connections; `init()` now called and
  awaited before the WebSocket server binds
- `bcrypt` pulled in a native addon; replaced with `crypto.createHash('sha256')` for
  zero-native-dep operation
- Cyclic workspace dependency between `@orionomega/core` and `@orionomega/tui`
  eliminated; TUI is now an optional peer
- Hindsight health endpoint path was wrong; corrected to `/health`
- Web UI plan overlay crashed when `graph.nodes` arrived as a plain JSON object over
  WebSocket instead of a `Map`; deserialized on receipt

---

[0.1.0]: https://github.com/aaronboshart1/orionomega/releases/tag/v0.1.0

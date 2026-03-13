# Contributing to OrionOmega

Thanks for your interest in contributing. This guide covers everything you need to get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Package-Specific Notes](#package-specific-notes)
- [Adding a Skill](#adding-a-skill)

---

## Development Setup

**Prerequisites:** Node.js 22+, pnpm

```bash
git clone https://github.com/aaronboshart1/orionomega.git
cd orionomega
pnpm install
pnpm build
pnpm typecheck
```

Each package builds independently:

```bash
pnpm --filter @orionomega/core build
pnpm --filter @orionomega/gateway build
```

Watch mode (where supported):

```bash
pnpm --filter @orionomega/core dev
```

---

## Project Structure

OrionOmega is a pnpm workspace monorepo. The packages and their responsibilities:

| Package | Responsibility |
|---------|---------------|
| `packages/core` | Orchestration engine, agent, Anthropic client, config, CLI, memory |
| `packages/gateway` | WebSocket + REST server connecting UIs to core |
| `packages/hindsight` | HTTP client for the Hindsight temporal knowledge graph |
| `packages/skills-sdk` | Skill manifest types, loader, validator, executor, scaffolding |
| `packages/tui` | Terminal UI built with Ink |
| `packages/web` | Next.js dashboard with ReactFlow DAG visualization |

**Dependency order** (lowest to highest):

```
skills-sdk  hindsight
    └─────┬─────┘
          ▼
        core
          │
     ┌────┼────┐
     ▼    ▼    ▼
   tui gateway web
```

Read [`docs/architecture.md`](docs/architecture.md) for a deeper system overview before touching the orchestration engine.

---

## Code Style

- **TypeScript strict mode** — all packages run with `strict: true`
- **ESM modules** — `"type": "module"` throughout; use `import`/`export`, not `require`
- **No default exports** — use named exports
- **File naming** — `kebab-case.ts` for files, `PascalCase` for classes and types
- **No `any`** — use `unknown` and narrow properly
- **Error handling** — throw typed errors or return `Result`-style objects; don't swallow errors silently

Lint before submitting:

```bash
pnpm lint
pnpm typecheck
```

---

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add checkpoint resume on worker crash
fix(gateway): handle WS disconnect during plan approval
docs: update skills-guide with auth patterns
refactor(tui): consolidate panel state management
chore: bump @anthropic-ai deps to latest
```

**Scopes:** `core`, `gateway`, `tui`, `web`, `hindsight`, `skills-sdk`, `skills`, `docs`, `ci`

Keep commits focused. One logical change per commit.

---

## Pull Request Process

1. **Branch from `main`** — `git checkout -b feat/your-feature`
2. **Make your changes** — keep scope small and focused
3. **Run checks** — `pnpm build && pnpm typecheck && pnpm lint`
4. **Open a PR** — fill in the template: what changed, why, how to test
5. **Link any related issues**

PRs should be small enough to review in one sitting. If you're adding a large feature, open an issue first to discuss the approach.

---

## Package-Specific Notes

### `packages/core` — Orchestration Engine

The core package is the heart of the system. Key areas:

- `src/orchestration/planner.ts` — converts a user message into a DAG of worker nodes
- `src/orchestration/executor.ts` — runs the DAG using Kahn's topological sort
- `src/orchestration/worker.ts` — individual worker agent logic
- `src/agent/` — the main agent (plans, never executes directly)
- `src/memory/` — Hindsight integration for recall and retain
- `src/config/` — configuration loading and validation (zod schemas)

When modifying the orchestration engine, consider:
- Plan approval flow must remain synchronous from the user's perspective
- Workers communicate only via the event bus — no direct cross-worker calls
- `maxSpawnDepth` guards against recursive agent spawning

### `packages/gateway` — WebSocket Server

- Handles multiplexed WebSocket connections from TUI and Web UI
- Streams orchestration events to connected clients
- REST endpoints for health checks and configuration reads
- Auth is API-key-hash only; the plain key is never stored

### `packages/skills-sdk` — Skills

- `src/loader.ts` — discovers and validates skills from the configured directory
- `src/executor.ts` — spawns handler scripts and manages stdin/stdout/timeout
- `src/validator.ts` — validates `manifest.json` against the schema
- `src/scaffold.ts` — generates new skill directory structures

See [Adding a Skill](#adding-a-skill) below for the authoring guide.

### `packages/tui` — Terminal UI

Built with Ink (React for CLI). Component tree:

- `src/App.tsx` — root component, manages gateway connection
- `src/components/` — individual panels (chat, workers, plan, status)

The TUI consumes the same WebSocket event stream as the Web UI. Keep the two in sync when adding new event types.

### `packages/web` — Next.js Dashboard

Next.js 15 app with ReactFlow for DAG visualization. The Web UI state is managed with Zustand and streams events from the gateway WebSocket.

---

## Adding a Skill

The fastest way to contribute is to add a skill. Skills live in `default-skills/` and are self-contained packages:

```bash
# Scaffold a new skill
node packages/core/dist/cli.js skill create my-skill
```

A skill needs:
1. `manifest.json` — metadata, tool definitions, triggers
2. `SKILL.md` — agent-facing documentation
3. `scripts/handler.ts` — tool handler (JSON stdin → JSON stdout)

See [`docs/skills-guide.md`](docs/skills-guide.md) for the full authoring guide and a complete weather skill walkthrough.

Good candidates for new built-in skills:
- Jira / Confluence
- Notion
- Slack
- Database query tools (Postgres, SQLite)
- File processing (CSV, PDF, images)
- CI/CD systems (GitHub Actions, CircleCI)

---

## Reporting Issues

Use the GitHub issue templates:
- [Bug report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature request](.github/ISSUE_TEMPLATE/feature_request.md)

For security vulnerabilities, please email directly rather than opening a public issue.

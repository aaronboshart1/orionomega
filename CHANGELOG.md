# Changelog

All notable changes to OrionOmega are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Changed
- 2026-03-31 codebase audit (Passes 1–5): dead code removal, consolidation, file restructuring,
  pattern standardization, and documentation

---

## [0.1.0] — 2026-03-31

Initial release.

### Added

**Core orchestration**
- Plan-first, graph-based AI agent orchestration engine
- DAG execution with Kahn topological sort and parallel worker execution
- Strict main-agent/worker separation: main agent plans, workers execute
- `maxSpawnDepth` guard against recursive agent spawning
- Checkpoint-based workflow recovery on gateway reconnect (`autoResume`)
- Autonomous mode with configurable spend limit and duration cap

**Interfaces**
- Terminal UI (TUI) built on pi-tui with real-time event streaming
- Next.js 15 web dashboard with ReactFlow DAG visualization
- Shared WebSocket event protocol — TUI and Web UI consume identical streams

**Gateway**
- Native Node.js HTTP + `ws` WebSocket server (no framework)
- API-key-hash authentication mode (SHA-256; plain key never stored)
- Configurable CORS origins and bind address(es)
- REST endpoints: health, sessions, config, skills
- Per-client session management with ordered message history

**Memory**
- Hindsight temporal knowledge graph integration
- Recall on session start; retain on workflow completion and error
- Mental models and self-knowledge accumulation across sessions
- Session anchoring for context continuity

**Skills**
- Manifest-driven skill packages (manifest.json + SKILL.md + handler script)
- Built-in skills: `github`, `linear`, `web-search`, `web-fetch`
- Skill discovery, validation, and hot-loading from configurable directory
- `orionomega skill create` scaffolding command

**Configuration**
- YAML config at `~/.orionomega/config.yaml` (Replit: workspace path)
- Environment variable interpolation (`${VAR_NAME}` in YAML values)
- Deep-merge with defaults; all keys optional with sensible defaults
- File written with `0o600` permissions to protect API keys

**Developer tooling**
- pnpm monorepo with 6 packages
- TypeScript 5.7+, strict mode, ESM throughout
- `pnpm build` / `pnpm typecheck` / `pnpm lint` at root

---

[Unreleased]: https://github.com/aaronboshart1/orionomega/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aaronboshart1/orionomega/releases/tag/v0.1.0

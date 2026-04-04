# Changelog

All notable changes to OrionOmega are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.1.1] — 2026-04-04

### Summary

This release fixes a critical memory recall defect that caused 94–100% of recalled memories to be silently discarded. Agents deployed on v0.1.0 operated as if they had no cross-session memory despite storing 286+ memories correctly. Fourteen fixes across five files restore correct recall behavior and add production observability.

### Fixed

**Memory recall — critical (restores cross-session context)**

- **F1 — Structural prefix stripping in similarity scoring** (`packages/hindsight/src/similarity.ts`):
  Role prefixes (`[user]`, `[assistant]`, `[system]`) and structural labels (`Task:`, `Workers:`, `Decisions:`, `Findings:`, `Node:`, `Workflow:`, `Output:`, `Result:`, `Errors:`, `Outputs:`, `Artifacts:`) are now stripped during text normalization before keyword matching. Previously these tokens poisoned keyword scores — content about a decision scored zero against a query about the same decision because the stored text started with `Decisions:`.

- **F2 — Word length filter lowered from >3 to >2** (`packages/hindsight/src/similarity.ts`):
  The keyword scorer now includes 3-character technical terms (`fix`, `sql`, `bug`, `api`, `git`, `npm`, `cli`, `css`, `env`, `log`, `jwt`). The previous >3 filter silently excluded most short technical vocabulary.

- **F3 — Distinct-match keyword counting** (`packages/hindsight/src/similarity.ts`):
  Keyword overlap now counts *distinct* query words present in content, not total occurrences. A content item that repeats one matching word 10 times no longer outscores content that matches 5 different query words once each.

- **F4 — Relevance threshold lowered from 0.3 to 0.15** (`packages/hindsight/src/client.ts`):
  The previous 0.3 threshold was calibrated for embedding-based relevance scores (range: 0–1 with meaningful distribution). The client-side fallback scorer produces scores in the 0.02–0.40 range, so a 0.3 threshold dropped nearly all results. The new default of 0.15 is appropriate for client-side scoring. When the API returns embedding-based scores, the threshold continues to work correctly.

- **F5 — Temporal diversity parameter name corrected** (`packages/hindsight/src/client.ts`):
  The Hindsight API expects `query_timestamp` for temporal filtering; the previous code sent `before`. This caused temporal diversity recall buckets (14-day, 90-day, 365-day) to return unfiltered results.

- **F6 — Query length capped at 4,000 characters** (`packages/hindsight/src/client.ts`):
  The context assembler can pass full workflow payloads (~10KB+) as recall queries. Queries longer than 4,000 characters now return HTTP 400 from Hindsight. Oversized queries are truncated with a verbose log.

**Memory reliability — high**

- **F7 — Mental model seeding on first run** (`packages/core/src/agent/memory-bridge.ts`):
  On initialization, `MemoryBridge` now probes the three standard mental models (`user-profile`, `session-context`, `infra-map`). Any model that returns 404 is created via `refreshMentalModel()`. Previously, the refresh callback only updated existing models — models were never created on the first session, so every subsequent bootstrap attempt returned 404.

- **F9 — Session summary retain with exponential backoff** (`packages/core/src/memory/session-summary.ts`):
  Session summary retention now retries up to 3 times with exponential backoff (500ms, 1s, 2s) on transient network or server errors. 4xx responses (client errors) are not retried.

- **F10 — Recall empty-result logging differentiation** (`packages/hindsight/src/client.ts`):
  The `onIO` callback previously emitted `"No memories found"` for both "API returned 0 results" and "all results dropped by threshold" — two very different conditions. These now emit distinct messages with relevant metadata (`topScore`, `dropped`, `minRelevance`).

- **F11 — Recall budget aligned with Hindsight API tier cap** (`packages/core/src/memory/context-assembler.ts`):
  `recallBudgetTokens` default changed from 30,000 to 8,192 (the `high` tier cap). The previous value caused `HindsightClient` to silently clamp every request to 8,192, making the configured budget meaningless.

**Observability — medium**

- **F12 — Planning recall metrics emitted** (`packages/core/src/agent/memory-bridge.ts`):
  `recallForPlanning()` now emits a `memory` event with `totalResults`, `totalTokensUsed`, `durationMs`, and `banksQueried` after every planning recall. These metrics appear in the TUI memory panel and Web UI.

- **F13 — Recall effectiveness metric** (`packages/hindsight/src/client.ts`):
  After every recall, a `surfaceRate` (results returned / results from API) is computed. When the rate drops below 10% and the API returned at least one result, a WARN log is emitted to alert operators of a scoring misconfiguration.

**Resilience — medium**

- **F14 — Session summary debounce** (`packages/core/src/memory/session-summary.ts`):
  A 5-minute debounce window prevents rapid WebSocket disconnect/reconnect storms from generating multiple redundant session summaries.

### Added

- `docs/memory-architecture.md`: Complete memory system architecture documentation including component diagram, data flow, bank design, and observability reference.
- `docs/api-reference.md`: Full REST API and WebSocket event protocol documentation with examples. Includes `HindsightClient` and `ContextAssembler` TypeScript API reference.
- `docs/troubleshooting.md`: Diagnostic guide for memory, gateway, workflow, and skills issues.
- `docs/performance-tuning.md`: Tuning guide for recall budgets, model selection, worker concurrency, and event batching.
- `docs/security-compliance.md`: Security hardening guide, compliance considerations, audit logging reference, and secure deployment checklist.
- `memory-telemetry.ts`: Telemetry module for structured recall metrics (feeds F12/F13 observability).

### Fixed
- `scripts/install.sh`: `/dev/tty` redirect now tests openability via subshell before
  redirecting, preventing ENXIO failures in non-TTY SSH sessions and CI environments
- `install.sh`: launchd plist PATH now includes `$(brew --prefix)/bin` so Node.js binaries
  resolve correctly on Apple Silicon Macs where Homebrew installs to `/opt/homebrew`

### Added
- `SECURITY.md`: documents the intentional exec-level access model, hardening options,
  skill handler security, and API key storage
- `README.md`: comprehensive installation guide for Kali Linux, Ubuntu, and macOS;
  prerequisites table; configuration reference; troubleshooting section; security overview

### Changed

- `ContextAssembler` default `minRelevance` changed from unset (inherited 0.3) to `0.15` to align with client-side fallback scoring range.
- `ContextAssembler` default `recallBudgetTokens` changed from 30,000 to 8,192.
- Recall log messages distinguish between zero API results and threshold-filtered results (see F10).

### Tests Added

- `tests/similarity.test.ts`: 12 test cases covering normalization, trigram scoring, keyword scoring with 3-char terms, and structural prefix stripping.
- `tests/client-fixes.test.ts`: Unit tests for F4–F6, F10 in `HindsightClient`.
- `tests/client-recall.test.ts`: Integration-style tests for the full recall pipeline.
- `tests/memory-bridge.test.ts`: Tests for mental model seeding (F7) and planning recall metrics (F12).
- `tests/session-summary.test.ts`: Tests for retry logic (F9) and debounce behavior (F14).
- `tests/query-classifier.test.ts`: Tests for adaptive query classification and recall strategy selection.
- `tests/validate-all-fixes.ts`: End-to-end validation script confirming all 14 fixes pass (42 checks).

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

[0.1.1]: https://github.com/aaronboshart1/orionomega/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/aaronboshart1/orionomega/releases/tag/v0.1.0

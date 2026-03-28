# OrionOmega — AI Agent Orchestration System

## Overview

OrionOmega is a lightweight AI agent orchestration platform with a pnpm monorepo structure.

## Architecture

| Package | Description | Port |
|---|---|---|
| `packages/web` | Next.js 15 frontend dashboard | 5000 (webview) |
| `packages/gateway` | Node.js WebSocket/HTTP backend | 8000 (console) |
| `packages/core` | AI agent orchestration engine | — |
| `packages/hindsight` | Memory/context persistence | — |
| `packages/skills-sdk` | Skills plugin system (v0.2.0 — settings, interfaces, dual-mode) | — |
| `packages/tui` | Terminal UI | — |

## Replit Workflows

- **Start application** — runs `pnpm --filter @orionomega/web dev` on port 5000 (webview)
- **Gateway** — runs `pnpm --filter @orionomega/gateway start` on port 8000 (console)

## Running Locally

```bash
# Install all dependencies
pnpm install

# Build packages in order (needed before first run)
pnpm --filter @orionomega/hindsight build
pnpm --filter @orionomega/skills-sdk build
pnpm --filter @orionomega/core build
pnpm --filter @orionomega/gateway build

# Start the web frontend (port 5000)
pnpm --filter @orionomega/web dev

# Start the gateway (port 8000)
pnpm --filter @orionomega/gateway start
```

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Required for the AI agent (MainAgent) to function |
| `CONFIG_PATH` | Optional: override path to `config.yaml` |

## Key Configuration

The gateway reads from `~/.orionomega/config.yaml`. Defaults:
- Gateway port: 8000, bind: 0.0.0.0
- Auth mode: none
- CORS: http://localhost:*
- `models.cheap`: `claude-haiku-4-5-20251001` — lightweight model for intent classification, loop judges, and output compression

## Hindsight Intelligence Layer (Phase 3)

- **Memory quality scoring**: `scoreMemoryQuality()` in `packages/core/src/memory/retention-engine.ts` scores every memory candidate on information density before storage. Decisions, specs, and blockers score high; bare acknowledgments and status-only messages are rejected. Configurable via `RetentionConfig.qualityThreshold` (default: 0.3).
- **Session anchors**: `SessionBootstrap.storeSessionAnchor()` captures active project, last request, pending decisions, and unfinished work at session end. New sessions recall the most recent anchor first and inject it as "Where We Left Off" in the bootstrap context block.
- **Self-knowledge**: `SelfKnowledge` class in `packages/hindsight/src/self-knowledge.ts` stores Hindsight's own config (API endpoint, bank dispositions, tuning parameters, architectural decisions) as memories. `retainConfigChange()` auto-captures ongoing config changes.
- **Causal chain retrieval**: `ContextAssembler.buildCausalChain()` classifies recalled memory lines as decision/action/outcome and formats them as `Decision → Action → Outcome` narrative chains for "why did we do X?" queries.

## Token & Cost Optimizations

- **Prompt caching**: System prompt, tools, and penultimate conversation message all get `cache_control: ephemeral` breakpoints. The `anthropic-beta: prompt-caching-2024-07-31` header is sent on every request.
- **Cheap model routing**: Intent classification, loop exit judges, and upstream output compression all use `models.cheap` (Haiku) instead of the main model.
- **Hot window reduction**: ContextAssembler hot window reduced from 20 to 6 messages; older context comes via Hindsight recall per turn.
- **Upstream output compression**: Worker outputs exceeding ~2000 tokens are summarized via Haiku before injection into downstream workers.
- **Fast-path expansion**: Extended conversational regex patterns and lowered word-count thresholds to avoid unnecessary LLM classification calls.
- **Token budget guardrails**: `streamConversation` accepts `maxInputTokens` (default 100K for main agent) and trims oldest messages when exceeded.
- **Planner deduplication**: `plan()` accepts `preRecalledContext` to skip redundant Hindsight queries when the caller already has context.
- **Temporal diversity recall**: `recallWithTemporalDiversity` splits per-bank budgets (configurable ratio, default 15%) into a primary relevance query and multi-bucket temporal queries (14d/90d/365d cutoffs), merging and deduplicating results to break recency bias.
- **Client-side candidate pre-filtering**: `maxCandidates` parameter caps server-side cross-encoder rerank set, with budget-aware defaults (50/100/150 by token tier).
- **Relevance score propagation**: Recall results include inline `[confidence: X.XX]` markers in formatted context; per-section and overall confidence summaries (high/moderate/low buckets) are included in the context block and exposed as structured `ConfidenceSummary` on `AssembledContext`.
- **Adaptive query classification**: `classifyQuery()` categorizes incoming queries as `task_continuation`, `historical_reference`, `decision_lookup`, or `meta_system`. Each type triggers a different `RecallStrategy` adjusting bank budget ratios, temporal diversity, relevance thresholds, preferred context categories, and temporal bias (recent vs broad vs targeted).
- **Dynamic project summaries**: `DynamicSummaryGenerator` synthesizes on-demand project summaries from recalled memories when detailed recall returns nothing or exceeds budget. Eliminates dependency on pre-compacted summary files.

## Custom File-Based Slash Commands

Users can place `.md` files in `~/orionomega/commands/` to create custom slash commands. For example, `research.md` becomes `/research`. When invoked, the file content is sent to the agent as a user message.

- Config: `commands.directory` in `config.yaml` (default: `~/orionomega/commands/`)
- `CommandFileLoader` in `packages/core/src/commands/` scans for `.md` files and provides lookup
- Built-in commands take priority over file commands with the same name (warning logged)
- File commands appear in `/help` output, WebUI autocomplete (via `GET /api/commands`), and TUI autocomplete
- Example commands ship in `commands/` at repo root and are copied during install

## Skills SDK v0.2.0

The skills SDK (`@orionomega/skills-sdk`) was upgraded from v0.1.0 to v0.2.0 with these additions:

- **Settings system**: `settings.ts` module — schema extraction, resolution, validation, secret masking, and legacy `setup.fields` shimming
- **TypeScript-native skills**: `interfaces.ts` module — `ISkill` interface and `BaseSkill` abstract class with lifecycle hooks (`initialize → activate → deactivate → dispose`)
- **Dual-mode loading**: `loader.ts` auto-detects `skill.js` class files alongside `manifest.json` for in-process TypeScript skills
- **Settings UI**: `packages/web/src/components/settings/SkillsSettings.tsx` renders per-skill settings forms from manifest schemas
- **Gateway skills route**: `GET /api/skills` lists skills with schemas; `PUT /api/skills/:name/config` saves settings with validation
- **Manifest `settings` block**: Default skills (`github`, `web-search`) updated with `settings` schemas and `$schema` pointers
- **Skill class files**: `default-skills/github/skill.ts` and `default-skills/web-search/skill.ts` extend `BaseSkill`
- **Package exports**: Sub-path exports added (`@orionomega/skills-sdk/settings`, `/interfaces`, `/loader`, etc.)
- **Docs & templates**: `packages/skills-sdk/docs/ARCHITECTURE.md` and `packages/skills-sdk/templates/basic-skill/`
- **Migration guide**: `packages/skills-sdk/MIGRATION.md`

## CLI Shared Utilities

Shared readline/CLI helpers (colors, `ask`, `choose`, `confirm`, `askSecret`, `maskSecret`, etc.) live in `packages/core/src/commands/cli-utils.ts`. Both `setup.ts` and `setup-skills.ts` import from this module instead of duplicating.

## Replit-Specific Changes

- Next.js dev/start scripts bind to `0.0.0.0` on port 5000 (Replit's required webview port)
- Gateway default port changed from 7800 → 8000 (Replit-supported port)
- Gateway bind address changed from `127.0.0.1` → `0.0.0.0` in fallback config
- Frontend WebSocket proxied through Next.js custom server (`server.mjs`) at `/api/gateway/ws` — Replit's proxy doesn't allow direct port access from the browser, so the Next.js server proxies WebSocket upgrades to `localhost:8000`
- TUI gateway fallback port updated to 8000 (was 7800)
- `allowedDevOrigins: ['*']` added to `next.config.ts` for Replit's proxied preview
- Stale pre-compiled `.js` files removed from `src/app/` and `src/lib/`
- Legacy `workflow-tracker.ts` component removed (replaced by `workflow-panel.ts`)

## Browser State Persistence

Both the chat and orchestration Zustand stores use `persist` middleware with localStorage to survive page refreshes:

- **Chat store** (`orionomega-chat`): persists `messages` (including tool-call messages with full `ToolCallData`)
- **Orchestration store** (`orionomega-orchestration`): persists `inlineDAGs`, `workflows` (graphState + events per workflow), `activeWorkflowId`, `orchPaneOpen`, `activeOrchTab`, `graphState`, `events`
- Ephemeral state (`activePlan`, `selectedWorker`, `pendingConfirmation`, `isStreaming`, `memoryEvents`) is NOT persisted — it resets on refresh
- **Hydration guards**: `useChatHydrated()` and `useOrchHydrated()` hooks prevent flash of empty state during localStorage rehydration; `ChatPane` and `page.tsx` gate rendering on hydration completion
- Gateway session ID stored in `orionomega_session_id` localStorage key for reconnection

## Memory Feed (Orchestration Pane)

The orchestration pane now opens by default with a "Memory" tab as the first tab, showing a real-time feed of Hindsight memory operations:

- **Core**: `MemoryEvent` type defined in `packages/core/src/agent/main-agent.ts` with ops: `retain`, `recall`, `dedup`, `quality`, `bootstrap`, `flush`, `session_anchor`, `summary`, `self_knowledge`
- **MemoryBridge**: emits events via `onMemoryEvent` callback for key operations (init, recall, flush, summarize, anchor)
- **Gateway**: broadcasts `memory_event` WebSocket messages to all clients
- **Frontend**: `MemoryFeed` component in `packages/web/src/components/orchestration/MemoryFeed.tsx` renders events with color-coded icons per operation type
- **OrchestrationPane**: tabs for "Memory" (default) and "Activity" (DAG/workflow detail)
- **page.tsx**: orchestration pane toggle is always visible (no longer gated on `hasWorkflows`)
- Memory events are ephemeral (not persisted to localStorage), capped at 200

## Multi-Workflow Tabs

The orchestration sidebar supports multiple concurrent workflows via per-workflow tabs:

- `packages/web/src/stores/orchestration.ts` — the Zustand store scopes `graphState` and `events` per workflow ID in a `workflows` record, with `activeWorkflowId` controlling which workflow's data is surfaced as top-level `graphState`/`events` for existing consumers
- `packages/web/src/components/orchestration/WorkflowTabs.tsx` — horizontal tab bar rendered at the top of the orchestration pane when multiple workflows exist; each tab shows workflow name, status dot (with pulse animation for running), and a close button for terminal workflows
- `packages/web/src/components/orchestration/OrchestrationPane.tsx` — integrates `WorkflowTabs` above the existing DAG/activity/summary layout
- `packages/web/src/app/page.tsx` — toggle logic uses `Object.keys(workflows).length > 0` instead of `!!graphState` so the pane shows whenever any workflow exists
- New workflows auto-select when they start; completed workflows remain as tabs until dismissed

## Tool Call Visualization

The web UI renders inline tool-call cards in the chat stream when workers invoke tools during DAG execution. Key components:

- `ToolCallData` type in `packages/web/src/stores/chat.ts` — carries tool name, action, file, summary, and status
- `ToolCallCard` component in `packages/web/src/components/chat/ToolCallCard.tsx` — collapsible card with tool icon, name, target, summary, and status indicator
- `ToolCallGroup` component — groups consecutive tool calls from the same worker/node under a single header
- Gateway (`packages/web/src/lib/gateway.ts`) emits `tool-call` chat messages when `dag_progress` events contain tool data
- `ChatPane` groups consecutive tool-call messages by nodeId before rendering
- Chat message list uses `react-virtuoso` for list virtualization — only visible messages plus a buffer are rendered to the DOM, keeping performance smooth for long conversations (100+ messages)
- Smart auto-scroll: `followOutput="smooth"` keeps the list pinned to the bottom during streaming; when the user scrolls up, a "New messages" pill appears to jump back down

## Toast Notifications

A global toast notification system provides transient feedback for WebSocket events, errors, and settings save operations:

- **Store**: `packages/web/src/stores/toast.ts` — Zustand store with `addToast(message, variant, duration)` and auto-dismiss
- **Component**: `packages/web/src/components/ToastContainer.tsx` — rendered in root layout, stacked at top-center with slide-in animation
- **Variants**: `info`, `success`, `error`, `warning` with distinct color schemes
- **Integration points**: gateway connect/disconnect, WebSocket errors, settings save success/failure, slash command load failure

## Z-Index Scale

Centralized z-index constants in `packages/web/src/lib/z-index.ts`:

| Constant | Value | Usage |
|---|---|---|
| `scrollToBottom` | 10 | Scroll-to-bottom button, drag overlay |
| `orchPaneToggle` | 20 | Orchestration pane toggle button |
| `orchPaneMobile` | 30 | Mobile orchestration pane overlay |
| `dropdown` / `modal` / `commandPalette` | 50 | Dropdowns, settings modal, command palettes |
| `toast` | 60 | Toast notifications (topmost) |

## Markdown Rendering

Chat assistant/system messages render full markdown via `react-markdown` with `remark-gfm`, `rehype-highlight` (syntax highlighting), and `rehype-sanitize`. The `MarkdownContent` component lives at `packages/web/src/components/chat/MarkdownContent.tsx`. User messages remain plain text. Streaming updates are throttled via `requestAnimationFrame` to avoid excessive re-renders. The highlight.js `github-dark` theme is imported in `packages/web/src/app/layout.tsx`.

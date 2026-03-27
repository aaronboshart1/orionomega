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
| `packages/skills-sdk` | Skills plugin system | — |
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

## Token & Cost Optimizations

- **Prompt caching**: System prompt, tools, and penultimate conversation message all get `cache_control: ephemeral` breakpoints. The `anthropic-beta: prompt-caching-2024-07-31` header is sent on every request.
- **Cheap model routing**: Intent classification, loop exit judges, and upstream output compression all use `models.cheap` (Haiku) instead of the main model.
- **Hot window reduction**: ContextAssembler hot window reduced from 20 to 6 messages; older context comes via Hindsight recall per turn.
- **Upstream output compression**: Worker outputs exceeding ~2000 tokens are summarized via Haiku before injection into downstream workers.
- **Fast-path expansion**: Extended conversational regex patterns and lowered word-count thresholds to avoid unnecessary LLM classification calls.
- **Token budget guardrails**: `streamConversation` accepts `maxInputTokens` (default 100K for main agent) and trims oldest messages when exceeded.
- **Planner deduplication**: `plan()` accepts `preRecalledContext` to skip redundant Hindsight queries when the caller already has context.

## CLI Shared Utilities

Shared readline/CLI helpers (colors, `ask`, `choose`, `confirm`, `askSecret`, `maskSecret`, etc.) live in `packages/core/src/commands/cli-utils.ts`. Both `setup.ts` and `setup-skills.ts` import from this module instead of duplicating.

## Replit-Specific Changes

- Next.js dev/start scripts bind to `0.0.0.0` on port 5000 (Replit's required webview port)
- Gateway default port changed from 7800 → 8000 (Replit-supported port)
- Gateway bind address changed from `127.0.0.1` → `0.0.0.0` in fallback config
- Frontend WebSocket URL updated to port 8000
- TUI gateway fallback port updated to 8000 (was 7800)
- `allowedDevOrigins: ['*']` added to `next.config.ts` for Replit's proxied preview
- Stale pre-compiled `.js` files removed from `src/app/` and `src/lib/`
- Legacy `workflow-tracker.ts` component removed (replaced by `workflow-panel.ts`)

## Tool Call Visualization

The web UI renders inline tool-call cards in the chat stream when workers invoke tools during DAG execution. Key components:

- `ToolCallData` type in `packages/web/src/stores/chat.ts` — carries tool name, action, file, summary, and status
- `ToolCallCard` component in `packages/web/src/components/chat/ToolCallCard.tsx` — collapsible card with tool icon, name, target, summary, and status indicator
- `ToolCallGroup` component — groups consecutive tool calls from the same worker/node under a single header
- Gateway (`packages/web/src/lib/gateway.ts`) emits `tool-call` chat messages when `dag_progress` events contain tool data
- `ChatPane` groups consecutive tool-call messages by nodeId before rendering
- Chat message list uses `react-virtuoso` for list virtualization — only visible messages plus a buffer are rendered to the DOM, keeping performance smooth for long conversations (100+ messages)
- Smart auto-scroll: `followOutput="smooth"` keeps the list pinned to the bottom during streaming; when the user scrolls up, a "New messages" pill appears to jump back down

## Markdown Rendering

Chat assistant/system messages render full markdown via `react-markdown` with `remark-gfm`, `rehype-highlight` (syntax highlighting), and `rehype-sanitize`. The `MarkdownContent` component lives at `packages/web/src/components/chat/MarkdownContent.tsx`. User messages remain plain text. Streaming updates are throttled via `requestAnimationFrame` to avoid excessive re-renders. The highlight.js `github-dark` theme is imported in `packages/web/src/app/layout.tsx`.

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

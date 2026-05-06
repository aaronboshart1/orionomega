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
- `packages/web/src/lib/cron-forecast.ts`: Client-side next-N runs forecaster for cron previews.
- `packages/web/src/app/layout.tsx`: Global layout and theme imports.
- `packages/gateway/src/sessions.ts`: Default session ID (`DEFAULT_SESSION_ID`).

## Architecture decisions

- **Monorepo Structure**: Uses pnpm for efficient dependency management across multiple packages (`web`, `gateway`, `core`, `hindsight`, `skills-sdk`, `tui`).
- **Persistent Default Session**: All clients automatically join a single, persistent "default" session for continuity across browsers and sessions.
- **WebSocket Proxying**: Frontend WebSocket traffic is proxied through a Next.js custom server to bypass Replit's direct port access limitations.
- **Context Optimization**: Aggressive token and cost optimizations implemented, including prompt caching, cheap model routing, hot window reduction, and dynamic project summaries.
- **File-Based Slash Commands**: Allows users to define custom agent commands by placing Markdown files in a designated directory (`~/orionomega/commands/`).
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
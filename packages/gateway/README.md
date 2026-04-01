# @orionomega/gateway

WebSocket and REST gateway server for OrionOmega. Handles connections from the TUI and Web UI, routes messages to the orchestration engine, streams events back to clients, and provides REST endpoints for health, session, config, and skill management.

---

## Running

```bash
# Standalone (from repo root after build)
node packages/gateway/dist/server.js

# Via CLI (preferred)
orionomega gateway start
orionomega gateway stop
orionomega gateway restart

# Development (tsx watch)
pnpm --filter @orionomega/gateway dev
```

The gateway reads configuration from `~/.orionomega/config.yaml`. The port, bind address, auth mode, and CORS origins are all controlled there (see `config.example.yaml` at the repo root).

---

## WebSocket Protocol

Clients connect to `ws://<host>:<port>/ws?client=tui` or `ws://<host>:<port>/ws?client=web`.

**Client → Gateway:**

| `type` | Purpose |
|--------|---------|
| `chat` | Send a message to the main agent |
| `command` | Execute a slash command (`/stop`, `/status`, etc.) |
| `plan_response` | Approve or reject a pending execution plan |
| `dag_response` | Approve or reject a DAG confirmation prompt |
| `subscribe` | Subscribe to events for a specific workflow ID |

**Gateway → Client:**

| `type` | Purpose |
|--------|---------|
| `text` | Main agent text response (may be streaming) |
| `thinking` | Agent thinking trace |
| `plan` | Execution plan pending approval |
| `event` | Worker event (tool call, finding, status update) |
| `dag_dispatched` | New workflow started |
| `dag_progress` | Node status change within a workflow |
| `dag_complete` | Workflow finished (with summary and cost) |
| `dag_confirm` | DAG requires user confirmation before proceeding |
| `status` | System status update |
| `session_status` | Token and cost counters |
| `hindsight_status` | Memory service connection state |
| `command_result` | Slash command outcome |
| `history` | Replayed session message history |
| `error` | Gateway-level error |

---

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check; returns `{ ok: true, version, uptime }` |
| `GET` | `/status` | Full system status (workers, Hindsight, config) |
| `GET` | `/sessions` | List active sessions |
| `GET` | `/sessions/:id` | Get session message history |
| `POST` | `/sessions` | Create a new session |
| `GET` | `/config` | Read current configuration (secrets redacted) |
| `PUT` | `/config` | Update configuration (requires auth if enabled) |
| `GET` | `/skills` | List loaded skills and their status |
| `PUT` | `/skills/:id/config` | Update skill configuration |

---

## Directory Layout

```
src/
├── server.ts          # Entry point — HTTP server, route registration, lifecycle
├── types.ts           # ClientConnection, ClientMessage, ServerMessage
├── sessions.ts        # SessionManager — per-session message history
├── websocket.ts       # WebSocketHandler — per-client WS lifecycle
├── commands.ts        # CommandHandler — slash command dispatch
├── events.ts          # EventStreamer — worker event → client broadcast
├── rate-limit.ts      # Per-IP rate limiting for REST and WS
├── security-headers.ts # CORS, X-Content-Type-Options, etc.
└── routes/
    ├── health.ts      # GET /health
    ├── sessions.ts    # GET/POST /sessions
    ├── status.ts      # GET /status
    ├── config.ts      # GET/PUT /config
    └── skills.ts      # GET/PUT /skills
```

---

## Authentication

When `gateway.auth.mode` is `api-key`, every request must include an `Authorization: Bearer <key>` header. The gateway compares `SHA-256(key)` against the stored `keyHash` — the plain key is never stored or logged.

Set `auth.mode: none` only when `bind` is restricted to `127.0.0.1`.

---

## Development

```bash
pnpm --filter @orionomega/gateway build
pnpm --filter @orionomega/gateway dev   # tsx watch
```

The gateway depends on `@orionomega/core`, `@orionomega/hindsight`, and `@orionomega/skills-sdk`.

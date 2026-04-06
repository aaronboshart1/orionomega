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

## Session Persistence Architecture

Sessions survive gateway restarts and browser reconnections. The system uses a dual-layer persistence model:

### Layer 1: Durable JSON Persistence (`SessionManager`)

- **Storage**: `~/.orionomega/sessions/{id}.json` (one file per session)
- **Writes**: Debounced (configurable, default 500ms) to coalesce rapid mutations
- **Permissions**: `0o600` (owner-only read/write)
- **Backup**: Atomic `.bak` files created before each write for crash recovery
- **Caps**: Messages (default 1000), memory events (200), run history (100), orchestration events (500)

### Layer 2: Ephemeral In-Memory State (`ServerSessionStore`)

- **Purpose**: Supplements durable storage with high-frequency event data
- **Data**: Event log (capped 5000/session), materialized DAG states (capped 100/session), cost accumulators, pending actions
- **Lifetime**: Gateway process lifetime only — not persisted to disk

### Reconnection Protocol

```
Client                          Gateway
  │                                │
  │── ws://.../ws?session=default ─►│  1. Connect with saved session ID
  │                                │  2. Load session from disk
  │◄── ack (clientId, sessionId) ──│  3. Acknowledge connection
  │◄── state_snapshot ─────────────│  4. Send paginated state snapshot
  │◄── history ────────────────────│  5. Send legacy message replay
  │◄── memory_history ─────────────│  6. Send memory event replay
  │◄── hindsight_status ───────────│  7. Send service status
  │                                │
  │── chat { content, agentMode } ─►│  8. User resumes interaction
```

**State snapshot optimization**: Only the most recent 200 messages are sent over WebSocket. The snapshot includes `pagination` hints so the client can lazy-load older messages via `GET /api/sessions/:id/activity`.

**Compression**: Messages >64KB are compressed with zlib deflate before sending, with a `ZLIB` magic prefix so the client can detect and decompress.

**Event buffering**: When no clients are connected, events are buffered in memory (up to 500). On reconnect, buffered events are drained and delivered.

### What's Persisted

| Data | Persisted to Disk | In Memory Only |
|------|:-----------------:|:--------------:|
| Chat messages | ✓ | |
| Memory events | ✓ | |
| Session totals (tokens/cost) | ✓ | |
| Inline DAG states | ✓ | ✓ (materialized) |
| Active workflows | ✓ | |
| Pending plans/confirmations | ✓ | |
| Agent mode | ✓ | |
| Coding session state | ✓ | |
| Run history | ✓ | |
| Orchestration events | ✓ | |
| Event buffer | | ✓ |
| Client connections | | ✓ |
| High-frequency event log | | ✓ |

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_MAX_MESSAGES` | `1000` | Max messages per session before oldest are pruned |
| `SESSION_MAX_AGE_HOURS` | `24` | Hours before idle sessions are archived |
| `SESSION_CLEANUP_INTERVAL_MIN` | `30` | Cleanup sweep interval in minutes |
| `SESSION_PERSIST_DEBOUNCE_MS` | `500` | Debounce delay for disk writes |
| `SESSION_MAX_SESSIONS` | `50` | Maximum concurrent sessions |

### Config File (`~/.orionomega/config.yaml`)

```yaml
gateway:
  port: 8000
  bind: "127.0.0.1"
  auth:
    mode: none        # 'api-key' or 'none'
    # keyHash: "sha256-hash-of-your-key"
  cors:
    origins:
      - "http://localhost:*"
```

---

## WebSocket Protocol

Clients connect to `ws://<host>:<port>/ws?client=tui` or `ws://<host>:<port>/ws?client=web`.

**Client → Gateway:**

| `type` | Purpose | Key Fields |
|--------|---------|------------|
| `chat` | Send a message to the main agent | `content`, `agentMode`, `attachments`, `replyToId` |
| `command` | Execute a slash command (`/stop`, `/status`, etc.) | `command`, `workflowId` |
| `plan_response` | Approve or reject a pending execution plan | `planId`, `action`, `modification` |
| `dag_response` | Approve or reject a DAG confirmation prompt | `workflowId`, `dagAction` |
| `subscribe` | Subscribe to events for a specific workflow ID | `workflowId` |
| `init` | Request full state snapshot (reconnection) | `sessionId` |
| `ping` | Keep-alive | |
| `file_read` | Read a workspace file | `path` |

**Gateway → Client:**

| `type` | Purpose | Delivery |
|--------|---------|----------|
| `text` | Main agent text response (may be streaming) | Broadcast |
| `thinking` | Agent thinking trace | Broadcast |
| `plan` | Execution plan pending approval | Broadcast |
| `event` | Worker event (tool call, finding, status update) | Broadcast |
| `dag_dispatched` | New workflow started | Broadcast (tracked) |
| `dag_progress` | Node status change within a workflow | Broadcast (tracked) |
| `dag_complete` | Workflow finished (with summary and cost) | Broadcast (tracked) |
| `dag_confirm` | DAG requires user confirmation | Broadcast (tracked) |
| `session` | Full state snapshot (reconnection) | Single client |
| `state_snapshot` | SQLite-backed state snapshot | Single client |
| `history` | Replayed session message history (legacy) | Single client |
| `memory_history` | Memory event replay (legacy) | Single client |
| `direct_complete` | Non-DAG response stats | Broadcast (tracked) |
| `coding_event` | Coding mode lifecycle event | Broadcast (tracked) |
| `status` | System status update | Broadcast |
| `session_status` | Token and cost counters | Broadcast |
| `hindsight_status` | Memory service connection state | Broadcast |
| `command_result` | Slash command outcome | Broadcast |
| `error` | Gateway-level error | Single client |
| `ack` | Message acknowledgement | Single client |

**Note**: "tracked" means the message state is recorded server-side for inclusion in reconnection snapshots.

---

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Liveness check; returns `{ status, version, uptime, memory }` |
| `GET` | `/api/metrics` | Detailed metrics: session counts, store stats, connection info |
| `GET` | `/api/status` | Full system status (workers, Hindsight, config) |
| `GET` | `/api/sessions` | List active sessions |
| `GET` | `/api/sessions/:id` | Get session message history |
| `POST` | `/api/sessions` | Create a new session |
| `DELETE` | `/api/sessions/:id` | Delete session (not default) |
| `GET` | `/api/sessions/:id/state` | Full state snapshot (cached 2s) |
| `GET` | `/api/sessions/:id/activity` | Paginated activity log (limit, offset, types, since, before) |
| `GET` | `/api/sessions/:id/feed` | Paginated message feed |
| `GET` | `/api/config` | Read current configuration (secrets redacted) |
| `PUT` | `/api/config` | Update configuration (requires auth if enabled) |
| `GET` | `/api/skills` | List loaded skills and their status |
| `PUT` | `/api/skills/:id/config` | Update skill configuration |
| `GET` | `/api/models` | List available LLM models |

---

## Security

- **Authentication**: `SHA-256(key)` comparison — plain key never stored or logged
- **Session IDs**: Validated against `[a-z0-9_-]{1,128}` regex to prevent path traversal
- **Client IDs**: `crypto.randomUUID()` (RFC 4122 v4) for cryptographic randomness
- **Input sanitization**: Zod schema validation for all client messages; prompt injection patterns stripped
- **File access**: Workspace-scoped path traversal protection with `realpathSync` validation
- **Rate limiting**: Per-IP token bucket for REST, auth, and WebSocket connections
- **Headers**: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Permissions-Policy
- **Disk**: Session files written with `0o600` permissions (owner-only)

---

## Directory Layout

```
src/
├── server.ts          # Entry point — HTTP server, route registration, lifecycle
├── types.ts           # ClientConnection, ClientMessage, ServerMessage
├── sessions.ts        # SessionManager — durable JSON persistence with backup
├── websocket.ts       # WebSocketHandler — per-client WS lifecycle, compression
├── state-store.ts     # ServerSessionStore — in-memory event log, DAG state
├── state-types.ts     # Type definitions for state store
├── ws-schemas.ts      # Zod validation schemas for client messages
├── commands.ts        # CommandHandler — slash command dispatch
├── events.ts          # EventStreamer — worker event → client broadcast
├── rate-limit.ts      # Per-IP rate limiting for REST and WS
├── security-headers.ts # CSP, HSTS, X-Frame-Options, etc.
├── auth.ts            # Token validation
├── activity.ts        # ActivityService — action logging
├── coding-events.ts   # Coding mode event emitters
├── feed/              # Conversation feed service
└── routes/
    ├── health.ts      # GET /health, GET /metrics
    ├── sessions.ts    # GET/POST/DELETE /sessions, /state, /activity
    ├── status.ts      # GET /status
    ├── config.ts      # GET/PUT /config
    ├── skills.ts      # GET/PUT /skills
    ├── coding.ts      # Coding session endpoints
    ├── feed.ts        # Feed endpoints
    ├── activity.ts    # Activity logging endpoint
    └── cache.ts       # TTL cache for REST responses
```

---

## Authentication

When `gateway.auth.mode` is `api-key`, every request must include an `Authorization: Bearer <key>` header. The gateway compares `SHA-256(key)` against the stored `keyHash` — the plain key is never stored or logged.

Set `auth.mode: none` only when `bind` is restricted to `127.0.0.1`.

---

## Observability

### Metrics Endpoint (`GET /api/metrics`)

Returns comprehensive metrics for monitoring dashboards:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 3600,
  "process": { "heapUsedMB": 45, "heapTotalMB": 60, "rssMB": 80 },
  "sessions": {
    "activeSessions": 1,
    "totalClients": 2,
    "totalMessages": 150,
    "pendingWrites": 0,
    "totalDiskWrites": 42,
    "diskWriteFailures": 0,
    "estimatedMemoryBytes": 75000
  },
  "stateStore": {
    "sessionCount": 1,
    "totalEvents": 500,
    "totalDAGs": 3,
    "estimatedMemoryBytes": 160000
  },
  "connections": { "active": 2 }
}
```

### Structured Logging

All session events use structured log prefixes for filtering:
- `[session:connected]` / `[ws:connected]` — Client connection
- `[ws:disconnected]` — Client disconnection
- `[ws:rehydrated]` — State snapshot sent
- `[session:persist:error]` — Disk write failure
- `[session:load:recovered]` — Backup recovery on startup
- `[session:cleanup]` — Stale session cleanup
- `[session:config]` — Configuration at startup

---

## Development

```bash
pnpm --filter @orionomega/gateway build
pnpm --filter @orionomega/gateway dev   # tsx watch
```

The gateway depends on `@orionomega/core`, `@orionomega/hindsight`, and `@orionomega/skills-sdk`.

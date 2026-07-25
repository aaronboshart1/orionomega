# API Reference

**OrionOmega v0.1.1 — Enterprise Documentation**

---

## Overview

OrionOmega exposes three API surfaces:

1. **Gateway REST API** — HTTP endpoints for sessions, skills, configuration, and health
2. **Gateway WebSocket API** — Real-time event streaming for all connected clients
3. **Memory API** — the `MemoryStore` TypeScript interface, plus the three
   memory tools the agent itself calls

All REST endpoints are served by the gateway (`packages/gateway`). Default port: `8000`.

---

## Authentication

When `gateway.auth.mode` is `api-key`, every request must include:

```http
Authorization: Bearer <your-api-key>
```

The plain key is never stored. Only a SHA-256 hex hash is stored in config. Generate the hash:

```bash
echo -n "your-secret-key" | sha256sum
```

Set in config:
```yaml
gateway:
  auth:
    mode: api-key
    keyHash: <sha256-hex-output>
```

When `mode` is `none` (default), no Authorization header is required. **Do not use `none` when binding to non-loopback interfaces.**

---

## REST API

### Base URL

```
http://<bind-address>:<port>
```

Default: `http://localhost:8000`

### Common Response Format

Success responses return JSON. Error responses:

```json
{
  "error": "Human-readable error message"
}
```

---

### Health

#### `GET /health`

Returns gateway and subsystem health status.

**No authentication required.**

**Response:**

```json
{
  "status": "ok",
  "version": "0.1.1",
  "uptime": 12345,
  "process": { "heapUsedMB": 180, "heapTotalMB": 260, "rssMB": 410 },
  "system": {
    "memory": { "busy": false, "health": "ready" },
    "database": null,
    "summarizer": null
  }
}
```

`system.memory.health` is `ready`, `rebuilding`, or `degraded` — recall health,
not socket state. Anything other than `ready` rolls the top-level `status` up to
`degraded`. When not `ready` a `reason` is included (`redis_unreachable`,
`index_cold`, or `write_failed`), and `pct` appears while rebuilding.

The HTTP status is always `200`; read the JSON `status` field.

**Example:**

```bash
curl http://localhost:8000/health
```

---

### Sessions

#### `GET /sessions`

List all active gateway sessions.

**Response:**

```json
{
  "sessions": [
    {
      "id": "sess_abc123",
      "connectedAt": "2026-04-04T10:00:00.000Z",
      "messageCount": 42,
      "memoryScope": "project-my-task"
    }
  ]
}
```

---

#### `GET /sessions/:id`

Get details for a specific session.

**Response:**

```json
{
  "id": "sess_abc123",
  "connectedAt": "2026-04-04T10:00:00.000Z",
  "messageCount": 42,
  "memoryScope": "project-my-task",
  "agentMode": "orchestrate",
  "lastActivity": "2026-04-04T10:05:00.000Z"
}
```

The `agentMode` field reflects the session's current persisted mode. If `null`, the system default (`orchestration.defaultAgentMode`) applies.

---

#### `PUT /sessions/:id/agent-mode`

Update the agent mode for a specific session. The change is persisted to disk and takes effect immediately for subsequent messages.

**Request body:**

```json
{
  "mode": "direct"
}
```

**Valid values:** `"orchestrate"` | `"direct"`

**Response `200 OK`:**

```json
{
  "id": "sess_abc123",
  "agentMode": "direct"
}
```

**Error responses:**

| Status | Body | Meaning |
|--------|------|---------|
| `400 Bad Request` | `{"error": "Invalid mode: must be 'orchestrate' or 'direct'"}` | Mode value is not recognized |
| `404 Not Found` | `{"error": "Session not found"}` | Session ID does not exist |

**Example:**

```bash
curl -X PUT http://localhost:8000/sessions/sess_abc123/agent-mode \
  -H 'Content-Type: application/json' \
  -d '{"mode": "direct"}'
```

---

#### `DELETE /sessions/:id`

Terminate a session.

**Response:** `204 No Content`

---

### Skills

#### `GET /skills`

List all installed and active skills.

**Response:**

```json
{
  "skills": [
    {
      "name": "web-search",
      "version": "0.2.0",
      "active": true,
      "healthy": true,
      "tools": ["web_search"]
    },
    {
      "name": "github",
      "version": "1.1.0",
      "active": true,
      "healthy": true,
      "tools": ["github_create_issue", "github_list_prs"]
    }
  ]
}
```

---

#### `GET /skills/:name`

Get details for a specific skill.

**Response:**

```json
{
  "name": "github",
  "version": "1.1.0",
  "active": true,
  "healthy": true,
  "health": {
    "healthy": true,
    "message": "API reachable"
  },
  "tools": [
    {
      "name": "github_create_issue",
      "description": "Create a GitHub issue",
      "inputSchema": { "type": "object", "properties": { ... } }
    }
  ],
  "settings": {
    "gh_token": "[REDACTED]",
    "default_owner": "my-org"
  }
}
```

---

#### `POST /skills/:name/settings`

Update settings for a skill. Password-type settings are stored as secrets and never returned in plaintext.

**Request body:**

```json
{
  "gh_token": "ghp_xxxxxxxxxxxx",
  "default_owner": "my-org"
}
```

**Response:** `200 OK` with updated skill info, or `400 Bad Request` with validation errors.

---

#### `POST /skills/:name/reload`

Hot-reload a skill without restarting the gateway.

**Response:** `200 OK`

---

### Configuration

#### `GET /config`

Returns the current active configuration (secrets redacted).

**Response:**

```json
{
  "gateway": {
    "port": 8000,
    "bind": "127.0.0.1",
    "auth": { "mode": "api-key" },
    "cors": { "origins": ["http://localhost:*"] }
  },
  "memory": {
    "redis": {
      "url": "redis://localhost:6379",
      "password": "[REDACTED]"
    },
    "retainOnComplete": true,
    "retainOnError": true,
    "sessionSummary": true
  },
  "models": {
    "provider": "anthropic",
    "default": "claude-sonnet-4-20250514",
    "apiKey": "[REDACTED]"
  }
}
```

---

#### `PATCH /config`

Apply a partial configuration update. Deep-merged with current config. Gateway processes that depend on changed values are restarted automatically.

**Request body** (any subset of the config schema):

```json
{
  "logging": {
    "level": "verbose"
  },
  "orchestration": {
    "workerTimeout": 600
  }
}
```

**Response:** `200 OK` with the new full config, or `400 Bad Request` with validation errors.

---

### Status

#### `GET /status`

Returns orchestration engine status: active workflows, worker states, checkpoint info.

**Response:**

```json
{
  "activeWorkflows": 1,
  "workers": [
    {
      "nodeId": "node_xyz",
      "profile": "code",
      "status": "running",
      "startedAt": "2026-04-04T10:04:00.000Z"
    }
  ],
  "lastCheckpoint": "2026-04-04T10:03:30.000Z"
}
```

---

## WebSocket API

Connect to:

```
ws://localhost:8000/ws?sessionId=<optional-id>
```

If `sessionId` is omitted, the gateway assigns one and returns it in the first message.

**Authentication:** For `api-key` mode, pass the key as a query parameter:

```
ws://localhost:8000/ws?apiKey=<your-api-key>
```

Or in the HTTP upgrade headers:

```
Authorization: Bearer <your-api-key>
```

---

### Client → Server Messages

All messages are JSON objects with a `type` field.

#### `chat`

Send a user message to the active session.

```json
{
  "type": "chat",
  "content": "Refactor the authentication module to use JWT",
  "sessionId": "sess_abc123",
  "agentMode": "orchestrate"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"chat"` | Yes | Message type |
| `content` | `string` | Yes | The user message |
| `sessionId` | `string` | Yes | Target session ID |
| `agentMode` | `"orchestrate" \| "direct"` | No | Override mode for this message only. Omit to use the session's persisted mode. |

**Agent Mode values:**
- `"orchestrate"` — Full DAG execution with planning, approval, and parallel workers
- `"direct"` — Bypass orchestration; respond conversationally without spawning workers
- *(omit)* — Use the session's current mode (or `orchestration.defaultAgentMode` from config)

---

#### `cancel`

Cancel the current workflow execution.

```json
{
  "type": "cancel",
  "sessionId": "sess_abc123"
}
```

---

#### `reset`

Clear the conversation context (hot window) for a session.

```json
{
  "type": "reset",
  "sessionId": "sess_abc123"
}
```

---

#### `skill_action`

Invoke a skill management action.

```json
{
  "type": "skill_action",
  "action": "reload",
  "skillName": "github"
}
```

---

### Server → Client Events

The gateway streams a sequence of typed events for every workflow run.

#### `session_ready`

Sent once on connection establishment.

```json
{
  "type": "session_ready",
  "sessionId": "sess_abc123",
  "timestamp": "2026-04-04T10:00:00.000Z"
}
```

---

#### `agent_mode_changed`

Sent to all clients in the session when the agent mode is updated (via REST, WebSocket toggle, or slash command).

```json
{
  "type": "agent_mode_changed",
  "sessionId": "sess_abc123",
  "mode": "direct",
  "changedAt": "2026-04-04T10:06:00.000Z"
}
```

Clients should update their UI to reflect the new mode when this event is received.

---

#### `thinking`

Main agent is processing. Sent before planning begins.

```json
{
  "type": "thinking",
  "content": "Analyzing the request...",
  "timestamp": "2026-04-04T10:00:01.000Z"
}
```

---

#### `plan`

The agent's execution plan (DAG description).

```json
{
  "type": "plan",
  "nodes": [
    {
      "id": "node_1",
      "label": "Analyze auth module",
      "profile": "code",
      "dependsOn": []
    },
    {
      "id": "node_2",
      "label": "Write JWT implementation",
      "profile": "code",
      "dependsOn": ["node_1"]
    }
  ],
  "timestamp": "2026-04-04T10:00:02.000Z"
}
```

---

#### `node_start`

A worker node has started executing.

```json
{
  "type": "node_start",
  "nodeId": "node_1",
  "label": "Analyze auth module",
  "profile": "code",
  "timestamp": "2026-04-04T10:00:03.000Z"
}
```

---

#### `node_output`

Streaming output from a running worker node.

```json
{
  "type": "node_output",
  "nodeId": "node_1",
  "content": "Found 3 issues in auth.ts...",
  "timestamp": "2026-04-04T10:00:05.000Z"
}
```

---

#### `node_complete`

A worker node finished successfully.

```json
{
  "type": "node_complete",
  "nodeId": "node_1",
  "result": "Analysis complete. See findings.",
  "durationMs": 4200,
  "timestamp": "2026-04-04T10:00:07.000Z"
}
```

---

#### `node_error`

A worker node failed.

```json
{
  "type": "node_error",
  "nodeId": "node_1",
  "error": "Worker timed out after 300s",
  "retryCount": 1,
  "timestamp": "2026-04-04T10:00:08.000Z"
}
```

---

#### `finding`

A notable finding emitted during execution (retained to memory).

```json
{
  "type": "finding",
  "content": "JWT secret is stored in plaintext in .env.local",
  "severity": "high",
  "timestamp": "2026-04-04T10:00:09.000Z"
}
```

---

#### `memory`

A memory operation event (retain, recall, dedup, etc.).

```json
{
  "type": "memory",
  "op": "retain",
  "scope": "project-auth-refactor",
  "detail": "Stored JWT decision [decision]",
  "meta": {
    "recordCount": 1,
    "durationMs": 45
  },
  "timestamp": "2026-04-04T10:00:10.000Z"
}
```

---

#### `done`

Workflow completed.

```json
{
  "type": "done",
  "summary": "JWT authentication implemented across 4 files. Tests updated.",
  "durationMs": 42000,
  "nodesCompleted": 3,
  "nodesFailed": 0,
  "timestamp": "2026-04-04T10:00:50.000Z"
}
```

---

#### `error`

Top-level workflow error (not recoverable).

```json
{
  "type": "error",
  "message": "Anthropic API rate limit exceeded",
  "code": "RATE_LIMIT",
  "timestamp": "2026-04-04T10:01:00.000Z"
}
```

---

## Memory API (TypeScript)

Memory is self-hosted Redis behind a backend-neutral interface. The vocabulary
is **scope** (a memory partition) and **record** (a stored item). Full design:
[memory-architecture-v2.md](memory-architecture-v2.md).

### The `MemoryStore` interface

Declared in `packages/core/src/memory/store.ts`. Nothing in it names Redis —
that is the point of the seam. The only implementation today is
`RedisMemoryStore`.

```typescript
interface MemoryStore {
  /** Write records to a scope. `async: true` permits fire-and-forget batching. */
  retain(scope: string, writes: MemoryWrite[], opts?: { async?: boolean }): Promise<RetainOutcome>;

  /** Convenience single-record write. */
  retainOne(scope: string, content: string, context: string, tags?: string[]): Promise<RetainOutcome>;

  /** Retrieve records relevant to `query` from a single scope. */
  recall(scope: string, query: string, opts?: RecallQuery): Promise<RecallOutcome>;

  /** Whether `content` is a near-duplicate of something already in `scope`. */
  isDuplicate(scope: string, content: string, threshold?: number): Promise<boolean>;

  /** All known scopes with their record counts. */
  listScopes(): Promise<ScopeInfo[]>;

  /** Remove a scope and everything in it. */
  deleteScope(scope: string): Promise<void>;

  /** Liveness probe. Never throws — reports `healthy: false` instead. */
  health(): Promise<{ healthy: boolean }>;
}
```

Supporting types:

```typescript
interface MemoryWrite {
  content: string;
  /** Memory category — drives TTL and output formatting. */
  context: string;
  timestamp?: string;
  /** Stable idempotency key. Re-writing the same id updates in place. */
  documentId?: string;
  tags?: string[];
  /** Importance in [0,1]. */
  importance?: number;
  metadata?: Record<string, string>;
}

interface RecallQuery {
  maxTokens?: number;
  /** Drop records scoring below this. */
  minRelevance?: number;
}

interface RecalledRecord {
  content: string;
  context: string;
  timestamp: string;
  /** Match quality in [0,1]. */
  relevance: number;
  estimatedTokens?: number;
}

interface RecallOutcome { records: RecalledRecord[]; lowConfidence: boolean; tokensUsed: number }
interface RetainOutcome { ok: boolean; count: number }
interface ScopeInfo { id: string; recordCount: number }
```

`RecallQuery` is deliberately minimal. There are no budget tiers, no
temporal-diversity ratio, no fact-class filter — a parameter only some backends
honour is worse than no parameter.

`RetainOutcome.count` is the number of records **stored**, not writes submitted:
writes sharing a `documentId` collapse to one record. Test `ok`, not
`count === writes.length`.

### Usage

```typescript
import { RedisMemoryStore } from '@orionomega/core/memory/redis-store.js';

const store = new RedisMemoryStore({
  redis: { url: 'redis://localhost:6379' },
});

// Write
await store.retainOne('core', 'User prefers TypeScript over JavaScript', 'preference');

await store.retain('project-auth', [
  { content: 'Decided to use JWT with RS256 for stateless auth', context: 'decision' },
  { content: 'Existing session table in Postgres must be preserved', context: 'infrastructure' },
]);

// Read
const out = await store.recall('project-auth', 'JWT implementation', {
  maxTokens: 2048,
  minRelevance: 0.15,
});
for (const record of out.records) {
  console.log(`[${record.relevance.toFixed(2)}] ${record.content}`);
}
if (out.lowConfidence) console.warn('Weak match set — hedge accordingly.');
```

### Retrieval is lexical

Records are scored in process by `MemoryIndex`, which reproduces
`computeClientRelevance` exactly:

```
keywordScore  = |distinct query words present in content| / |query words|
trigramScore  = Jaccard(trigrams(normalize(query)), trigrams(normalize(content)))
relevance     = (keywordScore × 0.6 + trigramScore × 0.4) × lengthPenalty
```

There are **no embeddings and no LLM anywhere in retrieval**. Scoring is
deterministic, so the same query against the same corpus always returns the same
ordering.

---

## Agent Memory Tools

The agent is given three tools alongside `read_file` / `exec` / `write_file`.
They are rebuilt for every turn, because the per-turn call budget lives in the
builder's closure and must not leak forward.

### `memory_search`

Ranked snippets across stored memory.

| Arg | Type | Notes |
|-----|------|-------|
| `query` | string | Required. |
| `scope` | string | Defaults to the current conversation scope. |
| `limit` | number | Max results, 1–50 (default 8). |
| `minRelevance` | number | Relevance floor 0–1 (default 0.15). |

**Tool results are stored but not indexed.** File contents and command output
will never appear in search results — they are reachable only via
`memory_read`. This is stated in the tool description so the agent knows where
to look instead.

A search matching nothing returns an explicit machine-readable marker rather
than an empty success string:

```
NO_RESULTS — searched 4,212 indexed records in scope 'project-x' at relevance >= 0.15;
nothing matched "…".
Do not retry the same query. Either broaden the terms once, or use memory_read
on a segment listed in the MEMORY MAP.
```

Capped at **3 calls per turn**; further calls return `REFUSED —`.

### `memory_read`

A contiguous verbatim span, in order. Addressed either way:

| Arg | Type | Notes |
|-----|------|-------|
| `segment` | string | Segment id from the Memory Map, e.g. `seg:core:4`. |
| `around` | number | Centre `seq` to read around. |
| `radius` | number | Seq either side of `around` (default 10, max 100). |
| `scope` | string | Defaults to the current conversation scope. |

Output is capped at 30 000 chars, matching the inline caps `read_file` and
`exec` already use. Truncation appends an explicit continuation marker
(`continue with {around: N, radius: 10}`) rather than trailing off. Without the
cap a single call could pull an arbitrary fraction of the session back into
context and defeat the dynamic window entirely.

Capped at **2 calls per turn**.

### `memory_pin`

Durable facts that are always loaded and exempt from TTL.

| Arg | Type | Notes |
|-----|------|-------|
| `key` | string | Required. Short stable name, e.g. `deploy-target`. |
| `content` | string | The fact. **Omit to remove the pin.** |
| `scope` | string | Defaults to the current conversation scope. |

Keyed, so re-pinning the same key revises it instead of accumulating
duplicates. Pins are injected every turn, so they are meant to be used sparingly.

---

## ContextAssembler API (TypeScript)

Rebuilds the turn's context within a token budget: a verbatim hot window, a
budgeted recall block, and the deterministic Memory Map naming what exists
beyond the window. There is no compaction and no naive sliding window.

```typescript
import { ContextAssembler } from '@orionomega/core/memory';
import { RedisMemoryStore } from '@orionomega/core/memory/redis-store.js';

const store = new RedisMemoryStore({ redis: { url: 'redis://localhost:6379' } });
const assembler = new ContextAssembler(store, {
  hotWindowSize: 20,
  recallBudgetTokens: 16384,
  maxTurnTokens: 128000,
  conversationScope: 'conversation-sess_abc123',
  additionalScopes: ['core'],
  minRelevance: 0.15,
  memoryMapTokens: 600,
  persistPath: '/tmp/hot-window.json',  // Optional: survive restarts
});

// Add a message (retained to Redis asynchronously, in batches)
await assembler.push({
  role: 'user',
  content: 'How should we handle the database migration?',
  timestamp: new Date().toISOString(),
});

// Assemble context for the next API call
const ctx = await assembler.assemble('database migration strategy');
console.log('Prior context:', ctx.priorContext);   // budgeted recall, or null
console.log('Memory map:', ctx.memoryMap);         // table of contents, or null
console.log('Hot messages:', ctx.hotMessages.length);
console.log('Estimated tokens:', ctx.estimatedTokens);
```

The Memory Map is injected **whether or not recall matched anything**. Recall
answers "what is relevant to this turn"; the map answers "what else exists" —
and the second must not be conditional on the first.

`store` may be `null`, in which case the assembler degrades to the hot window
alone.

---

## Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Valid key but insufficient permissions |
| `NOT_FOUND` | 404 | Session, skill, or resource does not exist |
| `CONFLICT` | 409 | Session already exists |
| `RATE_LIMIT` | 429 | Anthropic API rate limit hit |
| `GATEWAY_ERROR` | 502 | Upstream service (Anthropic, Redis) unreachable |
| `TIMEOUT` | 504 | Worker or upstream timeout |

**Memory does not signal misses with exceptions.** An unknown scope recalls
empty rather than throwing, and `health()` reports `{ healthy: false }` rather
than rejecting — so a Redis outage never takes down a request path. Check the
returned value:

```typescript
const out = await store.recall('project-does-not-exist', 'query');
// out.records === []   — not an error

const { healthy } = await store.health();
if (!healthy) log.warn('Memory degraded — recall will under-return.');
```

---

## Rate Limits

OrionOmega applies rate limits via the gateway's `rate-limit.ts` module:

| Endpoint | Default Limit |
|----------|--------------|
| WebSocket messages | 60 per minute per session |
| `POST /sessions` | 10 per minute per IP |
| All other REST | 120 per minute per IP |

Limits are configurable. When exceeded, the response is `429 Too Many Requests` with a `Retry-After` header.

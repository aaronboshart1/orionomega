# API Reference

**OrionOmega v0.1.1 — Enterprise Documentation**

---

## Overview

OrionOmega exposes three API surfaces:

1. **Gateway REST API** — HTTP endpoints for sessions, skills, configuration, and health
2. **Gateway WebSocket API** — Real-time event streaming for all connected clients
3. **Hindsight Client API** — TypeScript library for direct memory operations

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
  "memory": {
    "hindsight": "connected",
    "banks": 3
  }
}
```

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
      "projectBank": "project-my-task"
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
  "projectBank": "project-my-task",
  "lastActivity": "2026-04-04T10:05:00.000Z"
}
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
  "hindsight": {
    "url": "http://localhost:8888",
    "defaultBank": "default",
    "retainOnComplete": true,
    "retainOnError": true
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
  "sessionId": "sess_abc123"
}
```

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
  "bank": "project-auth-refactor",
  "detail": "Stored JWT decision [decision]",
  "meta": {
    "itemCount": 1,
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

## Hindsight Client API (TypeScript)

Use the `HindsightClient` directly for custom memory integrations.

### Installation

The client is in `packages/hindsight` and published as `@orionomega/hindsight`.

### Basic Usage

```typescript
import { HindsightClient } from '@orionomega/hindsight';

const client = new HindsightClient(
  'http://localhost:8888',  // Hindsight server URL
  'my-namespace',           // Bank namespace (default: 'default')
  process.env.HINDSIGHT_API_KEY  // Optional API key
);

// Check connectivity
const health = await client.health();
console.log(health.status); // 'ok'
```

### Retaining Memories

```typescript
// Store a single memory
await client.retainOne('core', 'User prefers TypeScript over JavaScript', 'preference');

// Store multiple memories in one request
await client.retain('project-auth', [
  {
    content: 'Decided to use JWT with RS256 for stateless auth',
    context: 'decision',
    timestamp: new Date().toISOString(),
  },
  {
    content: 'Existing session table in Postgres must be preserved during migration',
    context: 'infrastructure',
    timestamp: new Date().toISOString(),
  },
]);
```

### Recalling Memories

```typescript
// Basic recall
const result = await client.recall('core', 'authentication preferences');
for (const memory of result.results) {
  console.log(`[${memory.relevance.toFixed(2)}] ${memory.content}`);
}

// Recall with options
const result = await client.recall('project-auth', 'JWT implementation', {
  maxTokens: 2048,          // Max tokens to return
  budget: 'mid',            // 'low' | 'mid' | 'high'
  minRelevance: 0.15,       // Filter threshold
  deduplicate: true,        // Remove near-duplicates
  deduplicationThreshold: 0.85,
});

// Recall with temporal diversity (recommended for production)
const result = await client.recallWithTemporalDiversity('core', 'auth decisions', {
  maxTokens: 4096,
  temporalDiversityRatio: 0.15,  // 15% from older time buckets
});

if (result.lowConfidence) {
  console.warn('Low-confidence recall — treat results with caution');
}
```

### Bank Management

```typescript
// Create a bank
await client.createBank('project-my-feature', {
  name: 'My Feature Project',
  skepticism: 3,  // 1–5: how aggressively to filter low-confidence memories
  literalism: 2,  // 1–5: query interpretation strictness
  empathy: 1,     // 1–5: emotional context weighting
});

// Check if a bank exists
const exists = await client.bankExists('project-my-feature');

// List all banks
const banks = await client.listBanksCached();
for (const bank of banks) {
  console.log(`${bank.bank_id}: ${bank.memory_count} memories`);
}
```

### Mental Models

```typescript
// Get a pre-synthesized model
const model = await client.getMentalModel('core', 'user-profile');
console.log(model.content);
console.log(`Sources: ${model.source_count}, refreshed: ${model.last_refreshed}`);

// Trigger a refresh
await client.refreshMentalModel('core', 'user-profile');
```

### Observability Hooks

```typescript
// Track I/O activity
client.onActivity = ({ connected, busy }) => {
  statusBar.update({ hindsightConnected: connected, hindsightBusy: busy });
};

// Log every memory operation
client.onIO = ({ op, bank, detail, meta }) => {
  logger.info(`Memory ${op} → ${bank}: ${detail}`, meta);
};
```

---

## ContextAssembler API (TypeScript)

For applications that need fine-grained context management.

```typescript
import { ContextAssembler } from '@orionomega/core/memory';
import { HindsightClient } from '@orionomega/hindsight';

const hs = new HindsightClient('http://localhost:8888');
const assembler = new ContextAssembler(hs, {
  hotWindowSize: 20,
  recallBudgetTokens: 8192,
  maxTurnTokens: 60000,
  conversationBank: 'conv-session-001',
  minRelevance: 0.15,
  adaptiveRecall: true,
  dynamicSummaryFallback: true,
  persistPath: '/tmp/hot-window.json',  // Optional: survive restarts
});

// Add a message (retains to Hindsight asynchronously)
await assembler.push({
  role: 'user',
  content: 'How should we handle the database migration?',
  timestamp: new Date().toISOString(),
});

// Assemble context for next API call
const ctx = await assembler.assemble('database migration strategy');
console.log('Query type:', ctx.queryType);
console.log('Prior context:', ctx.priorContext);
console.log('Hot messages:', ctx.hotMessages.length);
console.log('Confidence:', ctx.confidenceSummary);
```

---

## Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Valid key but insufficient permissions |
| `NOT_FOUND` | 404 | Session, skill, or resource does not exist |
| `CONFLICT` | 409 | Session already exists |
| `RATE_LIMIT` | 429 | Anthropic API rate limit hit |
| `GATEWAY_ERROR` | 502 | Upstream service (Anthropic, Hindsight) unreachable |
| `TIMEOUT` | 504 | Worker or upstream timeout |

`HindsightError` includes a `statusCode` field:
```typescript
try {
  await client.recall('nonexistent-bank', 'query');
} catch (err) {
  if (err instanceof HindsightError && err.statusCode === 404) {
    // Bank does not exist — create it first
  }
}
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

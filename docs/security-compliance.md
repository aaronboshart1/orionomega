# Security and Compliance Guide

**OrionOmega v0.1.1 — Enterprise Documentation**

**Classification: Internal — Enterprise Customers**

---

## Risk Posture Summary

OrionOmega v0.1.0 shipped with an **insecure default configuration** (auth disabled, binds to all interfaces). v0.1.1 retains these defaults for backward compatibility but this guide specifies the secure configuration required before any production or enterprise deployment.

**Before deploying to any environment accessible beyond localhost, complete all items in the [Secure Deployment Checklist](#secure-deployment-checklist).**

---

## Authentication

### Gateway API Key

OrionOmega supports SHA-256 hashed API key authentication. The plain key is never stored.

**Enable authentication:**

```yaml
gateway:
  auth:
    mode: api-key
    keyHash: <sha256-hex>
```

**Generate a key and hash:**
```bash
# Generate a random 32-byte key
KEY=$(openssl rand -hex 32)
echo "Your API key: $KEY"

# Hash it
HASH=$(echo -n "$KEY" | sha256sum | awk '{print $1}')
echo "keyHash: $HASH"
```

Store the plain key in your secrets manager (not in config files). Store only the hash in `config.yaml`.

**Important:** SHA-256 without a salt does not protect against rainbow table attacks. For deployments requiring NIST SP 800-63B compliance, use the `api-key` mode with a long random key (≥ 256 bits entropy) and rotate quarterly.

### Default Insecure Configuration

The default `mode: none` is safe only when:
- The gateway binds exclusively to `127.0.0.1`
- No reverse proxy exposes it to the network
- No untrusted processes run on the same host

### Anthropic API Key

The Anthropic API key is stored in `~/.orionomega/config.yaml` with `0o600` permissions (owner read/write only). Use environment variable interpolation to avoid storing the key on disk:

```yaml
models:
  apiKey: ${ANTHROPIC_API_KEY}
```

Set `ANTHROPIC_API_KEY` in your system's secret management solution (AWS Secrets Manager, HashiCorp Vault, etc.) and inject it at runtime.

---

## Network Security

### Bind Address

Never bind to `0.0.0.0` without authentication enabled:

```yaml
gateway:
  bind: '127.0.0.1'  # Loopback only (default — safe)
  # bind: '0.0.0.0'  # All interfaces — requires auth.mode: api-key
```

For multi-interface binding (e.g., localhost + a private network interface):
```yaml
gateway:
  bind: ['127.0.0.1', '10.0.1.5']
```

### TLS / HTTPS

OrionOmega's gateway does not implement TLS natively. In any multi-host deployment, terminate TLS at a reverse proxy:

**nginx example:**
```nginx
server {
    listen 443 ssl;
    ssl_certificate /etc/ssl/certs/orionomega.crt;
    ssl_certificate_key /etc/ssl/private/orionomega.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### CORS Policy

The default CORS policy restricts origins to `http://localhost:*`. For production:

```yaml
gateway:
  cors:
    origins:
      - 'https://your-dashboard.internal'
      - 'https://admin.your-company.com'
```

Wildcard origins (`*`) are never appropriate when `auth.mode: api-key` is in use — the API key in the `Authorization` header would be exposed to any origin.

---

## Data Security

### Memory Data (Redis)

**All memory records live in Redis** — conversation turns, user preferences,
decisions, findings, session summaries, run artifacts, and pinned facts. Redis
is authoritative: there is no second copy and no write-ahead log. Anyone with
read access to that Redis instance can read everything the agent remembers.

OrionOmega does not provision Redis. Securing it is your responsibility.

**What is stored, and what is searchable:**

- **Everything is stored. Not everything is indexed.** User and assistant turns
  and `tool_use` records join the search corpus. `system` records and
  **`tool_result` records are stored but NOT indexed for search** — the latter
  are the volume driver and are reachable only by an explicit range read
  (`memory_read`), never by `memory_search`. This narrows the exposure surface
  of tool output, but it does not remove it: the content is still in Redis.
- **Secrets in tool output are redacted before persistence.** `exec` output,
  environment dumps, and file reads are exactly where credentials land. Matched
  spans are replaced in place with a visible marker (e.g.
  `[REDACTED:pem_private_key]`) so the redaction is auditable rather than
  silent. The record itself is never dropped — `memory_read` promises a
  *contiguous verbatim span*, and a dropped record is a hole in the middle of
  one. The pattern set is a deliberately narrowed, high-precision subset
  (PEM/X.509 private keys, JWTs, explicit `api_key` / `password` /
  `client_secret` forms, DB connection strings with embedded credentials, and
  vendor-prefixed tokens). Broad matchers such as bare UUIDs are excluded
  because they would shred a large fraction of legitimate tool output.
- Redaction is a mitigation, not a guarantee. Treat the memory store as
  containing sensitive data regardless.

**Deployment requirements:**

- Bind Redis to loopback, or keep it on a trusted network segment. **Never
  expose it to the internet** — Redis is unauthenticated by default.
- Set `requirepass` (or an ACL user) and configure it via
  `memory.redis.password` / `memory.redis.username`, or embed it in
  `memory.redis.url`. The URL is redacted before it is written to any log.
- If Redis runs on a separate host, use TLS (`rediss://`, `memory.redis.tls:
  true`) or tunnel the connection (VPN, WireGuard, stunnel).
- Set a `keyPrefix` and/or a dedicated `db` when the instance is shared, so
  memory keys are distinguishable from other tenants of that Redis.
- Back up the Redis data directory according to your data retention policy.
  Durability is AOF `everysec` plus RDB snapshots — both land on disk.

**Data at rest:** the RDB snapshot and AOF file are plaintext on disk. Put the
Redis data directory on an encrypted volume (LUKS, FileVault, or an encrypted
EBS volume), and apply the same treatment to any backup you take of it.

**Deletion.** Because Redis is authoritative rather than an append-only log,
records can genuinely be deleted. Purging a scope removes it and everything in
it; a background GC pass also physically deletes expired, unpinned records
rather than merely filtering them at read time.

### Skill Secrets

Skill API keys and tokens are stored in `~/.orionomega/config.yaml` under the `skills.settings` block with `0o600` permissions. For enterprise deployments:

1. Use `password`-type skill settings (masked in UI, stored in `ctx.secrets`)
2. Never log `ctx.secrets` values — they are automatically redacted from logs
3. Rotate skill tokens on the same schedule as your other service credentials

### Log Security

Logs are written to `~/.orionomega/logs/orionomega.log`. Logs may contain:
- Conversation content excerpts (from `verbose` level logging)
- Memory content previews (from retain/recall operations)
- Worker output

**Secure log handling:**
```yaml
logging:
  level: info          # Avoid verbose/debug in production
  file: /var/log/orionomega/orionomega.log  # Use a managed log directory
  maxSize: '50MB'
  maxFiles: 5          # Rotate and limit retention
```

Apply appropriate filesystem permissions (`640` or `600`) to the log directory. Forward logs to a SIEM via syslog or a structured log shipper rather than reading the raw files.

### Workspace Artifacts

Worker output files are written to `workspace.path` (default: `~/orionomega/workspace`). These may contain code, documents, or data produced during workflow execution. Apply your organization's data classification policy to this directory.

---

## Input Validation and Injection Prevention

### Tool Input Validation

Skills that execute system commands should use `execFileSync` (not `execSync`) to prevent shell injection. All built-in skill handlers follow this pattern. When writing custom skills, enforce the same:

```typescript
// CORRECT — argument array prevents shell injection
import { execFileSync } from 'child_process';
execFileSync('git', ['clone', userInputUrl], { stdio: 'pipe' });

// INCORRECT — vulnerable to injection
import { execSync } from 'child_process';
execSync(`git clone ${userInputUrl}`);  // Never do this
```

### Prompt Injection

AI agent systems are inherently susceptible to prompt injection attacks, where malicious content in external data (web pages, files, API responses) attempts to override agent instructions. Mitigations:

1. **Human gates for destructive actions:** The `autonomous.humanGates` list requires human confirmation before executing `deploy`, `merge`, `delete`, or `destroy_vm`. Add any action that could have irreversible consequences:

```yaml
autonomous:
  humanGates: [deploy, merge, delete, destroy_vm, send_email, execute_payment]
```

2. **`planFirst: true`** (default): All workflows require an explicit plan before execution. Review plans before approving.

3. **`maxSpawnDepth: 3`** (default): Limits recursive agent spawning to prevent uncontrolled escalation.

4. **Web-fetched content:** The `web-fetch` skill retrieves arbitrary web content. Review content from untrusted sources before allowing it to influence decisions.

### XSS Prevention

The web dashboard uses `rehype-sanitize` to strip unsafe HTML from rendered content. Custom skill outputs that include HTML are sanitized before display.

---

## Audit Logging

OrionOmega's `audit.ts` module logs security-relevant events. Audit events include:

| Event | When |
|-------|------|
| `auth.success` | API key accepted |
| `auth.failure` | Invalid API key presented |
| `session.created` | New WebSocket session established |
| `session.terminated` | Session ended |
| `config.changed` | Configuration updated via `PATCH /config` |
| `skill.installed` | New skill installed |
| `skill.removed` | Skill removed |
| `workflow.started` | Workflow execution started |
| `workflow.completed` | Workflow completed |
| `autonomous.budget_exceeded` | Spend limit reached in autonomous mode |

Audit logs are written to a separate file (`audit.log` in the same directory as the main log) in structured JSON format for SIEM integration.

**Example audit event:**
```json
{
  "timestamp": "2026-04-04T10:00:00.000Z",
  "event": "auth.failure",
  "remoteAddr": "10.0.1.42",
  "reason": "invalid_key_hash"
}
```

---

## Autonomous Mode Security

Autonomous mode allows OrionOmega to execute workflows without per-task human approval. Use with caution.

**Required safeguards before enabling:**

1. Configure explicit spend and time limits:
```yaml
autonomous:
  enabled: true
  maxBudgetUsd: 25       # Hard cap — gateway refuses to proceed beyond this
  maxDurationMinutes: 120
```

2. List all irreversible actions in `humanGates`:
```yaml
autonomous:
  humanGates:
    - deploy
    - merge
    - delete
    - destroy_vm
    - send_email
    - push_to_production
```

3. Bind the gateway to localhost only when running autonomously unless you have verified all connected clients are trusted.

4. Review and approve the initial plan before the workflow begins (`planFirst: true` is required).

---

## Compliance Considerations

### Data Residency

All AI inference runs through the Anthropic API. Conversation content and workflow context are sent to Anthropic's servers. Review Anthropic's data processing agreement and terms of service for your jurisdiction's data residency requirements.

Memory data stored in Redis remains on your infrastructure.

### Data Retention

Records carry a per-category TTL, applied as a read-time filter and enforced by
a background GC pass that physically deletes expired, unpinned records. A TTL of
`0` means *never expires* — several categories (decisions, preferences,
architecture, lessons, infrastructure, run artifacts) are retained indefinitely
by design, and pinned records are exempt from expiry entirely.

That default is not a retention policy. For GDPR/CCPA compliance or
organizational data retention requirements:

1. Set explicit retention windows rather than relying on the built-in
   category TTLs, and verify the GC pass is running
2. On deletion requests, purge the relevant scopes — this genuinely removes the
   data, since Redis is authoritative rather than an append-only log
3. Include Redis backups (RDB/AOF snapshots) in the deletion workflow; deleting
   from the live instance does not touch a snapshot already on disk
4. Workspace artifacts in `workspace.path` should be included in your
   retention/deletion workflows

### Credential Rotation

| Credential | Location | Rotation procedure |
|-----------|----------|-------------------|
| Anthropic API key | `config.yaml` → `models.apiKey` or `${ANTHROPIC_API_KEY}` | Update key in Anthropic console, rotate env var or config, restart gateway |
| Gateway API key | SHA-256 hash in `config.yaml` | Generate new key, update hash in config, notify all clients, restart gateway |
| Skill tokens | `config.yaml` → `skills.settings` | Update via `orionomega skill setup <name>`, restart gateway |
| Redis password | `config.yaml` → `memory.redis.password` (or embedded in `memory.redis.url`) | Update `requirepass`/ACL on the Redis server, update config, restart gateway |

---

## Secure Deployment Checklist

Complete before any deployment accessible beyond localhost:

- [ ] `gateway.auth.mode: api-key` with a securely generated key hash
- [ ] `gateway.bind: '127.0.0.1'` or a specific private interface (not `0.0.0.0` unless with auth)
- [ ] `gateway.cors.origins` restricted to known origins (not `*`)
- [ ] TLS termination at reverse proxy for any external-facing deployment
- [ ] Anthropic API key injected via environment variable (`${ANTHROPIC_API_KEY}`), not hardcoded
- [ ] Skill secrets configured via `password`-type settings (not env vars in shell profiles)
- [ ] Redis bound to loopback or a trusted segment, `requirepass`/ACL set, TLS (`rediss://`) if multi-host
- [ ] Redis data directory (RDB + AOF) on an encrypted volume
- [ ] `logging.level: info` (not `verbose` or `debug` in production)
- [ ] Log directory permissions: `640` or `600`; log forwarding to SIEM configured
- [ ] `autonomous.humanGates` populated with all destructive action types
- [ ] `autonomous.maxBudgetUsd` set if autonomous mode is enabled
- [ ] Workspace directory (`workspace.path`) permissions reviewed
- [ ] Data retention policy applied to Redis storage (including backups) and workspace artifacts
- [ ] Anthropic DPA reviewed for data residency requirements
- [ ] Credential rotation schedule established (recommend: quarterly)

---

## Known Security Limitations (v0.1.1)

These are documented limitations that will be addressed in future releases:

| Limitation | Risk | Workaround |
|-----------|------|-----------|
| API key authentication uses SHA-256 without salt | Rainbow table attack on stolen config files | Use a key with ≥ 256 bits entropy; rotate regularly |
| No built-in TLS | MITM on non-loopback traffic | Mandatory: terminate TLS at reverse proxy |
| Prompt injection not fully mitigated | External content may influence agent behavior | Use `humanGates` for destructive actions; review plans |
| Redis is unauthenticated by default | Any process that can reach the port reads and writes all memory | Bind to loopback; set `requirepass`/ACL; firewall port 6379 |
| Memory records at rest are plaintext in RDB/AOF | Data-at-rest exposure via disk or backup theft | Put the Redis data directory and its backups on an encrypted volume |
| Tool output is stored (unindexed) after pattern-based redaction | A secret in a novel format may survive redaction | Avoid printing credentials in `exec`; purge the scope if one leaks |
| No multi-tenant isolation | Scopes partition memory, but not by user or tenant | Run a separate instance per tenant, or a separate `memory.redis.db`/`keyPrefix` |
| Workspace artifacts not encrypted | Data at rest exposure | Use encrypted filesystem for workspace directory |

For security vulnerability reports, contact: security@orionomega.dev (or submit via your enterprise support channel).

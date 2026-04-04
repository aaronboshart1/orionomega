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

### Memory Data (Hindsight)

Conversation memories, user preferences, decisions, and session summaries are stored in the Hindsight server. These may contain sensitive information.

**Deployment requirements:**
- Hindsight must run on a trusted network segment (not exposed to the internet)
- If Hindsight runs on a separate host, the connection between OrionOmega and Hindsight must traverse an encrypted channel (VPN, WireGuard, or mTLS)
- Back up the Hindsight data store according to your data retention policy
- Configure `hindsight.url` with HTTPS if the Hindsight server supports it

**Data at rest:** Hindsight's storage backend (typically SQLite or PostgreSQL) should use disk encryption (LUKS, FileVault, or encrypted EBS volumes in cloud deployments).

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

Memory data stored in Hindsight remains on your infrastructure.

### Data Retention

OrionOmega does not implement automatic memory expiration. For GDPR/CCPA compliance or organizational data retention policies:

1. Implement a scheduled job to delete Hindsight memories older than your retention window
2. On user deletion requests, delete all banks associated with that user's namespace
3. Workspace artifacts in `workspace.path` should be included in your retention/deletion workflows

### Credential Rotation

| Credential | Location | Rotation procedure |
|-----------|----------|-------------------|
| Anthropic API key | `config.yaml` → `models.apiKey` or `${ANTHROPIC_API_KEY}` | Update key in Anthropic console, rotate env var or config, restart gateway |
| Gateway API key | SHA-256 hash in `config.yaml` | Generate new key, update hash in config, notify all clients, restart gateway |
| Skill tokens | `config.yaml` → `skills.settings` | Update via `orionomega skill setup <name>`, restart gateway |
| Hindsight API key | `HINDSIGHT_API_KEY` env var | Rotate on Hindsight server, update env var, restart gateway |

---

## Secure Deployment Checklist

Complete before any deployment accessible beyond localhost:

- [ ] `gateway.auth.mode: api-key` with a securely generated key hash
- [ ] `gateway.bind: '127.0.0.1'` or a specific private interface (not `0.0.0.0` unless with auth)
- [ ] `gateway.cors.origins` restricted to known origins (not `*`)
- [ ] TLS termination at reverse proxy for any external-facing deployment
- [ ] Anthropic API key injected via environment variable (`${ANTHROPIC_API_KEY}`), not hardcoded
- [ ] Skill secrets configured via `password`-type settings (not env vars in shell profiles)
- [ ] Hindsight server on trusted network; traffic encrypted if multi-host
- [ ] `logging.level: info` (not `verbose` or `debug` in production)
- [ ] Log directory permissions: `640` or `600`; log forwarding to SIEM configured
- [ ] `autonomous.humanGates` populated with all destructive action types
- [ ] `autonomous.maxBudgetUsd` set if autonomous mode is enabled
- [ ] Workspace directory (`workspace.path`) permissions reviewed
- [ ] Data retention policy applied to Hindsight storage and workspace artifacts
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
| Hindsight connection is unauthenticated by default | Any local process can read/write memories | Firewall Hindsight port; bind to loopback |
| No per-user bank isolation in single-namespace deployments | Multi-tenant data co-mingling | Use separate namespaces per tenant |
| Workspace artifacts not encrypted | Data at rest exposure | Use encrypted filesystem for workspace directory |

For security vulnerability reports, contact: security@orionomega.dev (or submit via your enterprise support channel).

# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email the maintainer directly. You will receive an acknowledgement within 48 hours and a resolution timeline within 5 business days.

---

## Intentional Access Model

OrionOmega is designed to give an AI orchestration engine **exec-level access to your local environment**. This is intentional and central to its value proposition. Before installing, understand what that means:

### What the gateway can do

- Execute arbitrary shell commands via skill handlers (`scripts/*.ts` run as child processes with `tsx`)
- Read and write files anywhere the running user has permission
- Make outbound HTTP/HTTPS requests to any host
- Interact with external services (GitHub, Linear, etc.) using credentials you provide
- Spawn sub-agents that can themselves spawn further sub-agents (bounded by `maxSpawnDepth`)

### Why this is intentional

OrionOmega runs **locally, under your user account**, doing work on your behalf. It is an automation engine, not a sandboxed plugin host. Restricting filesystem or network access at the framework level would break legitimate use cases (writing code, committing to git, calling APIs, managing files).

The safety model is:

1. **Plan-first** — the main agent proposes a DAG of tasks; nothing executes until you approve
2. **Transparent execution** — every tool call, command, and finding streams to your interface in real-time
3. **Audit trail** — Hindsight retains a temporal log of everything the agent learned and did
4. **You control the credentials** — skills only have access to the auth tokens you explicitly provide

### What this is NOT

- A multi-tenant service accessible over the internet
- A production API gateway that needs to defend against untrusted external callers
- A sandboxed execution environment that restricts the agent's capabilities

### Recommended hardening for your deployment

If you expose the gateway beyond localhost, apply these settings in `~/.orionomega/config.yaml`:

```yaml
gateway:
  bind: '127.0.0.1'        # Never bind to 0.0.0.0 on a shared or internet-facing machine
  auth:
    mode: api-key           # Enable API-key-hash authentication
    keyHash: <sha256-of-your-key>
  cors:
    origins:
      - 'http://localhost:3000'   # Restrict to your actual web UI origin
```

Generate a key hash:
```bash
echo -n "your-gateway-key" | sha256sum | awk '{print $1}'
```

### Skill handler security

Skill handlers are TypeScript/shell scripts that run with the full privileges of the OrionOmega process. When installing third-party skills:

- Review `manifest.json` — especially `tools[].handler` paths and declared permissions
- Review the handler script itself before enabling the skill
- Use `orionomega skill list` to see what is currently loaded

Built-in skills (`github`, `linear`, `web-search`, `web-fetch`) are audited as part of each release.

### API key storage

Your Anthropic API key is stored in `~/.orionomega/config.yaml`, written with `0o600` permissions (readable only by your user). Do not commit this file to source control.

The `.gitignore` includes `.orionomega/` and `config.yaml` patterns to help prevent accidental commits.

---

## Known Limitations

- The gateway does not implement rate limiting on the REST or WebSocket endpoints
- Session tokens are not rotated automatically
- No CSP headers are set on the web UI development server (Next.js default)

These are acceptable trade-offs for a local-first developer tool. If you expose the gateway to a network, firewall it appropriately.

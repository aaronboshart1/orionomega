# OrionOmega v0.1.0 — Comprehensive Security Review

**Classification:** CONFIDENTIAL
**Report Date:** 2026-03-29
**Version:** 1.0
**Prepared By:** Automated Security Analysis Pipeline
**Target:** OrionOmega AI Agent Orchestration Platform (all packages)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope & Methodology](#2-scope--methodology)
3. [External Threat Landscape](#3-external-threat-landscape)
4. [Code Security Findings](#4-code-security-findings)
5. [Infrastructure & CI/CD Security Findings](#5-infrastructure--cicd-security-findings)
6. [Dependency Vulnerabilities](#6-dependency-vulnerabilities)
7. [Enterprise Readiness Gap Analysis](#7-enterprise-readiness-gap-analysis)
8. [Prioritized Remediation Roadmap](#8-prioritized-remediation-roadmap)
9. [Security Architecture Recommendations](#9-security-architecture-recommendations)
10. [Appendix: References](#10-appendix-references)

---

## 1. Executive Summary

### Overall Risk Posture: 🔴 HIGH

OrionOmega is a v0.1.0 AI agent orchestration platform with a **significant and largely undefended attack surface**. While the codebase demonstrates some security awareness (timing-safe password comparison, secret masking, `rehype-sanitize` for XSS prevention, use of `execFileSync` in skill handlers), the system's default configuration is **insecure by design** — shipping with authentication disabled, binding to all interfaces (`0.0.0.0`), wildcard CORS, and a public unencrypted third-party endpoint as the default memory store.

The project faces not only traditional web application vulnerabilities but also an entirely new class of AI-specific threats — prompt injection, memory poisoning, lateral movement through agent trust relationships, and tool-call hijacking — that are rapidly being weaponized in production environments.

### Findings Summary

| Severity | Code | Infrastructure | Total |
|----------|------|----------------|-------|
| 🔴 **Critical** | 3 | 5 | **8** |
| 🟠 **High** | 6 | 8 | **14** |
| 🟡 **Medium** | 9 | 12 | **21** |
| 🟢 **Low** | 7 | 7 | **14** |
| **Total** | **25** | **32** | **57** |

### Critical Risk Highlights

1. **Default authentication is `none`** — all APIs, WebSocket, and config endpoints are completely open
2. **Unrestricted shell command execution** — AI-generated commands run with full host access, no sandboxing
3. **SSRF via `web_fetch`** — no URL validation enables cloud metadata theft and internal network scanning
4. **Default Hindsight endpoint is a public, unencrypted personal DDNS address** — all conversation data, tool outputs, and memory sent in plaintext without authentication
5. **API keys stored in plaintext** in YAML config, environment variables, and Docker command lines
6. **Zero security scanning in CI/CD** — no SAST, no dependency audit, no container scanning, tests disabled
7. **All GitHub Actions pinned to mutable version tags** — vulnerable to supply chain attacks (cf. 2025 `tj-actions` incident)
8. **Install script uses `curl | sh`** — arbitrary code execution via DNS poisoning or CDN compromise

---

## 2. Scope & Methodology

### What Was Reviewed

| Component | Files/Artifacts | Method |
|-----------|----------------|--------|
| **Core Package** | `cli.ts`, `config/loader.ts`, `config/types.ts`, `anthropic/client.ts`, `anthropic/agent-loop.ts`, `anthropic/tools.ts`, `orchestration/agent-sdk-bridge.ts`, `orchestration/executor.ts`, `commands/setup.ts`, `commands/github-device-auth.ts` | Manual static analysis |
| **Gateway Package** | `auth.ts`, `server.ts`, `websocket.ts`, `sessions.ts`, `types.ts`, `routes/config.ts`, `routes/skills.ts` | Manual static analysis |
| **Skills SDK** | `executor.ts`, `loader.ts`, `settings.ts`, `skill-config.ts` | Manual static analysis |
| **Hindsight Client** | `client.ts` | Manual static analysis |
| **Web UI** | `lib/gateway.ts`, React components | Manual static analysis |
| **Default Skills** | `github/handlers/*.js`, `web-fetch/handlers/web_fetch.js`, `web-search/handlers/web_search.js` | Manual static analysis |
| **Infrastructure** | `docker-compose.yml`, all Dockerfiles, `install.sh`, `.replit`, `post-merge.sh`, `nginx.conf`, `.env.example`, `config.yaml`, `ci.yml` | Configuration review |
| **Dependencies** | 7 `package.json` files, `pnpm-workspace.yaml`, `pnpm-lock.yaml` (3,832 lines), ~40 external npm packages | Manifest analysis |
| **Repository Structure** | 486 source files across all packages | Structural analysis |

### Analysis Methods

- **Manual Static Analysis** against OWASP Top 10, OWASP LLM Top 10 (2025), CWE database, and Node.js security best practices
- **Infrastructure Configuration Review** against CIS benchmarks, Docker security best practices, and GitHub Actions hardening guides
- **Dependency Analysis** using manifest review and known CVE cross-referencing
- **External Threat Intelligence** — web research covering OpenClaw/NanoClaw CVEs, agent framework vulnerabilities (2023-2026), NIST AI RMF, MITRE ATLAS, and academic security research (NeurIPS 2024/2025)
- **Enterprise Readiness Assessment** against SOC 2 Type II, ISO/IEC 27001:2022, ISO/IEC 42001, and EU AI Act requirements

### Tools & Frameworks Referenced

- OWASP Top 10 for LLM Applications (2025)
- OWASP Agentic AI Security Top 10 (2026 draft)
- NIST AI Risk Management Framework (AI 100-1, AI 600-1)
- MITRE ATLAS v5.4.0
- CWE/CVE databases (NVD, GHSA)
- Industry research from Unit 42, Lakera, Lasso Security, NVIDIA, Kaspersky

---

## 3. External Threat Landscape

### 3.1 OpenClaw/NanoClaw — Lessons for OrionOmega

OpenClaw, the most widely deployed open-source AI agent platform (100K+ developers, 40K+ exposed instances), has accumulated **12+ CVEs in 2026 alone**, including:

| CVE | Type | CVSS | Relevance to OrionOmega |
|-----|------|------|------------------------|
| CVE-2026-25253 | One-click RCE via WebSocket token theft | 8.8 | OrionOmega's WebSocket has identical auth-bypass risk |
| CVE-2026-30741 | Prompt injection → RCE via terminal tools | Critical | OrionOmega's `exec` tool has same attack path |
| CVE-2026-32915 | Sandbox escape (subagent → parent scope) | Critical | OrionOmega's `bypassPermissions` mode enables this |
| CVE-2026-32918 | Session state escape across agents | Critical | OrionOmega's session files are unencrypted and unprotected |
| CVE-2026-26322 | SSRF in gateway tool | 7.6 | OrionOmega's `web_fetch` has no URL validation |
| CVE-2026-26329 | Path traversal via file upload | High | OrionOmega's session ID path is similarly vulnerable |

**Key Takeaway:** OpenClaw's vulnerabilities are a direct preview of OrionOmega's risk profile. The architectures share critical design patterns — unauthenticated gateways, unrestricted shell access, WebSocket trust assumptions, plaintext credential storage, and no agent sandboxing. **Every major OpenClaw CVE class has an equivalent finding in this report.**

Additionally, **824 malicious skills** were discovered in OpenClaw's marketplace (ClawHub) by late February 2026, including 39 distributing the Atomic macOS Stealer. OrionOmega's skill system (`skills-sdk`) faces identical supply chain risks if a public marketplace is introduced.

NanoClaw's response — Docker container isolation per agent, modular architecture, scoped permissions — provides a useful reference architecture for OrionOmega remediation (see Section 9).

### 3.2 OWASP LLM Top 10 Applicability

| OWASP ID | Vulnerability | OrionOmega Exposure | Status |
|----------|---------------|---------------------|--------|
| LLM01 | Prompt Injection | 🔴 **Fully exposed** — no input sanitization, no trust boundaries | Not mitigated |
| LLM02 | Insecure Output Handling | 🔴 **Fully exposed** — agent outputs passed directly to shell, filesystem | Not mitigated |
| LLM03 | Training Data Poisoning | 🟡 Medium — Hindsight memory bank could be poisoned | Not mitigated |
| LLM04 | Model Denial of Service | 🟠 High — no rate limiting, unbounded request bodies | Not mitigated |
| LLM05 | Supply Chain Vulnerabilities | 🟠 High — unpinned actions, floating Docker tags, no SBOM | Not mitigated |
| LLM06 | Sensitive Information Disclosure | 🔴 **Fully exposed** — API keys in env vars, config, process memory | Partially mitigated (masking exists) |
| LLM07 | Insecure Plugin Design | 🔴 **Fully exposed** — skills execute arbitrary binaries with full env | Not mitigated |
| LLM08 | Excessive Agency | 🔴 **Fully exposed** — `bypassPermissions` mode, unrestricted `exec` | Not mitigated |
| LLM09 | Overreliance | 🟡 Medium — no output validation or guardrails | Not mitigated |
| LLM10 | Model Theft | 🟢 Low — uses external API, no local model weights | N/A |

### 3.3 Recent CVEs in Similar Agent Frameworks

| CVE | Framework | Type | CVSS | Year |
|-----|-----------|------|------|------|
| CVE-2025-68664 | LangChain Core (Python) | Serialization injection → secret exfiltration + RCE | **9.3** | 2025 |
| CVE-2025-68665 | LangChain.js | Serialization injection → secret exfiltration | **8.6** | 2025 |
| CVE-2024-6091 | AutoGPT v0.5.1 | Shell command denylist bypass → RCE | **9.8** | 2024 |
| CVE-2024-36480 | LangChain | RCE via `eval()` in tool executor | **9.0** | 2024 |
| CVE-2024-27564 | ChatGPT (OpenAI) | SSRF — 10,000+ attacks in one week | High | 2024 |
| CVE-2025-53773 | GitHub Copilot | Prompt injection → YOLO mode → RCE | High | 2025 |
| CVE-2025-32711 | Microsoft 365 Copilot | Zero-click memory exfiltration (EchoLeak) | High | 2025 |
| CVE-2025-54135 | Cursor IDE | Indirect prompt injection | High | 2025 |

### 3.4 Emerging Attack Patterns

| Attack Pattern | Research Source | Success Rate | Applicability |
|----------------|----------------|--------------|---------------|
| **MINJA** (Memory Injection) | NeurIPS 2025 | >95% | High — Hindsight memory bank |
| **AgentPoison** | NeurIPS 2024 | >80% | High — any persistent memory |
| **Prompt Infection** (worm propagation) | Security Boulevard 2025 | Full graph compromise | High — worker→orchestrator chain |
| **Agent Smith** (exponential spread) | 2025 Research | Up to 1M agents | Medium — multi-agent deployments |
| **IdentityMesh** (lateral movement) | Lasso Security | N/A | High — agents hold multiple service tokens |
| **Tool Shadowing** (MCP hijack) | PoC demonstrated | N/A | Medium — skill system could be abused |

---

## 4. Code Security Findings

### 4.1 Complete Findings Table

| ID | Severity | Category | File/Location | Description | Recommended Fix | Priority |
|----|----------|----------|---------------|-------------|-----------------|----------|
| C-1 | 🔴 Critical | Command Injection (CWE-78) | `packages/core/src/anthropic/tools.ts:81-117`, `orchestration/agent-sdk-bridge.ts` | Unrestricted shell command execution via `exec` tool. AI-generated commands pass directly to `/bin/bash` with no sanitization, allowlisting, or sandboxing. `cwd` parameter is user-controlled. Agent SDK bridge can run with `bypassPermissions` auto-approving all tool calls. | Implement command allowlist/blocklist; never default to `bypassPermissions`; run agents in containers/sandboxes (nsjail, firejail); add filesystem boundary enforcement; log all commands to audit trail | P0 — Immediate |
| C-2 | 🔴 Critical | Missing Authentication (CWE-306) | `packages/core/src/config/loader.ts:32`, `packages/gateway/src/server.ts:60-64`, `websocket.ts:116-123` | Default `auth.mode: 'none'` with bind `0.0.0.0`. All REST APIs, WebSocket, config write endpoint, and session data accessible without authentication. Fallback config on load failure is even more permissive with wildcard CORS. | Change default to `api-key` auth; default bind to `127.0.0.1`; require auth for sensitive endpoints even in dev; startup warning if auth=none and bind!=localhost | P0 — Immediate |
| C-3 | 🔴 Critical | SSRF (CWE-918) | `default-skills/web-fetch/handlers/web_fetch.js:30-37` | `web_fetch` handler accepts any URL with no restrictions. Enables access to cloud metadata (`169.254.169.254`), internal network scanning, localhost services, data exfiltration, and potentially `file://` protocol. | Implement URL allowlist/blocklist (block RFC 1918, link-local, loopback, cloud metadata); block non-HTTP(S) protocols; resolve DNS before request; add egress proxy with audit logging | P0 — Immediate |
| H-1 | 🟠 High | Weak Cryptography (CWE-916) | `packages/gateway/src/auth.ts:82-84` | `hashPassword()` uses plain SHA-256 without salt. A single GPU can compute billions of SHA-256 hashes/sec. Identical passwords produce identical hashes (rainbow table vulnerable). | Use `scrypt`, `argon2`, or `bcrypt` with random salt | P0 — Immediate |
| H-2 | 🟠 High | Timing Attack (CWE-208) | `packages/gateway/src/auth.ts:56-57` | Token signature comparison uses `!==` (not timing-safe). Password verification correctly uses `timingSafeEqual`, but token validation does not. Enables byte-by-byte signature forging via timing measurements. | Use `crypto.timingSafeEqual()` with buffer length check for token signatures | P0 — Immediate |
| H-3 | 🟠 High | Permissive CORS (CWE-942) | `packages/gateway/src/server.ts:494-499`, `config/loader.ts:34-36` | Default CORS patterns `http://*:*` and `https://*` match any origin. `originAllowed()` converts `*` to `.*` regex, so `http://*:*` becomes `^http://.*:.*$` matching `http://evil.com:1234`. | Default to `['http://localhost:*']` only; validate patterns don't become wildcards; require explicit opt-in for non-localhost origins | P0 — Immediate |
| H-4 | 🟠 High | Resource Exhaustion (CWE-400) | `packages/gateway/src/routes/config.ts:30-37`, `routes/skills.ts:19-26` | `readBody()` reads entire HTTP request into memory with no size limit. Attacker can send multi-GB body to OOM-kill the server. | Add `maxBytes` parameter (default 1MB); destroy request on exceeding limit | P1 — Next Sprint |
| H-5 | 🟠 High | Path Traversal (CWE-22) | `packages/gateway/src/sessions.ts:305-307` | `sessionFilePath()` uses session ID directly in path construction. WebSocket path does not apply `sessionMatch` regex validation. Crafted ID like `../../etc/passwd` could read/write outside sessions directory. | Validate session ID against strict `[a-z0-9_-]` pattern at function level; reject IDs that don't match | P1 — Next Sprint |
| H-6 | 🟠 High | Credential Exposure (CWE-522) | `orchestration/agent-sdk-bridge.ts:439,681`, `gateway/src/server.ts:114`, `config/loader.ts` | Anthropic API key stored in plaintext YAML, set as environment variable for every spawned agent process, readable via `/proc/<pid>/environ`, spread to child processes. | Use secrets manager or OS keychain; set config file permissions to 0600; pass key via file descriptor instead of env var; use short-lived derived tokens | P1 — Next Sprint |
| M-1 | 🟡 Medium | No Rate Limiting (CWE-770) | `packages/gateway/src/server.ts` (entire router) | No rate limiting on any REST or WebSocket endpoint. Enables brute-force attacks, AI API credit exhaustion, and resource flooding. | Implement per-IP token bucket rate limiting; add WebSocket connection limits; rate limit auth attempts (5 failures → 15min cooldown) | P2 — This Quarter |
| M-2 | 🟡 Medium | Missing Security Headers (CWE-693) | `packages/gateway/src/server.ts` | No `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `X-XSS-Protection`, or `Referrer-Policy` headers. | Add standard security headers to all HTTP responses | P2 — This Quarter |
| M-3 | 🟡 Medium | Path Traversal (CWE-22) | `packages/skills-sdk/src/skill-config.ts:16-17` | `configPath()` uses `skillName` directly in path construction. Server-side regex restricts REST API path, but function is called from multiple unprotected sites. | Validate `skillName` at function level against strict pattern | P2 — This Quarter |
| M-4 | 🟡 Medium | ReDoS (CWE-1333) | `packages/gateway/src/server.ts:494-499` | CORS `originAllowed()` creates regex from user-configured patterns via `*` → `.*` replacement. Complex patterns could cause catastrophic backtracking. | Pre-compile and test CORS patterns at startup; use non-greedy matching | P2 — This Quarter |
| M-5 | 🟡 Medium | Untrusted Execution (CWE-426) | `packages/skills-sdk/src/executor.ts:36-39` | `SkillExecutor` spawns handler scripts from skill manifests at arbitrary paths. Full `process.env` propagated to child processes including secrets. | Validate handler paths within skill directory; restrict to `.js`/`.mjs` via `node`; filter environment variables | P2 — This Quarter |
| M-6 | 🟡 Medium | Information Leak (CWE-209) | `routes/config.ts:250`, `routes/skills.ts:97`, `server.ts:544,589` | Error handlers return `err.message` to client, potentially exposing file paths, dependency versions, and internal state. | Return generic error messages to clients; log details server-side only | P2 — This Quarter |
| M-7 | 🟡 Medium | Prompt Injection (CWE-74) | `packages/gateway/src/websocket.ts:272-349` | User chat messages pass directly to AI agent without sanitization. `replyToContent` feature allows injecting content attributed to different roles. Web-fetched content creates indirect injection path. | Implement input sanitization; add tool execution guardrails; content safety filtering; validate `replyToRole` against allowlist | P2 — This Quarter |
| M-8 | 🟡 Medium | Improper Error Handling (CWE-755) | `packages/gateway/src/server.ts:25-32` | `uncaughtException` handler logs full error to stderr then calls `process.exit(1)` without graceful shutdown. May leave sessions in corrupted state and leak internal paths. | Call `shutdown()` instead of `process.exit(1)`; sanitize error before logging | P2 — This Quarter |
| M-9 | 🟡 Medium | Insecure Deserialization (CWE-502) | `packages/gateway/src/websocket.ts:214-225` | WebSocket messages parsed with `JSON.parse()` and cast directly to `ClientMessage` with minimal validation. `attachments` field allows arbitrary `data` fields with no size/content validation. | Implement Zod schema validation (already a dependency) for all incoming WebSocket messages | P2 — This Quarter |
| L-1 | 🟢 Low | Missing Authentication (CWE-306) | `packages/hindsight/src/client.ts:526-529` | Hindsight client makes requests without authentication headers. Network-accessible Hindsight server allows any client to read/write memory banks. | Add authentication support (API key, mTLS) to Hindsight client | P3 — Hardening |
| L-2 | 🟢 Low | Insecure Permissions (CWE-276) | `packages/core/src/config/loader.ts:228` | `writeFileSync()` creates config file with default umask (0644), making it world-readable. File contains API key in plaintext. | Set file permissions to `0600` after writing | P3 — Hardening |
| L-3 | 🟢 Low | Hardcoded Credential (Informational) | `packages/core/src/commands/github-device-auth.ts:13` | GitHub OAuth App client ID hardcoded. Public value per design, but rotation requires code change. | Make configurable | P3 — Hardening |
| L-4 | 🟢 Low | Unhandled Exception (CWE-20) | `packages/web/src/lib/gateway.ts:241` | `JSON.parse()` on WebSocket data without try-catch. Non-JSON data crashes React component. | Wrap in try-catch | P3 — Hardening |
| L-5 | 🟢 Low | Missing Encryption (CWE-311) | `packages/gateway/src/sessions.ts` | Session data (full conversation history) stored as plaintext JSON in `~/.orionomega/sessions/`. | Encrypt session files at rest or restrict file permissions | P3 — Hardening |
| L-6 | 🟢 Low | Resource Exhaustion (CWE-400) | `packages/gateway/src/websocket.ts` | No `maxPayload` configured on WebSocket server. `ws` library defaults to 100MB. | Set `maxPayload` to 10MB in WebSocketServer options | P3 — Hardening |
| L-7 | 🟢 Low | Log Injection (CWE-117) | `packages/gateway/src/server.ts:54` | Log level set via environment variable and propagated to child processes. Attacker with env var access could enable verbose logging to expose sensitive data. | Validate log level against allowlist before setting | P3 — Hardening |

---

## 5. Infrastructure & CI/CD Security Findings

### 5.1 Complete Findings Table

| ID | Severity | Category | File/Location | Description | Recommended Fix | Priority |
|----|----------|----------|---------------|-------------|-----------------|----------|
| D-01 | 🔴 Critical | Supply Chain — Docker | `docker-compose.yml:74`, `install.sh:214` | Hindsight container uses floating `:latest` tag. `ghcr.io/vectorize-io/hindsight:latest` is mutable — a compromised upstream push silently replaces the running container, and Hindsight receives the raw `ANTHROPIC_API_KEY`. | Pin to `ghcr.io/vectorize-io/hindsight@sha256:<verified-digest>`; use Renovate to track updates | P0 — Immediate |
| C-01 | 🔴 Critical | Supply Chain — CI/CD | `ci.yml` (13 action references) | All GitHub Actions pinned to mutable version tags (`@v4`, `@v3`, `@v2`, `@v1`), not SHA digests. Compromised upstream action (cf. 2025 `tj-actions` incident) executes malicious code with `GITHUB_TOKEN` access. `actions/create-release@v1` is deprecated/archived. | Pin all actions to full SHA digests | P0 — Immediate |
| N-01 | 🔴 Critical | Data Exfiltration | `.env.example:65`, `config.yaml:76` | Default Hindsight endpoint is `http://aaronboshart.ddns.net:8888` — a personal DDNS hostname on a residential IP. All conversation data, tool outputs, and memory sent in plaintext without authentication. | Remove entirely; default to `http://localhost:8888` or require explicit opt-in | P0 — Immediate |
| S-01 | 🔴 Critical | Credential Exposure | `config.yaml:13,118,125` | `anthropic.apiKey: sk-ant-...`, `github.apiToken: ghp_...`, `linear.apiKey: lin_...` stored unencrypted with no permission enforcement. | Enforce `chmod 600` at creation; support `${ENV_VAR}` substitution; document Vault/Secrets Manager integration | P0 — Immediate |
| L-01 | 🔴 Critical | Supply Chain — Install | `install.sh:195` | `curl -fsSL https://get.docker.com \| sh` — DNS poisoning or CDN compromise gives arbitrary code execution with root access. | Use distro package managers (`apt-get install docker.io`) with verified checksums | P0 — Immediate |
| D-02 | 🟠 High | Supply Chain — Docker | All Dockerfiles | Node.js base images not pinned to digest. Upstream compromise or breaking change injected silently. | Pin all base images to SHA256 digest | P1 — Next Sprint |
| D-03 | 🟠 High | Supply Chain — Docker | All Dockerfiles | `pnpm` installed without version pinning in Dockerfiles. | Pin `pnpm` to exact version | P1 — Next Sprint |
| D-04 | 🟠 High | Debug Exposure | `docker-compose.yml:79` | Hindsight debug port 9999 exposed to host network. | Remove debug port mapping in production compose file | P1 — Next Sprint |
| C-02 | 🟠 High | Missing Security Controls | `ci.yml` | Zero security scanning in CI — no SAST, no `npm audit`/Snyk, no Trivy/Grype container scanning. | Add `pnpm audit`, CodeQL/Semgrep SAST, Trivy image scan to CI pipeline | P1 — Next Sprint |
| C-03 | 🟠 High | Tests Disabled | `ci.yml:91` | Tests explicitly disabled with `if: false`. No automated quality gate on any code merge. | Re-enable tests; add test coverage requirements | P1 — Next Sprint |
| C-04 | 🟠 High | Excessive Permissions | `ci.yml` (top level) | No `permissions: {}` at workflow top level. All jobs run with default (elevated) GITHUB_TOKEN permissions. | Add `permissions: {}` at workflow level; scope per-job to minimum required | P1 — Next Sprint |
| N-02 | 🟠 High | Network Exposure | `.env.example`, `config.yaml` | All services bind to `0.0.0.0` by default. Any host on the network can reach gateway, Hindsight, and web UI. | Default bind to `127.0.0.1` for all services | P1 — Next Sprint |
| N-03 | 🟠 High | Missing TLS | `docker-compose.yml`, `server.mjs` | Gateway WebSocket has no TLS. Nginx TLS config is commented out. All traffic is plaintext. | Enable TLS; provide Let's Encrypt automation or mTLS between services | P1 — Next Sprint |
| S-02 | 🟠 High | Credential Exposure | `install.sh:236-244` | API key passed on `docker run` command line — visible in `ps aux` output to any user on the host. | Pass secrets via Docker secrets, env file with restricted permissions, or mounted volume | P1 — Next Sprint |
| SC-01 | 🟠 High | Missing Security Controls | `ci.yml` | No dependency vulnerability scanning in CI pipeline. | Add `pnpm audit --audit-level=high` as CI gate | P1 — Next Sprint |
| SC-02 | 🟠 High | Missing Security Controls | `ci.yml` docker job | No container image scanning. Vulnerabilities in base images and installed packages undetected. | Add Trivy or Grype scan step in Docker build job | P1 — Next Sprint |
| SS-01 | 🟠 High | Supply Chain Integrity | `post-merge.sh:10` | `pnpm install --frozen-lockfile \|\| pnpm install` fallback bypasses lockfile integrity. If lockfile is out of sync, falls back to unrestricted install, potentially introducing unexpected dependency versions. | Remove `\|\| pnpm install` fallback; fail if lockfile is out of sync | P1 — Next Sprint |
| L-02 | 🟠 High | Privilege Escalation | `install.sh:96,196` | Install script uses `sudo` without explicit user consent or explanation. | Prompt user before privilege escalation; document why root is needed | P1 — Next Sprint |
| M-01 | 🟡 Medium | Permissive CORS (Infra) | nginx config, `.env.example` | Wildcard CORS policy `http://*:*` in infrastructure templates matches any origin. | Restrict to specific origins | P2 — This Quarter |
| M-02 | 🟡 Medium | Disabled Controls | nginx config | Rate limiting commented out by default in nginx configuration. | Enable rate limiting with sensible defaults | P2 — This Quarter |
| M-03 | 🟡 Medium | Secret Leakage — Docker | All Dockerfiles | No `.dockerignore` file. Secrets, `.env` files, `.git` directory, and `node_modules` can be baked into images. | Create `.dockerignore` excluding `.env*`, `.git`, `node_modules`, `*.key`, `config.yaml` | P2 — This Quarter |
| M-04 | 🟡 Medium | Secret Leakage — Git | Repository root | No `.gitignore` entries for secrets. Risk of accidental credential commits. | Add `.env*`, `config.yaml`, `*.key`, `*.pem` to `.gitignore` | P2 — This Quarter |
| M-05 | 🟡 Medium | Broken Health Check | Web Dockerfile | `wget`-based HEALTHCHECK fails — Alpine doesn't ship `wget` by default. Container health reporting is broken. | Use `curl` or install `wget` in Alpine image | P2 — This Quarter |
| M-06 | 🟡 Medium | Resource Exhaustion | `docker-compose.yml` | No resource limits (`mem_limit`, `cpus`) on any container. One container can exhaust host resources. | Add resource limits to all containers in compose file | P2 — This Quarter |
| M-07 | 🟡 Medium | Missing Hardening | `docker-compose.yml` | No seccomp or AppArmor profiles applied to containers. | Apply default seccomp profiles; consider custom AppArmor profiles | P2 — This Quarter |
| M-08 | 🟡 Medium | Network Segmentation | `docker-compose.yml` | No network segmentation between containers. All services on default bridge network can communicate freely. | Create separate Docker networks for frontend/backend/data tiers | P2 — This Quarter |
| M-09 | 🟡 Medium | Supply Chain Transparency | CI/CD pipeline | No SBOM (Software Bill of Materials) generation in build pipeline. | Add `syft` or `cdxgen` SBOM generation step; publish with releases | P2 — This Quarter |
| M-10 | 🟡 Medium | Secret Scanning | CI/CD pipeline | No secret scanning (GitLeaks, TruffleHog) in CI. Commits with embedded secrets go undetected. | Add pre-commit secret scanning hook and CI secret scanning step | P2 — This Quarter |
| M-11 | 🟡 Medium | Deprecated Action | `ci.yml` | `actions/create-release@v1` is archived and no longer maintained. May contain unfixed vulnerabilities. | Replace with `softprops/action-gh-release` or GitHub CLI | P2 — This Quarter |
| M-12 | 🟡 Medium | CI/CD Safety | `ci.yml` | No `timeout-minutes` on CI jobs. Hung jobs consume runners indefinitely. | Add `timeout-minutes: 15` (or appropriate value) to all jobs | P2 — This Quarter |
| LI-01 | 🟢 Low | Branch Protection | GitHub repository settings | No branch protection rules configured. Direct pushes to main are permitted. | Enable branch protection: require PR reviews, status checks, linear history | P3 — Hardening |
| LI-02 | 🟢 Low | Dependency Management | GitHub repository settings | No Dependabot or Renovate configured for automated dependency updates. | Enable Dependabot or Renovate with auto-merge for patch updates | P3 — Hardening |
| LI-03 | 🟢 Low | Secrets Rotation | Operational | No secrets rotation policy documented or automated. | Document rotation schedule; implement automated rotation for API keys | P3 — Hardening |
| LI-04 | 🟢 Low | Image Size | Production Dockerfiles | `pnpm` included in production stage unnecessarily, increasing attack surface. | Multi-stage build: copy only built artifacts to production stage | P3 — Hardening |
| LI-05 | 🟢 Low | Version Mismatch | `.replit` | Replit config pins Node 20 while application requires Node 22. | Update `.replit` to specify Node 22 | P3 — Hardening |
| LI-06 | 🟢 Low | Provenance | Docker build | No Docker image provenance attestation (SLSA). Cannot verify build integrity. | Add `--provenance=true` to Docker buildx commands; sign with cosign | P3 — Hardening |
| LI-07 | 🟢 Low | Operational | Various | Missing operational hardening: no log aggregation, no alerting, no incident response playbook. | Document and implement ops runbooks | P3 — Hardening |

---

## 6. Dependency Vulnerabilities

### 6.1 Direct Dependency Risk Assessment

| Package | Version | Package(s) | Known CVEs | Risk | Notes |
|---------|---------|------------|------------|------|-------|
| `@anthropic-ai/claude-agent-sdk` | ^0.2.71 | core | None known | Low | Official Anthropic package; actively maintained |
| `ws` | ^8.18.0 / ^8.19.0 | gateway, tui, root | CVE-2024-37890 (fixed in ≥8.17.1) | Low | **Verify resolved version ≥8.17.1** |
| `js-yaml` | ^4.1.0 | root, core | None known | Low | v4 uses `safeLoad` by default |
| `zod` | ^4.3.6 | core | None known | Low | New v4; monitor for prototype pollution issues |
| `next` | ^15 | web | Review changelog for SSR vulns | Low-Medium | Major version — review for SSR injection vectors |
| `http-proxy` | ^1.18.1 | web | CVE-2022-31147 (affects <1.18.1) | **Medium** | **Verify exact resolved version ≥1.18.1** |
| `react-markdown` | ^10.1.0 | web | None known | Low | Uses `rehype-sanitize` (good) |
| `rehype-sanitize` | ^6.0.0 | web | None known | Low | Provides XSS protection |
| `highlight.js` | ^11.11.1 | web | ReDoS in older versions | Low | 11.x is current |
| `@mariozechner/pi-tui` | ^0.55.0 | tui | Not assessed | Medium | Community package; less scrutiny than major libs |
| `reconnecting-websocket` | ^4 | web | Not assessed | Low | Small utility library |
| `@xyflow/react` | ^12 | web | Not assessed | Low | DAG visualization |
| `zustand` | ^5 | web | None known | Low | Lightweight state management |

### 6.2 Dependency Management Concerns

| Concern | Severity | Details |
|---------|----------|---------|
| All versions use caret ranges (`^`) | 🟡 Medium | Allows automatic minor/patch updates that could introduce vulnerabilities. Production deployments should pin exact versions. |
| No `pnpm audit` in CI | 🟠 High | Known vulnerable dependencies can be introduced without detection. |
| No Dependabot/Renovate | 🟢 Low | Security patches for dependencies are not automatically surfaced. |
| `http-proxy` version boundary | 🟡 Medium | CVE-2022-31147 affects versions below 1.18.1. Must verify lock file resolves to ≥1.18.1. |
| Lockfile bypass in post-merge hook | 🟠 High | `pnpm install --frozen-lockfile \|\| pnpm install` can silently introduce unexpected dependency versions. |

### 6.3 Positive Security Observations in Dependencies

1. `rehype-sanitize` provides XSS protection for markdown rendering in the web UI
2. No `dangerouslySetInnerHTML` found anywhere in the React codebase
3. `zod` is available for schema validation (currently underutilized for WebSocket messages)
4. `js-yaml` v4 defaults to safe parsing (no `!!js/function` execution)
5. Dependency tree is relatively small (~40 external packages) — good for auditability

---

## 7. Enterprise Readiness Gap Analysis

### 7.1 SOC 2 Type II Readiness

| Trust Service Criteria | Status | Gaps |
|----------------------|--------|------|
| **Security** | 🔴 Not Ready | No access controls (auth defaults to `none`); no encryption in transit (no TLS); no encryption at rest (plaintext config/sessions); no security monitoring; no vulnerability management; no change management |
| **Availability** | 🔴 Not Ready | No rate limiting; no resource limits; no health checks; no failover; no SLA monitoring; no incident response |
| **Processing Integrity** | 🟠 Partial | Minimal input validation; no output validation; no guardrails on AI actions; no audit trail for agent decisions |
| **Confidentiality** | 🔴 Not Ready | API keys in plaintext; session data unencrypted; no data classification; conversation data sent to third-party endpoint by default |
| **Privacy** | 🔴 Not Ready | No consent mechanisms; no data subject rights; no data retention policies; no PII detection/masking in AI context |

### 7.2 ISO/IEC 27001:2022 Control Gaps

| Control Area | Gap Assessment |
|-------------|----------------|
| **A.5 — Information Security Policies** | No security policies documented |
| **A.6 — Organization of Information Security** | No security roles defined; no incident response team |
| **A.7 — Human Resource Security** | N/A (open source project) |
| **A.8 — Asset Management** | No inventory of API keys, model access, data stores; no data classification |
| **A.9 — Access Control** | Authentication disabled by default; no RBAC; no MFA; no least-privilege enforcement |
| **A.10 — Cryptography** | SHA-256 without salt for key hashing; no TLS; no encryption at rest |
| **A.12 — Operations Security** | No change management; no monitoring; no logging policy; no backup procedures |
| **A.14 — System Development** | No SDLC security requirements; no security testing in CI; tests disabled |
| **A.16 — Incident Management** | No incident response plan; no security event logging; no alerting |
| **A.18 — Compliance** | No compliance framework adherence; no audit logging |

### 7.3 ISO/IEC 42001 (AI Management Systems) Gaps

| Requirement | Status |
|-------------|--------|
| AI risk assessment | Not performed |
| AI system inventory | Not documented |
| Data governance for AI training/context | No controls |
| AI transparency and explainability | No audit trail for AI decisions |
| Bias monitoring and fairness testing | Not applicable (orchestration, not inference) |
| Human oversight of AI actions | No human-in-the-loop gates; `bypassPermissions` auto-approves all actions |
| AI incident response | No procedures defined |

### 7.4 EU AI Act Compliance (Article 12 — Record-Keeping)

For AI systems that could be classified as high-risk (agent systems with autonomous action capabilities):

| Requirement | Status |
|-------------|--------|
| Automatic logging of AI system operation | 🔴 Not implemented — no structured audit logging |
| Traceability of AI decisions | 🔴 Not implemented — no decision audit trail |
| Post-market monitoring | 🔴 Not implemented |
| Incident reporting | 🔴 Not implemented |
| Risk management system | 🔴 Not implemented |

### 7.5 NIST AI RMF Alignment

| Function | Status |
|----------|--------|
| **GOVERN** | 🔴 No AI risk ownership, policy, or accountability structures |
| **MAP** | 🟡 Architecture is documented but trust boundaries, data flows, and tool access scopes are not formalized |
| **MEASURE** | 🔴 No adversarial testing, no hallucination monitoring, no prompt injection detection |
| **MANAGE** | 🔴 No guardrails, no circuit breakers, no human-in-the-loop escalation |

### 7.6 Enterprise Deployment Requirements Summary

To reach enterprise-grade deployment readiness, OrionOmega requires:

1. **Authentication & Authorization** — RBAC with MFA, API key management, session tokens
2. **Encryption** — TLS everywhere, encrypted config/sessions at rest, secrets management integration
3. **Audit Logging** — Structured, immutable logs of all API calls, agent actions, tool invocations, and config changes
4. **Monitoring & Alerting** — Health checks, anomaly detection, security event monitoring, cost tracking
5. **Compliance Documentation** — Security policies, incident response plan, data handling procedures
6. **AI-Specific Controls** — Prompt injection detection, output validation, human-in-the-loop gates, agent sandboxing
7. **Supply Chain Security** — SBOM generation, signed artifacts, pinned dependencies, vulnerability scanning
8. **Multi-Tenant Isolation** — Tenant-scoped data, compute isolation, network segmentation (if applicable)

---

## 8. Prioritized Remediation Roadmap

### Phase 1: 🔴 Critical — Fix Immediately (Before Any Network Exposure)

**Timeline:** 1-2 weeks | **Effort:** ~40-60 engineering hours

| # | Finding IDs | Action | Impact |
|---|------------|--------|--------|
| 1 | N-01 | **Remove `http://aaronboshart.ddns.net:8888` from all templates and defaults.** Default Hindsight to `http://localhost:8888` or require explicit configuration. | Stops data exfiltration to third-party endpoint |
| 2 | C-2, N-02 | **Change default auth mode to `api-key`; default bind to `127.0.0.1`.** Require explicit opt-out for `none`. Add startup warning if auth=none on non-localhost. | Closes the widest attack surface |
| 3 | H-3, M-01 | **Restrict default CORS origins to `['http://localhost:*']` only.** Remove `http://*:*` and `https://*` wildcards from all defaults and templates. | Prevents cross-origin attacks from any website |
| 4 | C-3 | **Implement URL validation/blocklist in `web_fetch`.** Block RFC 1918, link-local, loopback, cloud metadata IPs. Block non-HTTP(S) protocols. Resolve DNS before request. | Prevents SSRF, cloud credential theft, internal network scanning |
| 5 | H-1, H-2 | **Replace SHA-256 with bcrypt/scrypt for password hashing. Use `timingSafeEqual` for token signatures.** | Prevents credential cracking and timing attacks |
| 6 | S-01, L-2 | **Set `chmod 600` on config file at creation. Support `${ENV_VAR}` substitution for secrets.** | Prevents credential theft from readable config files |
| 7 | D-01 | **Pin Hindsight Docker image to SHA256 digest.** | Prevents supply chain attack via mutable tag |
| 8 | C-01 | **Pin all GitHub Actions to full SHA digests.** Replace deprecated `actions/create-release@v1`. | Prevents CI/CD supply chain attacks |
| 9 | L-01 | **Replace `curl \| sh` with distro package manager install.** | Eliminates arbitrary code execution vector in install script |

### Phase 2: 🟠 High — Fix Within Sprint (Next 2-4 Weeks)

**Timeline:** 2-4 weeks | **Effort:** ~60-80 engineering hours

| # | Finding IDs | Action | Impact |
|---|------------|--------|--------|
| 10 | H-4 | Add request body size limits (1MB default) to all HTTP endpoints | Prevents OOM DoS |
| 11 | H-5, M-3 | Validate session IDs and skill names against strict alphanumeric patterns at the function level | Prevents path traversal |
| 12 | H-6, S-02 | Implement proper secrets management: Docker secrets or env file with 0600 permissions; stop passing API key on command line | Reduces credential exposure surface |
| 13 | C-02, SC-01, SC-02 | Add `pnpm audit`, CodeQL/Semgrep SAST, and Trivy container scan to CI pipeline | Catches vulnerabilities before deployment |
| 14 | C-03 | Re-enable tests in CI; add minimum coverage requirements | Restores quality gate |
| 15 | C-04 | Add `permissions: {}` to workflow top level; scope per-job | Limits blast radius of compromised CI job |
| 16 | N-03 | Enable TLS for gateway; provide cert automation | Encrypts all traffic |
| 17 | D-02, D-03 | Pin Node.js base images and pnpm to exact versions/digests in Dockerfiles | Supply chain hardening |
| 18 | D-04 | Remove Hindsight debug port 9999 from production compose | Removes debug endpoint exposure |
| 19 | SS-01 | Remove `\|\| pnpm install` fallback from post-merge hook | Preserves lockfile integrity |
| 20 | L-02 | Add user consent prompt before `sudo` operations in install script | Respects user trust |

### Phase 3: 🟡 Medium — Fix Within Quarter (1-3 Months)

**Timeline:** 1-3 months | **Effort:** ~120-160 engineering hours

| # | Finding IDs | Action | Impact |
|---|------------|--------|--------|
| 21 | M-1, M-02 | Implement rate limiting on all endpoints (token bucket per IP; nginx rate limiting enabled by default) | Prevents brute force and resource exhaustion |
| 22 | M-2 | Add standard security headers to all HTTP responses | Prevents clickjacking, MIME sniffing, XSS |
| 23 | M-9 | Implement Zod schema validation for all WebSocket messages | Prevents deserialization attacks |
| 24 | M-7 | Implement prompt injection defenses: input sanitization, content safety filtering, `replyToRole` validation | Reduces prompt injection risk |
| 25 | M-5 | Restrict skill handler execution: validate paths, allow only `.js`/.mjs` via `node`, filter env vars | Prevents arbitrary code execution via malicious skills |
| 26 | M-6, M-8 | Return generic errors to clients; implement graceful shutdown | Prevents info leakage; improves reliability |
| 27 | M-03, M-04 | Create `.dockerignore` and update `.gitignore` to exclude secrets | Prevents accidental secret inclusion in images/commits |
| 28 | M-06, M-07, M-08 | Add container resource limits, seccomp profiles, and network segmentation | Defense-in-depth for Docker deployment |
| 29 | M-09, M-10 | Add SBOM generation and secret scanning to CI pipeline | Supply chain transparency and secret leak prevention |
| 30 | C-1 | **Implement sandboxing for agent command execution** — container isolation, filesystem boundaries, command allowlists | Prevents host system compromise via agent |

### Phase 4: 🟢 Low / Hardening (3-6 Months)

**Timeline:** 3-6 months | **Effort:** ~80-120 engineering hours

| # | Finding IDs | Action | Impact |
|---|------------|--------|--------|
| 31 | L-1 | Add authentication to Hindsight client | Protects memory store |
| 32 | L-5 | Encrypt session files at rest | Protects conversation history |
| 33 | L-6 | Set WebSocket `maxPayload` to 10MB | Prevents memory-based DoS |
| 34 | LI-01 | Enable GitHub branch protection rules | Prevents unauthorized code changes |
| 35 | LI-02 | Configure Dependabot/Renovate | Automated dependency security updates |
| 36 | LI-03 | Document and automate secrets rotation policy | Reduces credential compromise window |
| 37 | LI-04 | Optimize Docker images (remove pnpm from production stage) | Reduces attack surface |
| 38 | LI-06 | Add Docker image provenance attestation (SLSA) | Verifiable build integrity |
| 39 | — | Implement structured audit logging for all agent actions | Supports compliance and forensics |
| 40 | — | Implement human-in-the-loop gates for high-privilege actions | Prevents unintended destructive actions |
| 41 | — | Implement memory provenance tracking for Hindsight writes | Defends against memory poisoning attacks |
| 42 | — | Create incident response plan and security runbooks | Enterprise operational readiness |

---

## 9. Security Architecture Recommendations

### 9.1 Agent Sandboxing Architecture

**Current State:** Agents execute with full host access — unrestricted shell, filesystem, network, and environment variables.

**Recommended Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Host System                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Gateway (TLS-terminated)                  │  │
│  │    [Auth] → [Rate Limit] → [Input Validation] → [Router]  │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                         │                                        │
│  ┌──────────────────────▼────────────────────────────────────┐  │
│  │              Orchestrator Container                        │  │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐    │  │
│  │  │ Guardrail│  │  Agent Loop   │  │  Output Validator │    │  │
│  │  │  Model   │→ │  (sandboxed)  │→ │  (sanitize before │    │  │
│  │  │          │  │               │  │   returning)      │    │  │
│  │  └──────────┘  └──────┬───────┘  └──────────────────┘    │  │
│  └───────────────────────┼───────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────▼───────────────────────────────────┐  │
│  │            Worker Containers (per-task isolation)           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │  Worker A    │  │  Worker B    │  │  Worker C    │       │  │
│  │  │ (read-only   │  │ (network-    │  │ (filesystem- │       │  │
│  │  │  filesystem)  │  │  restricted) │  │  scoped)     │       │  │
│  │  │ No API keys  │  │ Egress proxy │  │ tmpfs only   │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Credential Proxy (Vault/Secrets Manager Integration)      │  │
│  │  Agent → proxy key → credential swap → external API        │  │
│  │  Master keys NEVER enter agent environment                 │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Key Design Principles:**
- **Zero Trust between agents** — treat all inter-agent messages as untrusted
- **Credential proxy pattern** — agents receive proxy keys, never real credentials
- **Per-task container isolation** — each task runs in a fresh container with scoped capabilities
- **Egress proxy** — all outbound requests route through an allowlist proxy with audit logging
- **Output validation** — all agent outputs sanitized before being returned to users or other agents

### 9.2 Authentication & Authorization Architecture

**Recommended Changes:**

1. **Default to `api-key` authentication** — require explicit opt-out for development
2. **Implement RBAC** with roles: `admin`, `operator`, `viewer`, `agent`
3. **Short-lived JWT tokens** with scope claims (replace current HMAC tokens)
4. **Per-agent identity** — each agent gets a unique identity with scoped permissions
5. **MFA for administrative operations** (config changes, skill installation)

### 9.3 Secrets Management Architecture

```
┌──────────────────────────────────────────────────┐
│              Secrets Manager (Vault)               │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐    │
│  │ anthropic/  │ │ github/    │ │ linear/    │    │
│  │ api-key     │ │ pat        │ │ api-key    │    │
│  └──────┬─────┘ └──────┬─────┘ └──────┬─────┘    │
└─────────┼──────────────┼──────────────┼───────────┘
          │              │              │
          ▼              ▼              ▼
┌──────────────────────────────────────────────────┐
│          Credential Proxy Service                  │
│  • Swaps proxy keys → real credentials             │
│  • Scopes credentials to requesting agent/task     │
│  • Audit logs every credential access              │
│  • Automatic rotation on schedule                  │
│  • Instant revocation on compromise                │
└──────────────────────────────────────────────────┘
```

**Migration Path:**
1. **Immediate:** Support `${ENV_VAR}` substitution in config.yaml; `chmod 600` on config files
2. **Short-term:** Implement credential proxy pattern; remove raw API keys from agent environment
3. **Medium-term:** Integrate with HashiCorp Vault / AWS Secrets Manager / Azure Key Vault
4. **Long-term:** Move to workload identity (OAuth 2.0 machine-to-machine) with zero static secrets

### 9.4 Network Security Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Public Network                                          │
│  ┌─────────────┐                                        │
│  │  TLS Proxy   │  (nginx/Caddy with Let's Encrypt)     │
│  │  + WAF       │                                        │
│  └──────┬──────┘                                        │
└─────────┼────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────┐
│  Frontend Network (gateway-net)                           │
│  ┌──────────────┐    ┌──────────────┐                    │
│  │   Gateway     │    │   Web UI     │                    │
│  │   :8000       │    │   :3000      │                    │
│  └──────┬───────┘    └──────────────┘                    │
└─────────┼────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────┐
│  Backend Network (agent-net) — no external access         │
│  ┌──────────────┐    ┌──────────────┐                    │
│  │  Orchestrator │    │   Hindsight  │                    │
│  │  (agents)     │    │   :8888      │                    │
│  └──────────────┘    └──────────────┘                    │
└──────────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────┐
│  Egress Proxy (allowlist only)                            │
│  • api.anthropic.com — allowed                            │
│  • api.linear.app — allowed (if configured)               │
│  • api.github.com — allowed (if configured)               │
│  • 169.254.169.254 — BLOCKED                              │
│  • RFC 1918 ranges — BLOCKED                              │
│  • All other — BLOCKED by default                         │
└──────────────────────────────────────────────────────────┘
```

### 9.5 Audit Logging Architecture

Implement structured, immutable audit logging for:

| Event Category | Data Captured | Retention |
|---------------|---------------|-----------|
| **Authentication** | Login attempts, token issuance, failures, IP addresses | 90 days |
| **Configuration Changes** | Who changed what, old value → new value, timestamp | 1 year |
| **Agent Actions** | Tool invocations, commands executed, files read/written, URLs fetched | 1 year |
| **API Calls** | All REST/WebSocket requests with sanitized payloads | 90 days |
| **Skill Operations** | Skill installation, execution, configuration changes | 1 year |
| **Security Events** | Rate limit triggers, auth failures, blocked requests | 1 year |

**Format:** Structured JSON lines, append-only, with HMAC integrity verification.

### 9.6 AI-Specific Security Controls

| Control | Implementation |
|---------|---------------|
| **Prompt Injection Detection** | Secondary guardrail model inspecting all inputs for injection patterns before reaching the primary agent |
| **Output Validation** | Validate all agent outputs against expected schemas before execution; flag anomalous tool call patterns |
| **Human-in-the-Loop Gates** | Require human approval for: destructive file operations, external API calls, code execution in production, configuration changes |
| **Memory Provenance** | Tag every Hindsight memory write with source agent, task ID, trust level; reject unsigned memories |
| **Agent Behavior Monitoring** | Track agent decision patterns across sessions; alert on behavioral drift that may indicate compromise |
| **Tool Scope Enforcement** | Define per-task tool allowlists; agents cannot invoke tools outside their declared scope |
| **Context Isolation** | Separate context windows for trusted (system prompt) vs. untrusted (user input, fetched content) data |

---

## 10. Appendix: References

### A. Standards & Frameworks

| Reference | URL |
|-----------|-----|
| OWASP Top 10 for LLM Applications (2025) | https://genai.owasp.org/llm-top-10/ |
| OWASP LLM01:2025 — Prompt Injection | https://genai.owasp.org/llmrisk/llm01-prompt-injection/ |
| OWASP LLM03:2025 — Supply Chain | https://genai.owasp.org/llmrisk/llm032025-supply-chain/ |
| NIST AI Risk Management Framework (AI 100-1) | https://www.nist.gov/itl/ai-risk-management-framework |
| NIST AI 600-1 Generative AI Profile | https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf |
| MITRE ATLAS Framework | https://atlas.mitre.org/ |
| ISO/IEC 42001 AI Management Systems | https://www.iso.org/standard/81230.html |

### B. Vulnerability Databases & CVEs

| Reference | URL |
|-----------|-----|
| CVE-2025-68664 (LangChain Core — CVSS 9.3) | https://nvd.nist.gov/vuln/detail/CVE-2025-68664 |
| CVE-2024-6091 (AutoGPT — CVSS 9.8) | https://securityonline.info/166k-projects-at-risk-autogpts-critical-vulnerability-explained-cve-2024-6091-cvss-9-8/ |
| CVE-2026-25253 (OpenClaw — One-click RCE) | https://www.proarch.com/blog/threats-vulnerabilities/openclaw-rce-vulnerability-cve-2026-25253 |
| CVE-2026-30741 (OpenClaw — Prompt Injection RCE) | https://www.sentinelone.com/vulnerability-database/cve-2026-30741/ |
| CVE-2026-32915 (OpenClaw — Sandbox Escape) | https://www.redpacketsecurity.com/cve-alert-cve-2026-32915-openclaw-openclaw/ |
| CVE-2026-32918 (OpenClaw — Session Escape) | https://www.redpacketsecurity.com/cve-alert-cve-2026-32918-openclaw-openclaw/ |
| CVE-2025-53773 (GitHub Copilot — Prompt Injection RCE) | https://nvd.nist.gov/vuln/detail/CVE-2025-53773 |
| CVE-2025-32711 (M365 Copilot — EchoLeak) | https://nvd.nist.gov/vuln/detail/CVE-2025-32711 |
| OpenClaw CVE Tracker | https://github.com/jgamblin/OpenClawCVEs/ |
| LangChain Vulnerabilities — Unit 42 | https://unit42.paloaltonetworks.com/langchain-vulnerabilities/ |

### C. Research & Threat Intelligence

| Reference | URL |
|-----------|-----|
| Infectious Prompt Injection in Multi-Agent Systems | https://securityboulevard.com/2025/01/infectious-prompt-injection-attacks-on-multi-agent-ai-systems/ |
| Unit 42: Indirect Prompt Injection Poisons AI Memory | https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/ |
| AI-Induced Lateral Movement (AILM) — Orca Security | https://orca.security/resources/blog/ai-induced-lateral-movement-ailm/ |
| IdentityMesh: Lateral Movement in Agentic Systems | https://www.lasso.security/blog/identitymesh-exploiting-agentic-ai |
| From Assistant to Adversary — NVIDIA | https://developer.nvidia.com/blog/from-assistant-to-adversary-exploiting-agentic-ai-developer-tools/ |
| Memory Poisoning in AI Agents | https://christian-schneider.net/blog/persistent-memory-poisoning-in-ai-agents/ |
| Agentic AI Threats — Lakera | https://www.lakera.ai/blog/agentic-ai-threats-p1 |
| AI Recommendation Poisoning — Microsoft (Feb 2026) | https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/ |
| LangGrinch Deep Dive — Cyata | https://cyata.ai/blog/langgrinch-langchain-core-cve-2025-68664/ |
| AI Agent Attacks Q4 2025 — eSecurity Planet | https://www.esecurityplanet.com/artificial-intelligence/ai-agent-attacks-in-q4-2025-signal-new-risks-for-2026/ |
| Penetration Testing of Agentic AI — arXiv | https://arxiv.org/html/2512.14860v1 |
| MDPI Comprehensive Review (Jan 2026) | https://www.mdpi.com/2078-2489/17/1/54 |

### D. OpenClaw & NanoClaw Research

| Reference | URL |
|-----------|-----|
| Kaspersky — OpenClaw Enterprise Risk | https://www.kaspersky.com/blog/moltbot-enterprise-risk-management/55317/ |
| Kaspersky — OpenClaw Vulnerabilities Exposed | https://www.kaspersky.com/blog/openclaw-vulnerabilities-exposed/55263/ |
| Dark Reading — Critical OpenClaw & AI Agent Risks | https://www.darkreading.com/application-security/critical-openclaw-vulnerability-ai-agent-risks |
| Sangfor — OpenClaw Security Risks & Supply Chain | https://www.sangfor.com/blog/cybersecurity/openclaw-ai-agent-security-risks-2026 |
| VentureBeat — NanoClaw Security Architecture | https://venturebeat.com/orchestration/nanoclaw-solves-one-of-openclaws-biggest-security-issues-and-its-already |
| NanoClaw GitHub Security | https://github.com/qwibitai/nanoclaw/security |

### E. Enterprise Security Standards

| Reference | URL |
|-----------|-----|
| SOC 2 for AI Platforms — CompassITC | https://www.compassitc.com/blog/achieving-soc-2-compliance-for-artificial-intelligence-ai-platforms |
| LLM Security Frameworks — Hacken | https://hacken.io/discover/llm-security-frameworks/ |
| NIST-Based AI Agent Governance — Microsoft | https://techcommunity.microsoft.com/blog/microsoftdefendercloudblog/architecting-trust-a-nist-based-security-governance-framework-for-ai-agents/4490556 |
| Securing AI Agents Without Secrets — Aembit | https://aembit.io/blog/securing-ai-agents-without-secrets/ |
| OWASP Secrets Management Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html |
| Multi-Tenant AI Isolation — Cloud Native Now | https://cloudnativenow.com/contributed-content/the-new-multi-tenant-challenge-securing-ai-agents-in-cloud-native-infrastructure/ |
| Secure Multitenant RAG — Microsoft | https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/secure-multitenant-rag |

### F. Supply Chain Security

| Reference | URL |
|-----------|-----|
| 12,000 API Keys in AI Training Data — PointGuard | https://www.pointguardai.com/ai-security-incidents/12-000-api-keys-and-passwords-exposed-in-ai-training-data |
| API Key Security for AI Agents — Auth0 | https://auth0.com/blog/api-key-security-for-ai-agents/ |
| AI/ML Supply Chain Security — ReversingLabs | https://www.reversinglabs.com/blog/the-race-to-secure-the-aiml-supply-chain-is-on-get-out-front |
| AI Model Security Scanning — Wiz | https://www.wiz.io/academy/ai-security/ai-model-security-scanning |

---

**End of Report**

*This report was generated through automated multi-agent security analysis on 2026-03-29. Findings are based on static code analysis, infrastructure configuration review, dependency manifest analysis, and external threat intelligence research. A penetration test and dynamic analysis are recommended to validate findings and identify runtime vulnerabilities not detectable through static analysis.*

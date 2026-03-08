# OrionOmega Repository Structure Report

## Repository Metadata

| Property | Value |
|----------|-------|
| **Repository** | `aaronboshart1/orionomega` |
| **Description** | OrionOmega — Lightweight AI Agent Orchestration System |
| **Visibility** | Public |
| **License** | MIT License |
| **Language** | TypeScript (primary) |
| **Default Branch** | main |
| **Created** | 2026-03-05 |
| **Last Updated** | 2026-03-08 |
| **Size** | 0.6 MB |
| **Stars** | 0 |
| **Forks** | 0 |
| **Node.js Requirement** | >= 22.0.0 |
| **TypeScript Version** | 5.7+ |

## Project Overview

OrionOmega is a graph-based AI agent orchestration system built on these principles:
- **Plan-first UX**: Always shows execution plan before running
- **Graph-based execution**: DAG decomposition with topological sorting
- **Full transparency**: Real-time visibility into worker activities
- **Persistent memory**: Hindsight temporal knowledge graph integration
- **Dual interfaces**: Terminal UI (Ink/React) and Web dashboard (Next.js + ReactFlow)
- **Skills system**: Extensible capability packages with manifest-based definitions

## Directory Structure

```
orionomega/
├── packages/                    # npm workspaces monorepo
│   ├── core/                   # Main orchestration engine, CLI, config, Anthropic client
│   ├── gateway/                # WebSocket + REST server for client connections
│   ├── hindsight/              # Hindsight temporal knowledge graph client library
│   ├── skills-sdk/             # Skills system SDK (manifest, loader, validator, executor)
│   ├── tui/                    # Terminal UI built with Ink (React for CLI)
│   └── web/                    # Next.js dashboard with ReactFlow DAG visualization
├── default-skills/             # Built-in skill implementations
│   ├── github/                 # GitHub integration (repos, issues, PRs, workflows)
│   ├── linear/                 # Linear issue tracking integration
│   ├── web-fetch/              # Web content fetching
│   └── web-search/             # Web search capability
├── docs/                       # Documentation directory
├── scripts/                    # Installation and utility scripts
├── test/                       # Test files
├── LICENSE                     # MIT License
├── README.md                   # Main project documentation
├── package.json                # Root workspace manifest
├── pnpm-workspace.yaml         # pnpm workspace configuration
├── pnpm-lock.yaml              # Dependency lock file
├── tsconfig.json               # TypeScript configuration
└── [research files]            # Redis/Valkey/Dragonfly analysis (investigation artifacts)
```

## Skills SDK Location & Structure

### Core Location
```
packages/skills-sdk/
├── package.json                # NPM package manifest (@orionomega/skills-sdk v0.1.0)
├── tsconfig.json               # TypeScript configuration
└── src/                        # Source code
    ├── index.ts                # Main export (SkillLoader, SkillExecutor, types)
    ├── types.ts                # Type definitions (SkillManifest, LoadedSkill, etc.)
    ├── loader.ts               # Skill discovery, loading, matching, validation
    ├── executor.ts             # Tool execution with handler subprocess management
    ├── validator.ts            # Manifest validation (semver, platform, structure)
    ├── skill-config.ts         # Configuration persistence (read/write config.json)
    └── scaffold.ts             # Skill scaffolding for new skill creation
```

### SDK Core Exports

**Main Classes:**
- `SkillLoader` — Discovers, loads, validates, and matches skills from a directory
- `SkillExecutor` — Executes skill tool handlers via subprocess

**Utility Functions:**
- `validateManifest()` — Validates manifest structure and compatibility
- `scaffoldSkill()` — Creates a new skill skeleton
- `readSkillConfig()` — Reads skill configuration from disk
- `writeSkillConfig()` — Persists skill configuration
- `isSkillReady()` — Checks if a skill is configured and enabled
- `listSkillConfigs()` — Lists all skill configurations

### Type System (from `types.ts`)

**SkillManifest Interface:**
```typescript
- name: string (unique slug)
- version: string (semver)
- description: string
- author: string
- license: string
- homepage?: string
- repository?: string
- orionomega: string (semver range)
- os?: string[] (linux, darwin, win32)
- arch?: string[] (x64, arm64)
- requires: {
    commands?: string[] (CLI dependencies)
    skills?: string[] (other skill dependencies)
    env?: string[] (environment variables)
    ports?: number[] (required ports)
    services?: string[] (systemd services)
  }
- tools?: SkillTool[] (tool definitions)
- triggers: {
    keywords?: string[]
    patterns?: string[]
    commands?: string[] (slash commands like /gh)
  }
- workerProfile?: {
    model?: string
    tools?: string[]
    maxTimeout?: number
  }
- setup?: SkillSetup
- hooks?: {
    postInstall?: string
    preLoad?: string
    healthCheck?: string
  }
```

**Key Supporting Types:**
- `LoadedSkill` — Loaded skill with manifest, docs, tools, and skill directory
- `RegisteredTool` — Executable tool with handler and input schema
- `ValidationResult` — Validation errors and warnings
- `SkillConfig` — Persisted skill configuration (enabled, configured, authMethod, fields)
- `SkillSetup` — Setup requirements (auth methods, configuration fields)
- `SkillAuthMethod` — Authentication strategy (oauth, pat, api-key, login, ssh-key, env)
- `SkillSetupField` — Configuration field (name, type, label, required, default)

## Default Skills

All located in `default-skills/` with consistent structure:

### 1. **github** (Full-featured GitHub integration)
```
default-skills/github/
├── manifest.json               # Skill definition + tool declarations
├── SKILL.md                    # Documentation and agent instructions
├── handlers/                   # Tool handler scripts
│   ├── gh_api.js              # Raw GitHub API (REST/GraphQL)
│   ├── gh_issue.js            # GitHub issues management
│   ├── gh_pr.js               # Pull requests operations
│   ├── gh_repo.js             # Repository management
│   ├── gh_release.js          # Release management
│   ├── gh_workflow.js         # GitHub Actions workflows
│   └── lib.js                 # Shared utilities
├── hooks/                      # Lifecycle hooks
│   ├── setup.js               # Post-setup configuration
│   └── health.js              # Health check validation
```

**Tools Exposed:** gh_repo, gh_issue, gh_pr, gh_release, gh_workflow, gh_api

**Requirements:** `gh` CLI, `git` CLI  
**Auth Methods:** OAuth, Personal Access Token, Interactive Login  
**Version:** 1.0.0

### 2. **linear** (Linear issue tracking)
```
default-skills/linear/
├── manifest.json
├── SKILL.md
├── handlers/
│   ├── linear_graphql.js      # Linear GraphQL API
│   ├── linear_issue.js        # Issue operations
│   ├── linear_project.js      # Project management
│   ├── linear_team.js         # Team operations
│   ├── linear_user.js         # User information
│   └── lib.js                 # Shared utilities
├── hooks/
│   ├── setup.js
│   └── health.js
```

### 3. **web-fetch** (Web content fetching)
```
default-skills/web-fetch/
├── manifest.json
├── SKILL.md
├── handlers/
│   └── web_fetch.js           # HTTP fetch handler
```

### 4. **web-search** (Web search)
```
default-skills/web-search/
├── manifest.json
├── SKILL.md
├── handlers/
│   └── web_search.js          # Search handler
```

## Package Dependencies

### Root Workspace (`package.json`)
- **Type:** npm workspaces monorepo
- **Runtime:** Node.js >= 22.0.0
- **DevDeps:** TypeScript 5.7+, tsx, eslint, ws (WebSocket)
- **Scripts:** build, dev, test, lint, clean, typecheck

### Workspace Packages
Located in `pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/core'
  - 'packages/gateway'
  - 'packages/hindsight'
  - 'packages/skills-sdk'
  - 'packages/tui'
  # (web is optional: pnpm --filter @orionomega/web install)
```

## Top-Level Directories & Purposes

| Directory | Purpose |
|-----------|---------|
| `packages/` | npm workspaces with 6 main packages |
| `packages/core` | CLI, orchestration engine, config, Anthropic integration |
| `packages/gateway` | WebSocket + REST gateway for TUI/Web clients |
| `packages/hindsight` | Client library for Hindsight temporal knowledge graph |
| `packages/skills-sdk` | **Skills system SDK** (manifest, loader, validator, executor) |
| `packages/tui` | Terminal UI (Ink/React) |
| `packages/web` | Next.js web dashboard with ReactFlow visualization |
| `default-skills/` | Built-in skills (github, linear, web-fetch, web-search) |
| `docs/` | Architecture, getting-started, and skills authoring guides |
| `scripts/` | Installation and build scripts |
| `test/` | Test suite files |

## Key Files Summary

| File | Purpose |
|------|---------|
| `README.md` | Comprehensive project documentation |
| `LICENSE` | MIT License (2026 Aaron Boshart) |
| `package.json` | Root workspace manifest |
| `pnpm-workspace.yaml` | Workspace configuration |
| `tsconfig.json` | TypeScript compiler options |
| `pnpm-lock.yaml` | Dependency lock file |

## Configuration & Research Files

The repo includes research/analysis files on cache/storage alternatives:
- `redis_alternatives_*.md` — Redis alternative analysis
- `valkey_research*.md` — Valkey (Redis fork) investigation
- `dragonfly_research*.md` — DragonflyDB evaluation
- `memcached_research.md` — Memcached analysis
- `keydb_research.md` — KeyDB investigation
- `hindsight_api_discovery_report.md` — API discovery notes

These appear to be investigation artifacts for choosing a caching/memory solution for Hindsight integration.

## Build & Development

**Build System:** TypeScript + tsx
**Package Manager:** pnpm (with npm workspaces fallback)
**Commands:**
```bash
npm run build          # Build all packages
npm run dev            # Development mode (workspace-aware)
npm run test           # Run tests across workspaces
npm run lint           # Lint TypeScript files
npm run typecheck      # Type checking via tsc --build
npm run clean          # Remove dist directories
```

## Skills SDK Architecture Highlights

### Design Philosophy
1. **Manifest-driven**: Skills defined by manifest.json (no code introspection)
2. **Subprocess-based handlers**: Tools executed as spawned processes (security, isolation)
3. **Configuration-driven setup**: Interactive setup with auth methods and custom fields
4. **Validation-first**: Strict manifest validation before loading
5. **Dependency checking**: Supports OS, arch, CLI, env, port, and service dependencies

### Key Patterns
- **SkillLoader**: Scans directory → discovers manifests → validates → loads → matches user input
- **SkillExecutor**: Takes tool def + params → spawns handler subprocess → captures JSON output
- **Trigger Matching**: Keywords, regex patterns, and slash commands for tool discovery
- **Configuration State**: Per-skill config.json tracks enabled/configured/authMethod/fields

---

## Notable Findings

1. **Skills SDK is self-contained** in `packages/skills-sdk/` with clear responsibilities
2. **Default skills provide real implementations** (GitHub, Linear, web fetch/search) as reference
3. **Type system is comprehensive** with full support for auth, setup, validation, and tool definitions
4. **Manifest-driven design** allows skills to be discovered and validated without code loading
5. **Handler subprocess pattern** enables security isolation and language flexibility
6. **Monorepo structure** allows independent package development while sharing types via workspaces
7. **Configuration persistence** enables stateful skill setup with auth and field storage
8. **Research artifacts** suggest active investigation into memory/cache solutions (possibly for Hindsight backend)


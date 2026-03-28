# OrionOmega Skills SDK

> Version 0.2.0 — Reference documentation for skill authors and AI coding agents.

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Complete API Reference](#complete-api-reference)
4. [Handler Protocol](#handler-protocol)
5. [Lifecycle Hooks](#lifecycle-hooks)
6. [Trigger Matching](#trigger-matching)
7. [Setup & Authentication](#setup--authentication)
8. [Configuration Storage](#configuration-storage)
9. [Best Practices](#best-practices)

---

## Overview

A **skill** is a self-contained capability plugin that extends what the OrionOmega agent can do.
Each skill is a directory containing:

- A `manifest.json` declaring identity, tools, dependencies, triggers, and configuration
- One or more **handler scripts** — executables that run when a tool is called
- A `SKILL.md` documentation file (highly recommended; injected into the agent's system prompt)
- Optional lifecycle hook scripts for install, preload, and health checks

Skills are discovered and loaded by `SkillLoader`, executed by `SkillExecutor`, and exposed to the
Claude agent as [Model Context Protocol (MCP)](https://modelcontextprotocol.io) tool servers.

### How a skill call flows

```
User message
     │
     ▼
SkillLoader.matchSkills()       — finds relevant skills via triggers (keywords/commands/patterns)
     │
     ▼
AgentSDKBridge (MCP server)     — registered tools become callable by the agent
     │
     ▼
SkillExecutor.executeHandler()  — spawns handler script as a child process
     │
     ▼
Handler script                  — reads JSON on stdin, writes JSON on stdout, exits 0
     │
     ▼
Result returned to agent
```

### Skill directory structure

```
my-skill/
├── manifest.json            REQUIRED. Declares identity, tools, dependencies, triggers.
├── SKILL.md                 Recommended. Agent-facing documentation.
├── handlers/
│   ├── my-tool.js           Handler for the my_tool tool (Node.js example).
│   └── another-tool.sh      Handlers can be written in any executable language.
├── hooks/
│   ├── setup.js             Optional. postInstall hook — runs after installation.
│   ├── preload.sh           Optional. preLoad hook — runs before loading.
│   └── health.js            Optional. healthCheck hook — reports skill health.
└── prompts/
    └── worker.md            Optional. System prompt for worker agent mode.
```

**Minimum viable skill:** `manifest.json` + one executable handler script.

---

## Quick Start

Create a `weather` skill in three steps.

### Step 1 — Create the directory

```bash
mkdir -p weather/handlers
```

### Step 2 — Write `manifest.json`

```json
{
  "name": "weather",
  "version": "0.1.0",
  "description": "Get current weather for a location using the Open-Meteo API",
  "author": "Your Name",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": {
    "commands": [],
    "skills": [],
    "env": []
  },
  "triggers": {
    "keywords": ["weather", "temperature", "forecast"],
    "commands": ["/weather"]
  },
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current temperature and conditions for a city.",
      "handler": "handlers/get_weather.js",
      "timeout": 15000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "location": {
            "type": "string",
            "description": "City name (e.g. 'San Francisco') or 'lat,lon' coordinates"
          }
        },
        "required": ["location"]
      }
    }
  ]
}
```

### Step 3 — Write `handlers/get_weather.js`

```js
#!/usr/bin/env node
// Handler: get_weather
// Input  (stdin):  { location: string }
// Output (stdout): JSON result or { error: string }

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { location } = JSON.parse(raw);

  if (!location) {
    process.stdout.write(JSON.stringify({ error: 'location is required' }));
    process.exit(1);
  }

  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
    { signal: AbortSignal.timeout(10_000) }
  );
  const geo = await geoRes.json();
  if (!geo.results?.length) {
    process.stdout.write(JSON.stringify({ error: `Location not found: ${location}` }));
    process.exit(1);
  }

  const { latitude, longitude, name, country } = geo.results[0];
  const wxRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m`,
    { signal: AbortSignal.timeout(10_000) }
  );
  const wx = await wxRes.json();
  const temp = wx.current.temperature_2m;

  process.stdout.write(JSON.stringify({
    location: `${name}, ${country}`,
    temperature_c: temp,
    temperature_f: Math.round(temp * 9 / 5 + 32),
  }));
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
```

```bash
chmod +x handlers/get_weather.js
```

Place the `weather/` directory in your skills directory (`~/.orionomega/skills/` by default).
Test it immediately:

```bash
echo '{"location":"Paris"}' | node weather/handlers/get_weather.js
```

---

## Complete API Reference

### Package exports

```typescript
import {
  SkillLoader,
  SkillExecutor,
  validateManifest,
  scaffoldSkill,
  readSkillConfig,
  writeSkillConfig,
  isSkillReady,
  listSkillConfigs,
} from '@orionomega/skills-sdk';

import type {
  SkillManifest,
  SkillTool,
  SkillSetup,
  SkillAuthMethod,
  SkillSetupField,
  LoadedSkill,
  RegisteredTool,
  ValidationResult,
  SkillInstallResult,
  SkillConfig,
} from '@orionomega/skills-sdk';
```

---

### Interfaces

#### `SkillManifest`

The complete structure of a skill's `manifest.json`.

```typescript
interface SkillManifest {
  // ── Identity ────────────────────────────────────────────
  name: string;          // Unique slug (e.g. "github"). MUST match the directory name.
  version: string;       // Semver "X.Y.Z" (e.g. "1.0.0")
  description: string;   // One to two sentence description
  author: string;        // Author name or handle
  license: string;       // SPDX identifier (e.g. "MIT", "Apache-2.0")
  homepage?: string;     // Optional URL to documentation
  repository?: string;   // Optional URL to source code

  // ── Compatibility ───────────────────────────────────────
  orionomega: string;    // Semver range (e.g. ">=0.1.0", "^1.0.0")
  os?: string[];         // Supported OS: "linux" | "darwin" | "windows"
                         //   Mismatch → warning, not error
  arch?: string[];       // Supported CPU arch: "x64" | "arm64"
                         //   Mismatch → warning, not error

  // ── Dependencies ────────────────────────────────────────
  requires: {
    commands?: string[]; // CLI tools required on PATH (e.g. ["gh", "git"])
                         //   Absence → ERROR, skill will not load
    skills?: string[];   // Other skill names that must be installed
                         //   Absence → ERROR, skill will not load
    env?: string[];      // Environment variables that must be set
                         //   Absence → ERROR, skill will not load
    ports?: number[];    // Network ports (advisory warning only, not enforced)
    services?: string[]; // Systemd service names (advisory warning only)
  };

  // ── Tools ───────────────────────────────────────────────
  tools?: SkillTool[];   // Tools the skill exposes. Can be empty array or omitted.

  // ── Triggers ────────────────────────────────────────────
  triggers: {
    keywords?: string[]; // Case-insensitive substring matches
    patterns?: string[]; // Regular expression patterns (JavaScript regex syntax)
    commands?: string[]; // Slash commands (exact prefix match, e.g. "/gh")
  };

  // ── Worker Profile ──────────────────────────────────────
  workerProfile?: {
    model?: string;      // Preferred Claude model ID
    tools?: string[];    // Tool names available in worker mode
    maxTimeout?: number; // Max total execution timeout in ms
  };

  // ── Setup & Auth ────────────────────────────────────────
  setup?: SkillSetup;

  // ── Lifecycle Hooks ─────────────────────────────────────
  hooks?: {
    postInstall?: string; // Relative path to script. Runs after install. Non-zero = warning.
    preLoad?: string;     // Relative path to script. Runs before load. Non-zero = BLOCKS load.
    healthCheck?: string; // Relative path to script. Writes health JSON to stdout.
  };
}
```

---

#### `SkillTool`

Defines one tool within a skill.

```typescript
interface SkillTool {
  name: string;                          // Tool identifier. Must be unique within the skill.
  description: string;                   // What the tool does. The agent uses this to decide
                                         //   when to call it. Be specific and action-oriented.
  inputSchema: Record<string, unknown>;  // JSON Schema (type: "object") describing parameters.
  handler: string;                       // Path to executable handler, relative to skill dir.
  timeout?: number;                      // Execution timeout ms. Default: 30000 (30 seconds).
}
```

**`inputSchema` rules:**
- Root must be `{ "type": "object", "properties": { ... }, "required": [...] }`
- Each property must have a `"description"` — the agent uses these to construct calls
- Use `"enum"` for fixed-value string parameters (preferred over free-form strings)
- Mark truly optional parameters by omitting them from `"required"`

**Example `inputSchema`:**
```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["list", "create", "close"],
      "description": "Operation to perform"
    },
    "title": {
      "type": "string",
      "description": "Issue title (required for create)"
    },
    "limit": {
      "type": "number",
      "description": "Max results to return (default 30)"
    }
  },
  "required": ["action"]
}
```

---

#### `SkillSetup`

Describes what configuration the skill needs before it can be used.

```typescript
interface SkillSetup {
  required: boolean;          // If true, skill will not activate until setup is complete
  description?: string;       // Human-readable explanation of what setup accomplishes
  auth?: {
    methods: SkillAuthMethod[]; // Auth options (user picks one during setup)
  };
  fields?: SkillSetupField[];  // Additional configuration fields
  handler?: string;            // Path to post-setup validation script
}
```

---

#### `SkillAuthMethod`

One authentication option presented to the user during setup.

```typescript
interface SkillAuthMethod {
  type: 'oauth' | 'pat' | 'api-key' | 'login' | 'ssh-key' | 'env';
  label: string;            // Display name (e.g. "Personal Access Token")
  description?: string;     // One-sentence explanation
  command?: string;         // CLI command for oauth/login flows
  tokenUrl?: string;        // URL where user generates a token
  scopes?: string[];        // Required OAuth scopes (informational only)
  envVar?: string;          // Environment variable name that stores the credential
  validateCommand?: string; // Shell command to verify auth. Exit 0 = valid, non-zero = invalid.
}
```

**Auth type reference:**

| `type`    | Use when                                      | Credential storage          |
|-----------|-----------------------------------------------|-----------------------------|
| `oauth`   | Service supports OAuth device flow            | Managed by CLI (e.g. `gh`)  |
| `pat`     | Personal access token from a web dashboard    | Env var via `envVar` field   |
| `api-key` | API key from a developer portal               | Env var via `envVar` field   |
| `login`   | Interactive CLI-based login                   | Managed by CLI               |
| `ssh-key` | SSH key pair authentication                   | Key file path                |
| `env`     | Credential already present in the environment | Reads existing env var       |

---

#### `SkillSetupField`

A configuration value the user provides during setup (beyond authentication).

```typescript
interface SkillSetupField {
  name: string;                           // Field key → used in config.json and env var name
  type: 'string' | 'number' | 'boolean' | 'select';
  label: string;                          // Display label
  description?: string;                   // Help text shown to user
  required: boolean;                      // Whether the field must be filled
  default?: string | number | boolean;    // Default value if not provided
  options?: { label: string; value: string }[]; // Options for select type
  mask?: boolean;                         // If true, masks input (use for secrets)
}
```

**Field value delivery to handlers:**

Field values are injected as environment variables following this pattern:

```
SKILL_{SKILLNAME}_{FIELDNAME}
  where SKILLNAME = manifest.name uppercased, hyphens → underscores
  where FIELDNAME = field.name uppercased, hyphens → underscores

Examples:
  skill "github",  field "default_owner"  →  SKILL_GITHUB_DEFAULT_OWNER
  skill "linear",  field "default_team"   →  SKILL_LINEAR_DEFAULT_TEAM
  skill "my-api",  field "api_key"        →  SKILL_MY_API_API_KEY
```

---

#### `LoadedSkill`

A fully loaded skill ready for execution.

```typescript
interface LoadedSkill {
  manifest: SkillManifest;   // The validated manifest
  skillDoc: string;          // Contents of SKILL.md (empty string if file absent)
  workerPrompt?: string;     // Contents of prompts/worker.md (undefined if absent)
  tools: RegisteredTool[];   // Bound tool executors
  skillDir: string;          // Absolute path to the skill directory
}
```

---

#### `RegisteredTool`

A tool with a callable `execute` function.

```typescript
interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}
```

---

#### `ValidationResult`

Returned by `validateManifest()` and `checkDependencies()`.

```typescript
interface ValidationResult {
  valid: boolean;     // true only when errors is empty
  errors: string[];   // Blocking issues — skill cannot load
  warnings: string[]; // Advisory notices — skill still loads
}
```

---

#### `SkillConfig`

Persisted per-skill configuration. Stored at `~/.orionomega/skills/{name}/config.json`.

```typescript
interface SkillConfig {
  name: string;                                       // Matches manifest.name
  enabled: boolean;                                   // Whether skill is active
  configured: boolean;                                // Whether setup has been completed
  authMethod?: string;                                // Which auth method was chosen
  configuredAt?: string;                              // ISO 8601 timestamp of last setup
  fields: Record<string, string | number | boolean>;  // User-provided field values
}
```

---

### `SkillLoader` class

Discovers, loads, validates, and matches skills from a directory.

```typescript
class SkillLoader {
  constructor(skillsDir: string)
}
```

`skillsDir` is resolved to an absolute path on construction.

#### `discoverAll(): Promise<SkillManifest[]>`

Scans `skillsDir` for subdirectories containing a valid `manifest.json`. Silently skips
directories with missing, unparseable, or invalid manifests.

```typescript
const loader = new SkillLoader('/path/to/skills');
const manifests = await loader.discoverAll();
// → [{ name: 'github', ... }, { name: 'web-search', ... }]
```

#### `discoverReady(): Promise<SkillManifest[]>`

Like `discoverAll()` but filters to skills that are both **enabled** and **configured**
(or don't require setup). Reads each skill's `config.json` to determine status.

#### `load(skillName: string): Promise<LoadedSkill>`

Fully loads a skill. Executes these steps in order:

1. Reads and parses `{skillDir}/manifest.json` → throws if missing or unparseable
2. Validates the manifest → throws if any **error** is found (warnings are ignored)
3. Checks all declared dependencies → throws if any are unmet
4. Runs `hooks.preLoad` script if defined → throws if it exits non-zero
5. Reads `SKILL.md` → empty string if absent
6. Reads `prompts/worker.md` → undefined if absent
7. Registers tool executors (each wraps `SkillExecutor.executeHandler`)
8. Caches and returns the `LoadedSkill`

**Throws:** `Error` with a descriptive message for any of the above failures.

```typescript
const skill = await loader.load('github');
const result = await skill.tools[0].execute({ action: 'list' });
```

#### `unload(skillName: string): void`

Removes a skill from the internal loaded map.

#### `get(skillName: string): LoadedSkill | undefined`

Returns a loaded skill by name, or `undefined` if not loaded.

#### `getAll(): LoadedSkill[]`

Returns all currently loaded skills as an array.

#### `matchSkills(userInput: string): SkillManifest[]`

Matches user input against trigger definitions from all discovered and loaded skills.

**Matching order (first match type wins per skill):**

1. **Commands** — exact prefix match (e.g. `/gh list` matches `/gh`)
2. **Keywords** — case-insensitive substring (e.g. `"pull request"` found in input)
3. **Patterns** — JavaScript regex tested with `i` flag

A skill appears at most once in the result regardless of how many triggers fire.

```typescript
loader.matchSkills('/gh list issues');
// → [{ name: 'github', ... }]

loader.matchSkills('What is the temperature in Tokyo?');
// → [{ name: 'weather', ... }]
```

#### `checkDependencies(manifest: SkillManifest): Promise<ValidationResult>`

Verifies external dependencies:
- `requires.commands` — each checked with `which <cmd>` → **error** if missing
- `requires.env` — each checked against `process.env` → **error** if unset
- `requires.skills` — checked against loaded/discovered skills → **error** if absent
- `requires.ports` and `requires.services` → **warning** only (not enforced at load time)

---

### `SkillExecutor` class

Executes skill handler scripts as child processes.

```typescript
class SkillExecutor {
  async executeHandler(
    handlerPath: string,
    params: Record<string, unknown>,
    options: {
      cwd: string;
      timeout: number;
      env?: Record<string, string>;
    }
  ): Promise<unknown>
}
```

**Execution steps:**

1. Resolves `handlerPath` relative to `options.cwd` if not absolute
2. Verifies file exists — throws `Handler file not found: {path}`
3. Verifies file is executable — throws `Handler file is not executable: {path}`
4. Spawns handler with `stdio: ['pipe', 'pipe', 'pipe']`
5. Writes `JSON.stringify(params)` to stdin, closes stdin
6. Enforces `options.timeout` — kills with SIGKILL on expiry
7. On timeout: throws `Handler "{path}" timed out after {N}ms.`
8. On non-zero exit: throws `Handler "{path}" exited with code {N}. stderr: {stderr}`
9. Parses stdout as JSON — if parsing fails, returns `{ result: "<raw stdout>" }`

The child process inherits `process.env` merged with `options.env`.

**Logging:** Set `ORIONOMEGA_LOG_LEVEL=verbose` or `debug` to log handler invocations.

---

### `validateManifest(manifest, currentVersion?)`

```typescript
function validateManifest(
  manifest: SkillManifest,
  currentVersion?: string
): ValidationResult
```

Validates a manifest object without touching the filesystem.

**Validation rules:**

| Check | Severity |
|-------|----------|
| `name`, `version`, `description`, `author`, `license`, `orionomega` present and non-empty | Error |
| `version` matches semver `X.Y.Z[-pre][+build]` | Error |
| `orionomega` is a parseable semver range | Warning if not parseable |
| `orionomega` range is compatible with `currentVersion` | Error if incompatible |
| `os[]` includes current platform | Warning if mismatch |
| `arch[]` includes current arch | Warning if mismatch |
| `requires` is an object | Error if missing |
| `triggers` is an object | Error if missing |
| `tools[i].name` is non-empty string | Error |
| `tools[i].handler` is non-empty string | Error |
| `tools[i].inputSchema` is an object | Error |
| `tools[i].description` is present | Warning |
| `tools[i].timeout` is a positive number (if provided) | Warning |

---

### `scaffoldSkill(name, targetDir)`

```typescript
async function scaffoldSkill(name: string, targetDir: string): Promise<void>
```

Creates a new skill directory at `{targetDir}/{name}/` containing:
- `manifest.json` — pre-filled with the skill name
- `SKILL.md` — documentation template
- `scripts/run.sh` — executable Bash handler (chmod 755)
- `tests/test.sh` — executable smoke test (chmod 755)

---

### Config functions

#### `readSkillConfig(skillsDir, name): SkillConfig`

Reads `{skillsDir}/{name}/config.json`. Returns the following default if absent:
```json
{ "name": "<name>", "enabled": true, "configured": false, "fields": {} }
```

#### `writeSkillConfig(skillsDir, config): void`

Writes config to `{skillsDir}/{name}/config.json`. Creates directories if needed.

#### `isSkillReady(skillsDir, manifest): boolean`

Returns `true` if `config.enabled === true` AND (`config.configured === true` OR
`manifest.setup?.required` is falsy).

#### `listSkillConfigs(skillsDir, manifests): Array<SkillConfig & { manifest: SkillManifest }>`

Returns one config entry per manifest, each merged with its manifest object.

---

## Handler Protocol

Handlers are **executable files** that implement the skill's tools. They can be written in
Node.js, Bash, Python, or any language that can read stdin and write stdout.

### Input

The handler receives a single JSON object on stdin containing the tool's parameters.

```js
// Node.js: read all stdin then parse
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const params = JSON.parse(raw);
```

```bash
# Bash: read stdin
INPUT=$(cat)
# Parse with jq:
QUERY=$(echo "$INPUT" | jq -r '.query')
```

### Output

Write **exactly one** JSON value to stdout. The executor parses this and returns it to the agent.

**Success (exit 0):**
```js
process.stdout.write(JSON.stringify({ items: results, count: results.length }));
```

**Failure (exit non-zero):**
```js
process.stdout.write(JSON.stringify({ error: 'API rate limit exceeded' }));
process.exit(1);
```

**Plain text fallback:** If stdout is not valid JSON, the executor wraps it:
`{ "result": "<raw stdout>" }`. Avoid relying on this — always output valid JSON.

### Handler languages

| Language | Shebang line            | Notes                         |
|----------|-------------------------|-------------------------------|
| Node.js  | `#!/usr/bin/env node`   | Recommended. Requires Node 22+|
| Bash     | `#!/usr/bin/env bash`   | Use `jq` for JSON I/O        |
| Python   | `#!/usr/bin/env python3`| Must be installed on system   |
| Any      | *(appropriate shebang)* | Any executable language works |

### Executable permission (required)

```bash
chmod +x handlers/my-tool.js
```

Handlers that are not executable will throw `Handler file is not executable: ...` and the
tool call will fail.

### Environment variables

Handlers inherit `process.env` plus:

| Variable | Value |
|---------|-------|
| `ORIONOMEGA_LOG_LEVEL` | Log level from the host process |
| `SKILL_{SKILLNAME}_{FIELDNAME}` | Values from `config.json` fields |

### stdout discipline

**Critical:** Write ONLY the result JSON to stdout. Any other output (debug logs, progress
messages) must go to **stderr**.

```js
// CORRECT
console.error('[debug] Calling API');          // → stderr (safe)
process.stdout.write(JSON.stringify(result));  // → stdout (parsed)

// WRONG — corrupts the JSON output
console.log('Calling API...');                 // → stdout (breaks parsing)
process.stdout.write(JSON.stringify(result));
```

---

## Lifecycle Hooks

Hooks are executable scripts declared in `manifest.json` under `hooks`. They follow the same
executable contract as handlers (any language, must be executable).

### `postInstall`

```json
{ "hooks": { "postInstall": "hooks/setup.js" } }
```

Runs after skill installation. Use for first-time setup, dependency downloads, or
directory creation. Non-zero exit produces a warning but does not block installation.

### `preLoad`

```json
{ "hooks": { "preLoad": "hooks/preload.sh" } }
```

Runs every time the skill is loaded (typically on agent start). Non-zero exit **blocks
the skill from loading** — the agent will not have access to this skill's tools.

Use for:
- Verifying an auth token is still valid
- Checking a required service is running

### `healthCheck`

```json
{ "hooks": { "healthCheck": "hooks/health.js" } }
```

Write a JSON object to stdout:

```json
{ "healthy": true, "message": "Connected to API as user@example.com" }
```

```json
{ "healthy": false, "message": "API key is invalid or expired. Re-run setup." }
```

The exit code is ignored for health checks — only stdout JSON is used.

---

## Trigger Matching

`SkillLoader.matchSkills(userInput)` matches input in this priority order:

### 1. Slash commands (highest priority)

Input must exactly equal the command OR start with `"{command} "` (case-insensitive).

```json
{ "commands": ["/gh"] }
```

| Input | Matches? |
|-------|---------|
| `/gh list issues` | Yes |
| `/gh` | Yes |
| `use gh to list issues` | No |

### 2. Keywords

Any keyword must appear as a substring of the input (case-insensitive).

```json
{ "keywords": ["weather", "temperature", "forecast"] }
```

| Input | Matches? |
|-------|---------|
| `What's the weather in Paris?` | Yes (`weather`) |
| `Show me the Temperature` | Yes (`temperature`, case-insensitive) |
| `What time is it?` | No |

### 3. Patterns

JavaScript regex patterns tested with the `i` flag.

```json
{ "patterns": ["\\b[A-Z]+-\\d+\\b"] }
```

| Input | Matches? |
|-------|---------|
| `Fix issue ENG-123` | Yes |
| `Close ABC-45 and DEF-99` | Yes |
| `Fix issue eng123` | No (no hyphen) |

**JSON escaping:** In JSON strings, `\b` must be written as `\\b`, `\d` as `\\d`, etc.

---

## Setup & Authentication

The `setup` block in `manifest.json` defines what configuration a skill needs before use.

### Minimal setup (no auth required)

```json
{
  "setup": {
    "required": false
  }
}
```

Or simply omit the `setup` field entirely. Skills without `setup.required = true` are
considered always configured.

### API key authentication

```json
{
  "setup": {
    "required": true,
    "description": "Authenticate with the My Service API.",
    "auth": {
      "methods": [
        {
          "type": "api-key",
          "label": "API Key",
          "description": "Generate a key at myservice.com/settings/api",
          "tokenUrl": "https://myservice.com/settings/api",
          "envVar": "MY_SERVICE_API_KEY",
          "validateCommand": "node -e \"fetch('https://api.myservice.com/me',{headers:{Authorization:'Bearer '+process.env.MY_SERVICE_API_KEY}}).then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))\""
        }
      ]
    }
  }
}
```

### Setup fields (user preferences)

```json
{
  "setup": {
    "required": true,
    "fields": [
      {
        "name": "default_team",
        "type": "string",
        "label": "Default team key",
        "description": "Team used when team is not specified (e.g. 'ENG')",
        "required": false
      }
    ]
  }
}
```

### Field value access in handlers

```js
// In handlers/my-tool.js
const defaultTeam = process.env.SKILL_MYSKILL_DEFAULT_TEAM || '';
```

---

## Configuration Storage

Each skill stores user configuration at:

```
~/.orionomega/skills/{skill-name}/config.json
```

### Example `config.json`

```json
{
  "name": "linear",
  "enabled": true,
  "configured": true,
  "authMethod": "api-key",
  "configuredAt": "2025-01-15T10:30:00.000Z",
  "fields": {
    "default_team": "ENG"
  }
}
```

### Default config (when file is absent)

```json
{ "name": "{skill-name}", "enabled": true, "configured": false, "fields": {} }
```

Skills without `setup.required = true` are always treated as configured regardless of
the `configured` flag value.

---

## Best Practices

### Error handling — always explicit

Never let unhandled exceptions crash a handler silently.

```js
// CORRECT: output an error JSON, exit non-zero
try {
  const result = await callApi(params);
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  process.stdout.write(JSON.stringify({
    error: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
}
```

### Respect timeouts

Use `AbortSignal.timeout()` with a margin inside the handler's own timeout:

```js
// Handler timeout is 30s — use 25s for the fetch to leave a margin
const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
```

### Never expose credentials in output

Read secrets from environment variables, never log or return them:

```js
const apiKey = process.env.SKILL_LINEAR_API_KEY;
if (!apiKey) {
  process.stdout.write(JSON.stringify({ error: 'API key not configured. Run setup.' }));
  process.exit(1);
}
// Use apiKey in headers only — never include it in output
```

### Tool naming convention

Use `snake_case` for tool names. Prefer an `action` enum over separate tools for related
operations on the same resource:

```json
{
  "name": "github_issue",
  "inputSchema": {
    "properties": {
      "action": { "type": "string", "enum": ["list", "view", "create", "close"] }
    },
    "required": ["action"]
  }
}
```

### Testing handlers

Test handlers directly without the full skill stack:

```bash
# Direct invocation
echo '{"location":"Tokyo"}' | node handlers/get_weather.js

# With auth env vars
SKILL_LINEAR_API_KEY=lin_api_xxxx node handlers/linear_issue.js <<< '{"action":"list"}'
```

Validate manifests programmatically:

```typescript
import { validateManifest } from '@orionomega/skills-sdk';
import manifest from './manifest.json' assert { type: 'json' };

const result = validateManifest(manifest);
if (!result.valid) {
  console.error('Manifest errors:', result.errors);
  process.exit(1);
}
if (result.warnings.length) {
  console.warn('Manifest warnings:', result.warnings);
}
```

### Write SKILL.md for the agent

`SKILL.md` is injected into the agent's system prompt. Write it to help the agent
understand WHEN and HOW to use each tool:

```markdown
# Weather Skill

Provides current weather data for any location using the Open-Meteo API.
No API key required.

## Tools

### `get_weather`

Returns current temperature and conditions for a city or coordinates.

**When to use:** Any request mentioning weather, temperature, forecast, or conditions.

**Parameters:**
- `location` (required): City name (e.g. "San Francisco") or "lat,lon" string

**Examples:**
- "What's the weather in Tokyo?" → `{ "location": "Tokyo" }`
- "Temperature at 37.7749,-122.4194" → `{ "location": "37.7749,-122.4194" }`
```

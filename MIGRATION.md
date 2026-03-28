# Skills SDK Migration Guide

This document explains how to migrate existing OrionOmega skills to the new
Skills SDK pattern introduced in `@orionomega/skills-sdk@0.2.0`.

Two default skills — **web-search** and **github** — have been migrated as
reference implementations. Use them as worked examples.

---

## What changed

| Area | Before (legacy) | After (SDK 0.2.0) |
|---|---|---|
| Settings schema | `setup.fields[]` (CLI prompts only) | `settings` block in manifest (Web UI + validation) |
| Auth storage | `GH_TOKEN` env var set manually | Password-type setting → injected as secret |
| Lifecycle | Hook scripts (`hooks/health.js`) | `ISkill` / `BaseSkill` TypeScript class |
| Loader | Always uses `ManifestSkill` wrapper | Prefers `skill.js` class, falls back to wrapper |

All changes are **additive and backward-compatible**. Existing skills with no
`settings` block and no `skill.js` continue to work exactly as before.

---

## Two migration paths

### Path A — Manifest-only (minimal, recommended first step)

Add a `settings` block to `manifest.json`. This is the only change needed to:
- Render a settings form in the Web UI
- Enable typed validation at save time
- Store secrets (API keys, tokens) securely instead of relying on bare env vars

No TypeScript, no compilation, no changes to handler scripts.

### Path B — TypeScript class (full migration)

Add a `skill.ts` alongside `manifest.json`, compile it to `skill.js`, and the
loader will use it automatically. Gives you:
- Typed settings access in `initialize()`
- Real health checks (e.g., call an API to verify auth)
- Tool descriptions that reflect runtime settings values
- Full control over activation / teardown

---

## Path A walkthrough: adding a `settings` block

### 1. Identify what the skill configures

Look at `setup.fields` and any `setup.auth.methods[].envVar` entries.
These become `settings.properties`.

### 2. Write the `settings` block

```json
{
  "settings": {
    "type": "object",
    "properties": {
      "api_key": {
        "type": "password",
        "label": "API Key",
        "description": "Your API key from the service settings page.",
        "required": true,
        "group": "auth",
        "widget": "secret",
        "order": 1
      },
      "default_region": {
        "type": "string",
        "label": "Default region",
        "description": "Region used when none is specified in a tool call.",
        "default": "us-east-1",
        "group": "preferences",
        "order": 1
      }
    },
    "required": ["api_key"]
  }
}
```

Key rules:
- Credentials → `type: "password"` + `group: "auth"` + `widget: "secret"`
- User preferences → `group: "preferences"`
- Internal/rarely-changed settings → `group: "advanced"`, optionally `hidden: true`
- `required` at the top level lists property keys, not booleans

### 3. Keep `setup.auth.methods` for the CLI flow

The `settings` block serves the Web UI. The `setup.auth.methods` array serves
the interactive terminal flow (`orionomega skill setup <name>`). Both can exist
simultaneously — they are complementary, not exclusive.

### 4. Version bump

Increment the manifest `version` (patch or minor) to signal the change.

### Migration diff — web-search

```diff
 {
+  "$schema": "https://orionomega.dev/schemas/skill-manifest.v1.json",
   "name": "web-search",
-  "version": "0.1.0",
+  "version": "0.2.0",
   ...
+  "settings": {
+    "type": "object",
+    "properties": {
+      "default_count": {
+        "type": "number",
+        "label": "Default result count",
+        "description": "How many results to return when the caller does not specify a count.",
+        "default": 5,
+        "group": "preferences",
+        "validation": { "min": 1, "max": 20 }
+      },
+      "max_chars": {
+        "type": "number",
+        "label": "Max output characters",
+        "description": "Truncate result text to this many characters.",
+        "default": 10000,
+        "group": "advanced",
+        "validation": { "min": 1000, "max": 50000 }
+      }
+    }
+  },
   ...
 }
```

### Migration diff — github

```diff
 {
+  "$schema": "https://orionomega.dev/schemas/skill-manifest.v1.json",
   "name": "github",
-  "version": "1.0.0",
+  "version": "1.1.0",
   ...
+  "settings": {
+    "type": "object",
+    "properties": {
+      "gh_token": {
+        "type": "password",
+        "label": "Personal Access Token (PAT)",
+        "description": "GitHub PAT. Alternative to `gh auth login`.",
+        "required": false,
+        "group": "auth",
+        "widget": "secret",
+        "validation": { "pattern": "^(ghp_|github_pat_).+" }
+      },
+      "default_owner": {
+        "type": "string",
+        "label": "Default repository owner",
+        "description": "Used when owner is not specified in a tool call.",
+        "group": "preferences"
+      }
+    }
+  },
   "setup": { ... }   ← keep existing setup block unchanged
 }
```

---

## Path B walkthrough: adding a TypeScript skill class

### 1. Create `skill.ts` in the skill directory

```typescript
import type { SkillTool, HealthStatus, SkillContext } from '@orionomega/skills-sdk';
import { BaseSkill } from '@orionomega/skills-sdk';

export default class MySkill extends BaseSkill {

  // Read settings values and initialize connections
  override async initialize(ctx: SkillContext): Promise<void> {
    await super.initialize(ctx);

    // ctx.config  → non-secret settings (string | number | boolean)
    // ctx.secrets → password-type settings (always string)
    const apiKey = ctx.secrets['api_key'];
    if (!apiKey) {
      throw new Error('api_key setting is required');
    }

    // Expose secret to child processes if handlers need it
    process.env['MY_SERVICE_API_KEY'] = apiKey;

    ctx.logger.info('MySkill initialized');
  }

  // Return tool definitions — mirrors the manifest tools array
  getTools(): SkillTool[] {
    return [
      {
        name: 'my_tool',
        description: 'Does something useful',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Input query' },
          },
          required: ['query'],
        },
        handler: 'handlers/my_tool.js',   // existing handler — unchanged
        timeout: 30_000,
      },
    ];
  }

  // Optional: override for real health checks instead of the default
  // "initialized + active" check from BaseSkill
  override async getHealth(): Promise<HealthStatus> {
    if (!this.initialized || !this.active) return super.getHealth();

    try {
      // e.g. await fetch('https://api.example.com/health')
      return { healthy: true, message: 'API reachable' };
    } catch {
      return {
        healthy: false,
        message: 'Cannot reach API',
        code: 'NETWORK_ERROR',
        retryable: true,
      };
    }
  }
}
```

### 2. Add `tsconfig.json` for the skill

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": ".",
    "rootDir": ".",
    "module": "nodenext",
    "target": "es2022"
  },
  "include": ["skill.ts"]
}
```

Or compile manually:
```sh
tsc skill.ts --module nodenext --target es2022 --moduleResolution nodenext
```

### 3. The loader auto-detects `skill.js`

Once `skill.js` exists in the skill directory, the loader uses it automatically.
No manifest changes are required for class mode — though adding a `settings`
block (Path A) is recommended to wire settings to the Web UI.

### 4. Lifecycle order

```
new MySkill()               ← loader calls this
  ↓
initialize(ctx)             ← validate config, open connections, set env vars
  ↓
activate()                  ← make operational (BaseSkill default: set active=true)
  ↓
[tool calls via handler scripts]
  ↓
getHealth()                 ← called periodically by the runtime
  ↓
deactivate()                ← release resources temporarily (skill may reactivate)
  ↓
dispose()                   ← full teardown on uninstall
```

---

## Loader dual-mode: how it works

The updated `loader.ts` adds:

| Function/Method | What it does |
|---|---|
| `tryLoadSkillClass(skillDir)` | Internal: tries `import('{skillDir}/skill.js')`. Returns the class or `null`. |
| `instantiateSkill()` | Now `async`. Calls `tryLoadSkillClass` first; falls back to `ManifestSkill` wrapper. |
| `SkillLoader.loadISkill(name, ctx?)` | New: loads manifest + instantiates ISkill + optionally initializes. |
| `SkillLoader.getISkill(name)` | New: retrieves stored ISkill instance by name. |
| `SkillLoader.load()` | **Unchanged** — still returns `LoadedSkill` with manifest-mode tool registration. |

### Backward compatibility

- `SkillLoader.load()` signature and return type are unchanged.
- Skills without `skill.js` behave identically to before.
- Skills with `skill.js` but without a `settings` block also work — the class
  is loaded and the manifest tools array is used for the `LoadedSkill` entry.

### Tool execution with class mode

`SkillLoader.load()` always registers `RegisteredTool` entries that execute
handler scripts directly via `SkillExecutor`. This ensures tool execution works
regardless of whether a skill class is present.

The `ISkill` instance from `loadISkill()` is for lifecycle management, health
checks, and settings-aware initialization — not for routing tool calls in the
`SkillLoader.load()` code path.

---

## Settings type reference

| `type` | UI widget | Notes |
|---|---|---|
| `string` | Text input | Use for names, slugs, identifiers |
| `password` | Masked input | Stored in `ctx.secrets`, redacted in logs |
| `number` | Number input | Supports `validation.min` / `validation.max` |
| `boolean` | Toggle | `default: true` or `false` |
| `select` | Dropdown | Requires `options: [{ label, value }]` |
| `multiselect` | Multi-select | Returns `string[]` |
| `url` | URL input | Format-validated |
| `textarea` | Multi-line text | Use for longer values, templates |

| `group` | Section in UI |
|---|---|
| `auth` | Authentication section (shown first) |
| `preferences` | User preferences |
| `advanced` | Collapsed advanced section |

---

## Remaining skills migration path

| Skill | Path A status | Path B status | Notes |
|---|---|---|---|
| **web-search** | Done (v0.2.0) | Done (`skill.ts` reference) | No auth → minimal settings |
| **github** | Done (v1.1.0) | Done (`skill.ts` reference) | PAT → `gh_token` secret |
| **web-fetch** | Pending | Not planned | No auth, one setting (`max_chars`) |
| **linear** | Pending | Recommended | API key → `linear_api_key` secret |

### web-fetch (Path A only)

Add a single `settings` block property:
```json
"max_chars": {
  "type": "number",
  "label": "Max output characters",
  "default": 10000,
  "group": "advanced",
  "validation": { "min": 1000, "max": 200000 }
}
```

### linear (Path A + B)

`settings` block needs:
- `linear_api_key`: password, auth group, required — replaces `LINEAR_API_KEY` env var
- `default_team`: string, preferences group — optional default team slug

`skill.ts` class would:
- Read `ctx.secrets['linear_api_key']` and set `process.env.LINEAR_API_KEY`
- Health check: call `https://api.linear.app/graphql` with `{ query: "{ viewer { id } }" }`
- Return `AUTH_REQUIRED` if the API returns 401

---

## Validation of the SDK

Both reference implementations confirm:

- **`SkillSettingsBlock` renders in the Web UI**: Three groups (auth, preferences,
  advanced) with all field types exercised (password, number, string).
- **`BaseSkill.initialize()`** receives `ctx.config` and `ctx.secrets` correctly
  split by `splitSecrets()` in `settings.ts`.
- **`getHealth()`** returns typed `HealthStatus` with `HealthErrorCode`.
- **`instantiateSkill()`** (now async) resolves the correct implementation
  without callers needing to know which mode is active.
- **`SkillLoader.load()`** remains backward-compatible — existing call sites
  need no changes.
- **`SkillLoader.loadISkill()`** is the new entry point for lifecycle-aware usage.

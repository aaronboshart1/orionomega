# Agent Instructions: Building OrionOmega Skills

This document is injected into the agent's context when a user asks to create a skill.
Follow every step in order. Do not skip steps or deviate from the procedures below.

---

## Mandatory Pre-Work: Information Gathering

Before writing any code, you MUST determine:

1. **Skill name** — A lowercase slug (letters, numbers, hyphens only). Examples: `weather`, `jira-cloud`, `slack-notifier`
2. **What the skill does** — The primary capability in one sentence
3. **Tools needed** — List of discrete operations (e.g. list, create, search, get)
4. **Authentication required?**
   - No auth → public API or local commands, no credentials
   - API key → user pastes a key from a web dashboard
   - OAuth → user authenticates via a browser or CLI tool
   - CLI-based → wraps a tool that manages auth itself (e.g. `gh`, `aws`)
5. **CLI dependencies** — Any command-line tools that must be on PATH (e.g. `jq`, `curl`, `gh`)
6. **Configuration fields** — User preferences beyond auth (e.g. default team, region, output format)

If any of items 1-4 are unclear, ask the user before proceeding.

---

## Step-by-Step Procedure

### Step 1 — Create the directory structure

```
{skill-name}/
├── manifest.json
├── SKILL.md
├── handlers/
│   └── (one .js file per tool)
└── hooks/           ← only if auth or health check needed
    └── health.js
```

Create ALL directories before writing any files.

### Step 2 — Write `manifest.json`

Use the template below. Replace every placeholder in `{curly braces}`.

```json
{
  "name": "{skill-name}",
  "version": "0.1.0",
  "description": "{One to two sentence description}",
  "author": "{Author name or handle}",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": {
    "commands": [],
    "skills": [],
    "env": []
  },
  "triggers": {
    "keywords": [],
    "commands": ["/{skill-name}"]
  },
  "tools": []
}
```

**Fill in the fields:**

| Field | Rule |
|-------|------|
| `name` | Must match the directory name exactly |
| `version` | Always start at `"0.1.0"` |
| `description` | 1-2 sentences. What it does, not how. |
| `license` | Always `"MIT"` unless user specifies otherwise |
| `orionomega` | Always `">=0.1.0"` |
| `requires.commands` | Array of CLI tool names. E.g. `["gh", "git"]` |
| `triggers.keywords` | 3-8 words/phrases users would say to invoke this skill |
| `triggers.commands` | Always `["/{skill-name}"]` |

### Step 3 — Define tools in the manifest

For each tool the user needs, add an entry to `tools[]`:

```json
{
  "name": "{skill_name}_{action}",
  "description": "{Verb-first description. What it returns. When to use it.}",
  "handler": "handlers/{tool_name}.js",
  "timeout": 30000,
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Tool naming rules:**
- Use `snake_case`
- Format: `{skill_name}_{noun}` (e.g. `github_issue`, `slack_message`)
- If one tool covers multiple operations, use `action` enum: `["list", "view", "create", "close"]`

**inputSchema rules:**
- Root MUST be `{ "type": "object", "properties": {...}, "required": [...] }`
- Every property MUST have a `"description"`
- Fixed-value parameters MUST use `"enum"` instead of free-form string
- Mark only truly required parameters in `"required"`

**Timeout selection:**
- Simple API calls: `30000` (30 seconds)
- File operations or slower APIs: `60000` (60 seconds)
- Long-running operations: `120000` (2 minutes)

### Step 4 — Add authentication (if needed)

Add a `setup` block to `manifest.json` based on the auth type:

**API key:**
```json
"setup": {
  "required": true,
  "description": "Add your {Service} API key.",
  "auth": {
    "methods": [{
      "type": "api-key",
      "label": "API Key",
      "description": "Generate at {token URL}",
      "tokenUrl": "{https://service.com/settings/api-keys}",
      "envVar": "{SERVICE_API_KEY}",
      "validateCommand": "node -e \"fetch('{validation URL}',{headers:{Authorization:'Bearer '+process.env.{SERVICE_API_KEY}}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
    }]
  }
}
```

**OAuth via CLI:**
```json
"setup": {
  "required": true,
  "description": "Sign in with {Service}.",
  "auth": {
    "methods": [{
      "type": "oauth",
      "label": "{Service} OAuth",
      "description": "Sign in via browser",
      "command": "{cli-tool} auth login --web",
      "validateCommand": "{cli-tool} auth status"
    }]
  }
}
```

**No auth:**
Do NOT add a `setup` block. Skills without `setup.required = true` are always ready.

### Step 5 — Write handler scripts

Create one `.js` file per tool in `handlers/`. Each handler MUST:

1. Be executable (`chmod +x` equivalent — set this in creation)
2. Start with `#!/usr/bin/env node`
3. Read all stdin then parse as JSON
4. Write one JSON value to stdout
5. Exit 0 on success, non-zero on failure
6. NEVER write non-JSON to stdout (use stderr for logs)

**Standard handler template:**

```js
#!/usr/bin/env node
/**
 * Handler: {tool_name}
 * Input  (stdin):  { param1: type, param2?: type }
 * Output (stdout): { field: type } or { error: string }
 */

async function main() {
  // Step 1: Read stdin
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  // Step 2: Parse params
  let params;
  try {
    params = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ error: 'Invalid JSON input' }));
    process.exit(1);
  }

  // Step 3: Read required env vars (for auth)
  const apiKey = process.env.SKILL_{SKILLNAME}_{FIELDNAME};
  if (!apiKey) {
    process.stdout.write(JSON.stringify({ error: 'API key not configured. Run setup.' }));
    process.exit(1);
  }

  // Step 4: Validate required params
  const { param1, param2 = 'default' } = params;
  if (!param1) {
    process.stdout.write(JSON.stringify({ error: 'param1 is required' }));
    process.exit(1);
  }

  // Step 5: Do work, handle errors
  try {
    const result = await doWork(apiKey, param1, param2);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stdout.write(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

async function doWork(apiKey, param1, param2) {
  // Implementation here
}

main();
```

**Environment variable naming formula:**

```
SKILL_{SKILLNAME}_{FIELDNAME}

SKILLNAME = manifest.name, uppercased, hyphens replaced with underscores
FIELDNAME = field.name, uppercased, hyphens replaced with underscores

Examples:
  skill "github",  field "default_owner"  →  SKILL_GITHUB_DEFAULT_OWNER
  skill "my-api",  field "api_key"        →  SKILL_MY_API_API_KEY
  skill "linear",  field "default_team"   →  SKILL_LINEAR_DEFAULT_TEAM
```

### Step 6 — Add a health check (if auth is required)

If the skill has `setup.required = true`, add `hooks/health.js`:

```json
"hooks": {
  "healthCheck": "hooks/health.js"
}
```

```js
#!/usr/bin/env node
// Health check — writes { healthy: boolean, message: string } to stdout

const API_KEY = process.env.SKILL_{SKILLNAME}_API_KEY;

async function main() {
  if (!API_KEY) {
    process.stdout.write(JSON.stringify({
      healthy: false,
      message: 'Not configured. Run setup to add your API key.',
    }));
    return; // exit 0 — health check always exits 0
  }

  try {
    const res = await fetch('{validation URL}', {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      process.stdout.write(JSON.stringify({ healthy: true, message: 'Connected' }));
    } else {
      process.stdout.write(JSON.stringify({
        healthy: false,
        message: `Auth failed (HTTP ${res.status}). Re-run setup.`,
      }));
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      healthy: false,
      message: `Connection error: ${String(err)}`,
    }));
  }
}

main();
```

### Step 7 — Write `SKILL.md`

`SKILL.md` is loaded into the agent's system prompt. Write it for an AI reader, not a human.
Describe WHEN and HOW to use each tool.

```markdown
# {Skill Name}

{One paragraph description. What it connects to, what it can do, any important limitations.}

{If auth required:}
## Authentication Required
This skill requires a {Service} API key. Run setup to configure.

## Tools

### `{tool_name}`

{What this tool does. What it returns. When the agent should prefer this tool.}

**When to use:** {Concrete situations that should trigger using this tool.}

**Parameters:**
| Name   | Type   | Required | Description        |
|--------|--------|----------|--------------------|
| param1 | string | yes      | {Description}      |
| param2 | number | no       | {Description (10)} |

**Returns:** {Describe the output structure and key fields.}

**Examples:**
- "{Natural language request}" → `{ "param1": "value" }`
- "{Another request}" → `{ "param1": "value", "param2": 5 }`
```

### Step 8 — Validate before declaring done

Run these checks mentally (or execute them if tooling is available):

**Manifest validation checklist:**
- [ ] `name` matches the directory name exactly
- [ ] `version` is valid semver (e.g. `"0.1.0"`)
- [ ] `description` is non-empty
- [ ] `author` is non-empty
- [ ] `license` is non-empty
- [ ] `orionomega` is a valid range (e.g. `">=0.1.0"`)
- [ ] `requires` is an object (even if all arrays are empty)
- [ ] `triggers` is an object with at least one entry
- [ ] Every tool has `name`, `description`, `handler`, `inputSchema`
- [ ] `inputSchema` has `type: "object"` at root
- [ ] Handler paths exist and end in an executable extension

**Handler checklist (for each handler):**
- [ ] Starts with `#!/usr/bin/env node` (or appropriate shebang)
- [ ] Reads all stdin before parsing
- [ ] Parses stdin as JSON with error handling
- [ ] Validates all required parameters
- [ ] Writes exactly one JSON value to stdout
- [ ] Exits 0 on success, 1 (or non-zero) on failure
- [ ] Does NOT write non-JSON to stdout
- [ ] Has executable permission (`chmod +x`)

**Auth checklist (if setup.required = true):**
- [ ] `setup.auth.methods[]` has at least one entry
- [ ] `envVar` field is set for `api-key` / `pat` auth types
- [ ] `validateCommand` is set and executable
- [ ] Handler reads API key from env var, not from params
- [ ] `hooks.healthCheck` points to a valid script

---

## Compliance Requirements

Every skill MUST satisfy ALL of these. Failure to comply means the skill will not load or will
malfunction at runtime.

### MUST requirements (non-negotiable)

1. **Directory name = `manifest.name`** — The folder name MUST exactly match `manifest.name`
2. **Handler executables** — Every handler file MUST have execute permission
3. **Handler shebang** — Every handler MUST start with a valid shebang line
4. **Stdin protocol** — Handlers MUST read ALL stdin before processing
5. **Stdout protocol** — Handlers MUST write ONLY valid JSON to stdout
6. **JSON inputSchema** — Every tool's `inputSchema` MUST be `{ "type": "object", ... }`
7. **Required fields** — `name`, `version`, `description`, `author`, `license`, `orionomega`, `requires`, `triggers` are ALL required
8. **Requires is always an object** — Even if no dependencies: `"requires": {}`
9. **Semver version** — `version` must be `X.Y.Z` format
10. **Auth env var naming** — Use `SKILL_{SKILLNAME}_{FIELDNAME}` pattern exactly

### SHOULD requirements (best practice)

11. Include `SKILL.md` with per-tool documentation
12. Include a `healthCheck` hook if the skill requires authentication
13. Every tool `description` should be specific and action-oriented
14. Every `inputSchema` property should have a `description`
15. Use `enum` for fixed-value parameters
16. Validate required parameters at the top of each handler
17. Use `AbortSignal.timeout()` for all network requests

---

## Common Mistakes and Fixes

### Mistake 1: Wrong env var name

**Wrong:**
```js
const key = process.env.LINEAR_API_KEY;        // Missing SKILL_ prefix
const key = process.env.SKILL_LINEAR_APIKEY;   // Missing underscore before APIKEY
```

**Correct:**
```js
const key = process.env.SKILL_LINEAR_API_KEY;  // skill "linear", field "api_key"
```

**Formula:** `SKILL_` + `manifest.name.toUpperCase().replace(/-/g, '_')` + `_` + `field.name.toUpperCase().replace(/-/g, '_')`

---

### Mistake 2: Writing to stdout before the final result

**Wrong:**
```js
console.log('Fetching data...');               // Writes to stdout, breaks JSON parse
const data = await fetchData();
process.stdout.write(JSON.stringify(data));
```

**Correct:**
```js
console.error('Fetching data...');             // stderr is safe
const data = await fetchData();
process.stdout.write(JSON.stringify(data));
```

---

### Mistake 3: Handler not executable

**Wrong:** Creating a file with `Write` but not setting permissions.

**Correct:** After writing every handler file, set executable bit:
```bash
chmod +x handlers/my_tool.js
chmod +x hooks/health.js
```

---

### Mistake 4: Partial stdin read

**Wrong:**
```js
process.stdin.once('data', chunk => {           // Only reads first chunk!
  const params = JSON.parse(chunk);
});
```

**Correct:**
```js
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const params = JSON.parse(raw);
```

---

### Mistake 5: Missing `required` in inputSchema

**Wrong:**
```json
{
  "type": "object",
  "properties": {
    "action": { "type": "string" }
  }
}
```
(No `required` array — all parameters treated as optional)

**Correct:**
```json
{
  "type": "object",
  "properties": {
    "action": { "type": "string", "description": "Operation to perform" }
  },
  "required": ["action"]
}
```

---

### Mistake 6: Hardcoding credentials

**Wrong:**
```js
const API_KEY = 'lin_api_xxxxxxxxxxxxxx';   // Never hardcode
```

**Correct:**
```js
const API_KEY = process.env.SKILL_LINEAR_API_KEY;
if (!API_KEY) {
  process.stdout.write(JSON.stringify({ error: 'API key not configured. Run setup.' }));
  process.exit(1);
}
```

---

### Mistake 7: Non-object inputSchema root

**Wrong:**
```json
{
  "inputSchema": {
    "query": { "type": "string" }
  }
}
```

**Correct:**
```json
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" }
    },
    "required": ["query"]
  }
}
```

---

### Mistake 8: Handler path not relative to skill directory

**Wrong:**
```json
{ "handler": "/absolute/path/to/handler.js" }
```

**Correct:**
```json
{ "handler": "handlers/my_tool.js" }
```
(Relative paths are resolved from the skill directory.)

---

### Mistake 9: Tool name doesn't include skill name

**Wrong:**
```json
{ "name": "list_issues" }
```

**Correct:**
```json
{ "name": "github_issue" }
```
(Tool names must be globally unique. Prefix with skill name.)

---

### Mistake 10: Omitting `requires` entirely

**Wrong:**
```json
{
  "name": "my-skill",
  "triggers": { "keywords": ["test"] }
}
```
(Missing `requires` field — validation error, skill fails to load.)

**Correct:**
```json
{
  "name": "my-skill",
  "triggers": { "keywords": ["test"] },
  "requires": {}
}
```

---

## Validation Steps

After creating all files, perform these checks:

### 1. Parse the manifest

```bash
node -e "const m = JSON.parse(require('fs').readFileSync('./manifest.json','utf8')); console.log('name:', m.name, 'tools:', m.tools?.length ?? 0)"
```

Expected: prints name and tool count without error.

### 2. Test each handler directly

```bash
echo '{"param1":"test"}' | node handlers/my_tool.js
```

Expected: prints valid JSON, exits 0.

### 3. Test error handling

```bash
echo '{}' | node handlers/my_tool.js; echo "Exit: $?"
```

Expected: prints `{"error":"..."}`, exits non-zero.

### 4. Verify handler is executable

```bash
ls -la handlers/
```

Expected: handler files show `-rwxr-xr-x` permissions.

### 5. Validate manifest with SDK (if available)

```typescript
import { validateManifest } from '@orionomega/skills-sdk';
import manifest from './manifest.json' assert { type: 'json' };
const result = validateManifest(manifest);
console.log(result);
// Expected: { valid: true, errors: [], warnings: [] }
```

---

## Correct vs Incorrect Examples

### Example A — Tool with action enum

**Correct:**
```json
{
  "name": "github_issue",
  "description": "Manage GitHub issues: list open issues, view details, create new issues, or close existing ones.",
  "handler": "handlers/gh_issue.js",
  "timeout": 30000,
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["list", "view", "create", "close"],
        "description": "Operation to perform on issues"
      },
      "number": {
        "type": "number",
        "description": "Issue number (required for view/close)"
      },
      "title": {
        "type": "string",
        "description": "Issue title (required for create)"
      }
    },
    "required": ["action"]
  }
}
```

**Incorrect:**
```json
{
  "name": "issue",
  "handler": "handler.js",
  "inputSchema": {
    "action": { "type": "string" },
    "number": { "type": "number" }
  }
}
```
Problems: name missing skill prefix, no description, inputSchema missing type:object wrapper, no required array, no property descriptions.

---

### Example B — Handler reading auth from env

**Correct:**
```js
#!/usr/bin/env node
// Reads auth from: SKILL_SLACK_BOT_TOKEN

const TOKEN = process.env.SKILL_SLACK_BOT_TOKEN;

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { channel, message } = JSON.parse(raw);

  if (!TOKEN) {
    process.stdout.write(JSON.stringify({ error: 'Bot token not configured. Run setup.' }));
    process.exit(1);
  }
  if (!channel || !message) {
    process.stdout.write(JSON.stringify({ error: 'channel and message are required' }));
    process.exit(1);
  }

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, text: message }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = await res.json();
    process.stdout.write(JSON.stringify(data.ok
      ? { sent: true, ts: data.ts }
      : { error: data.error }
    ));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err) }));
    process.exit(1);
  }
}

main();
```

**Incorrect:**
```js
// Missing shebang
// Missing stdin read
const TOKEN = 'xoxb-hardcoded-token';  // NEVER hardcode
fetch('https://slack.com/api/chat.postMessage', {
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ channel: 'general', text: 'hello' }),
}).then(r => r.json()).then(d => console.log(d));  // console.log writes to stdout!
```

Problems: no shebang, no stdin read, hardcoded token, `console.log` contaminates stdout,
no error handling, no parameter validation.

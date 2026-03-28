# Skill Template Reference

Copy-paste templates for creating OrionOmega skills. Every field is annotated.

---

## Template 1 — Minimal skill (no auth)

Use this for skills that call public APIs or run local commands with no credentials.

### `manifest.json`

```json
{
  "name": "my-skill",
  "version": "0.1.0",
  "description": "One to two sentences describing what this skill does and why it is useful.",
  "author": "Your Name",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": {
    "commands": [],
    "skills": [],
    "env": []
  },
  "triggers": {
    "keywords": ["keyword1", "keyword2"],
    "commands": ["/my-skill"]
  },
  "tools": [
    {
      "name": "my_tool",
      "description": "Action-oriented description: what this tool does, what it returns, when to use it.",
      "handler": "handlers/my_tool.js",
      "timeout": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The search query or input value"
          },
          "limit": {
            "type": "number",
            "description": "Maximum number of results to return (default 10)"
          }
        },
        "required": ["query"]
      }
    }
  ],
  "workerProfile": {
    "tools": ["my_tool"],
    "maxTimeout": 60000
  }
}
```

### `handlers/my_tool.js`

```js
#!/usr/bin/env node
/**
 * Handler: my_tool
 * Input  (stdin):  { query: string, limit?: number }
 * Output (stdout): JSON result
 */

async function main() {
  // 1. Read all stdin
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  // 2. Parse parameters
  let params;
  try {
    params = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ error: 'Invalid JSON input' }));
    process.exit(1);
  }

  const { query, limit = 10 } = params;

  // 3. Validate required fields
  if (!query || typeof query !== 'string') {
    process.stdout.write(JSON.stringify({ error: 'query (string) is required' }));
    process.exit(1);
  }

  // 4. Do the work
  try {
    const result = await doWork(query, Number(limit));
    // 5. Write result JSON to stdout and exit 0
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stdout.write(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

async function doWork(query, limit) {
  // Replace with real implementation
  return { results: [], query, limit };
}

main();
```

Make the handler executable:
```bash
chmod +x handlers/my_tool.js
```

### `SKILL.md`

```markdown
# My Skill

Brief description of what this skill provides.

## Tools

### `my_tool`

Short description of what my_tool does.

**When to use:** List the situations where the agent should call this tool.

**Parameters:**
| Name  | Type   | Required | Description       |
|-------|--------|----------|-------------------|
| query | string | yes      | The search query  |
| limit | number | no       | Max results (10)  |

**Returns:** Describe the shape of the JSON output.

**Examples:**
- "Find articles about Node.js" → `{ "query": "Node.js articles" }`
- "Show me 5 results for TypeScript" → `{ "query": "TypeScript", "limit": 5 }`
```

---

## Template 2 — Skill with API key authentication

Use this for skills that call an authenticated REST API using a user-provided key.

### `manifest.json`

```json
{
  "name": "my-api-skill",
  "version": "0.1.0",
  "description": "Integrates with MyService API to manage resources.",
  "author": "Your Name",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": {
    "commands": [],
    "skills": [],
    "env": []
  },
  "setup": {
    "required": true,
    "description": "Authenticate with MyService to use this skill.",
    "auth": {
      "methods": [
        {
          "type": "api-key",
          "label": "API Key",
          "description": "Generate a key at myservice.com/settings/api-keys",
          "tokenUrl": "https://myservice.com/settings/api-keys",
          "envVar": "MY_SERVICE_API_KEY",
          "validateCommand": "node -e \"fetch('https://api.myservice.com/v1/me',{headers:{Authorization:'Bearer '+process.env.MY_SERVICE_API_KEY}}).then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))\""
        }
      ]
    },
    "fields": [
      {
        "name": "base_url",
        "type": "string",
        "label": "API base URL",
        "description": "Override if using a self-hosted instance (optional)",
        "required": false,
        "default": "https://api.myservice.com/v1"
      }
    ]
  },
  "triggers": {
    "keywords": ["myservice", "my service"],
    "commands": ["/myservice"]
  },
  "tools": [
    {
      "name": "myservice_list",
      "description": "List resources from MyService. Returns an array of resource objects.",
      "handler": "handlers/list.js",
      "timeout": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "resource": {
            "type": "string",
            "enum": ["projects", "users", "tasks"],
            "description": "Resource type to list"
          },
          "limit": {
            "type": "number",
            "description": "Maximum results (default 20)"
          }
        },
        "required": ["resource"]
      }
    },
    {
      "name": "myservice_create",
      "description": "Create a new resource in MyService.",
      "handler": "handlers/create.js",
      "timeout": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "resource": {
            "type": "string",
            "enum": ["projects", "tasks"],
            "description": "Resource type to create"
          },
          "name": {
            "type": "string",
            "description": "Name of the resource"
          },
          "description": {
            "type": "string",
            "description": "Optional description"
          }
        },
        "required": ["resource", "name"]
      }
    }
  ],
  "hooks": {
    "healthCheck": "hooks/health.js"
  }
}
```

### `handlers/list.js`

```js
#!/usr/bin/env node
/**
 * Handler: myservice_list
 * Reads API key from env: SKILL_MY_API_SKILL_MY_SERVICE_API_KEY
 * Reads base URL from env: SKILL_MY_API_SKILL_BASE_URL
 */

const API_KEY = process.env.SKILL_MY_API_SKILL_MY_SERVICE_API_KEY;
const BASE_URL = process.env.SKILL_MY_API_SKILL_BASE_URL || 'https://api.myservice.com/v1';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { resource, limit = 20 } = JSON.parse(raw);

  if (!API_KEY) {
    process.stdout.write(JSON.stringify({ error: 'API key not configured. Run setup.' }));
    process.exit(1);
  }

  try {
    const res = await fetch(`${BASE_URL}/${resource}?limit=${limit}`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const body = await res.text();
      process.stdout.write(JSON.stringify({
        error: `API error ${res.status}: ${body.slice(0, 200)}`,
      }));
      process.exit(1);
    }

    const data = await res.json();
    process.stdout.write(JSON.stringify(data));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err) }));
    process.exit(1);
  }
}

main();
```

### `hooks/health.js`

```js
#!/usr/bin/env node
/**
 * Health check hook.
 * Writes { healthy: boolean, message: string } to stdout.
 */

const API_KEY = process.env.SKILL_MY_API_SKILL_MY_SERVICE_API_KEY;
const BASE_URL = process.env.SKILL_MY_API_SKILL_BASE_URL || 'https://api.myservice.com/v1';

async function main() {
  if (!API_KEY) {
    process.stdout.write(JSON.stringify({
      healthy: false,
      message: 'API key not configured. Run setup to add your API key.',
    }));
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const user = await res.json();
      process.stdout.write(JSON.stringify({
        healthy: true,
        message: `Connected as ${user.email ?? user.name ?? 'user'}`,
      }));
    } else {
      process.stdout.write(JSON.stringify({
        healthy: false,
        message: `Authentication failed (HTTP ${res.status}). Re-run setup.`,
      }));
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      healthy: false,
      message: `Connection failed: ${String(err)}`,
    }));
  }
}

main();
```

---

## Template 3 — Skill with CLI tool dependency (OAuth)

Use this for skills that wrap a CLI tool that manages its own authentication (like `gh`).

### `manifest.json`

```json
{
  "name": "my-cli-skill",
  "version": "0.1.0",
  "description": "Wraps the mycli command-line tool to manage resources.",
  "author": "Your Name",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": {
    "commands": ["mycli"],
    "skills": [],
    "env": []
  },
  "setup": {
    "required": true,
    "description": "Authenticate the mycli tool.",
    "auth": {
      "methods": [
        {
          "type": "oauth",
          "label": "OAuth Login (recommended)",
          "description": "Sign in via browser device flow",
          "command": "mycli auth login --web",
          "validateCommand": "mycli auth status"
        },
        {
          "type": "pat",
          "label": "Personal Access Token",
          "description": "Paste a token from myservice.com/settings/tokens",
          "tokenUrl": "https://myservice.com/settings/tokens",
          "envVar": "MYCLI_TOKEN",
          "validateCommand": "mycli auth status"
        }
      ]
    },
    "fields": [
      {
        "name": "default_org",
        "type": "string",
        "label": "Default organization",
        "description": "Used when org is not specified in a command",
        "required": false
      }
    ],
    "handler": "hooks/setup.js"
  },
  "triggers": {
    "keywords": ["mycli", "myservice"],
    "patterns": ["\\bmycli\\s+\\w+\\b"],
    "commands": ["/mycli"]
  },
  "tools": [
    {
      "name": "mycli_run",
      "description": "Run a mycli command. Returns the command output as structured data.",
      "handler": "handlers/mycli_run.js",
      "timeout": 60000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "subcommand": {
            "type": "string",
            "enum": ["list", "view", "create", "delete"],
            "description": "The mycli subcommand to run"
          },
          "resource": {
            "type": "string",
            "description": "Resource name or ID"
          },
          "args": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Additional arguments"
          }
        },
        "required": ["subcommand"]
      }
    }
  ],
  "hooks": {
    "healthCheck": "hooks/health.sh",
    "postInstall": "hooks/setup.js"
  }
}
```

### `handlers/mycli_run.js`

```js
#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_ORG = process.env.SKILL_MY_CLI_SKILL_DEFAULT_ORG || '';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { subcommand, resource, args = [] } = JSON.parse(raw);

  const cliArgs = [subcommand];
  if (resource) cliArgs.push(resource);
  cliArgs.push(...args);
  if (DEFAULT_ORG && !args.includes('--org')) {
    cliArgs.push('--org', DEFAULT_ORG);
  }
  cliArgs.push('--json'); // request machine-readable output

  try {
    const { stdout } = await execFileAsync('mycli', cliArgs, { timeout: 55_000 });
    const parsed = JSON.parse(stdout.trim());
    process.stdout.write(JSON.stringify(parsed));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: `mycli failed: ${msg}` }));
    process.exit(1);
  }
}

main();
```

### `hooks/health.sh`

```bash
#!/usr/bin/env bash
# Health check: verify mycli authentication
if mycli auth status --json 2>/dev/null | grep -q '"logged_in":true'; then
  user=$(mycli auth whoami 2>/dev/null || echo "unknown")
  echo "{\"healthy\":true,\"message\":\"Authenticated as $user\"}"
else
  echo '{"healthy":false,"message":"Not authenticated. Run: mycli auth login --web"}'
fi
```

```bash
chmod +x handlers/mycli_run.js hooks/health.sh
```

---

## Template 4 — Multi-tool skill with Bash handlers

Use this when your tools are simple enough to implement in Bash.

### `handlers/list.sh`

```bash
#!/usr/bin/env bash
# Handler: myskill_list
# Input (stdin):  JSON object
# Output (stdout): JSON object

set -euo pipefail

# Read stdin
INPUT=$(cat)

# Parse params with jq (must be installed)
RESOURCE=$(echo "$INPUT" | jq -r '.resource // "all"')
LIMIT=$(echo "$INPUT" | jq -r '.limit // 10')

# Check dependencies
if ! command -v jq &>/dev/null; then
  echo '{"error":"jq is required but not installed"}' >&1
  exit 1
fi

# Read env vars
API_KEY="${SKILL_MY_SKILL_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo '{"error":"API key not configured. Run setup."}' >&1
  exit 1
fi

# Make API call and return JSON
RESULT=$(curl -sf \
  -H "Authorization: Bearer $API_KEY" \
  "https://api.example.com/$RESOURCE?limit=$LIMIT" \
  2>/dev/null) || {
  echo '{"error":"API request failed"}'
  exit 1
}

echo "$RESULT"
```

---

## Settings schema examples

### Pattern A — No auth, no fields

```json
{
  "requires": { "commands": [], "skills": [], "env": [] }
}
```
(Omit `setup` entirely. Skill is always considered configured.)

### Pattern B — API key with optional preferences

```json
{
  "setup": {
    "required": true,
    "description": "Add your API key to start using this skill.",
    "auth": {
      "methods": [
        {
          "type": "api-key",
          "label": "API Key",
          "description": "Find your key at dashboard.example.com/settings",
          "tokenUrl": "https://dashboard.example.com/settings",
          "envVar": "EXAMPLE_API_KEY",
          "validateCommand": "node -e \"fetch('https://api.example.com/ping',{headers:{Authorization:'Bearer '+process.env.EXAMPLE_API_KEY}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
        }
      ]
    },
    "fields": [
      {
        "name": "region",
        "type": "select",
        "label": "API region",
        "description": "Choose the region closest to you",
        "required": false,
        "default": "us-east",
        "options": [
          { "label": "US East", "value": "us-east" },
          { "label": "US West", "value": "us-west" },
          { "label": "EU", "value": "eu-west" },
          { "label": "Asia Pacific", "value": "ap-southeast" }
        ]
      }
    ]
  }
}
```

### Pattern C — OAuth via CLI with boolean preference

```json
{
  "setup": {
    "required": true,
    "description": "Sign in to your account to manage resources.",
    "auth": {
      "methods": [
        {
          "type": "oauth",
          "label": "Sign in with OAuth",
          "description": "Opens a browser window to authorize access",
          "command": "mycli auth login --web",
          "validateCommand": "mycli auth status"
        }
      ]
    },
    "fields": [
      {
        "name": "verbose_output",
        "type": "boolean",
        "label": "Verbose output",
        "description": "Include extra metadata in tool responses",
        "required": false,
        "default": false
      }
    ]
  }
}
```

### Pattern D — Multiple auth methods (user picks one)

```json
{
  "setup": {
    "required": true,
    "description": "Choose how to authenticate with the service.",
    "auth": {
      "methods": [
        {
          "type": "oauth",
          "label": "OAuth (recommended)",
          "description": "Most secure. Requires browser.",
          "command": "mycli auth login --web",
          "validateCommand": "mycli auth status"
        },
        {
          "type": "pat",
          "label": "Personal Access Token",
          "description": "Works over SSH without a browser.",
          "tokenUrl": "https://example.com/settings/tokens",
          "envVar": "EXAMPLE_PAT",
          "validateCommand": "mycli auth status"
        },
        {
          "type": "env",
          "label": "Use existing EXAMPLE_TOKEN env var",
          "description": "For CI/CD environments where the token is already set.",
          "envVar": "EXAMPLE_TOKEN"
        }
      ]
    }
  }
}
```

# basic-skill — OrionOmega Skill Template

A minimal, working skill template. Copy this directory and modify it to build your skill.

## Files

```
basic-skill/
├── manifest.json             Skill declaration — identity, tools, triggers, setup
├── SKILL.md                  Agent-facing documentation (injected into system prompt)
├── handlers/
│   └── example-tool.js       Handler for the basic_skill_example tool
└── README.md                 This file
```

## Quick start

### 1. Copy this template

```bash
cp -r basic-skill my-new-skill
cd my-new-skill
```

### 2. Update `manifest.json`

Required changes:
- `name` — Set to your skill's slug (must match the directory name)
- `description` — Describe what your skill does
- `author` — Your name or team
- `triggers.keywords` — Words/phrases that should activate your skill
- `tools[0].name` — Rename the tool (format: `{skillname}_{noun}`)
- `tools[0].description` — Describe what the tool does
- `tools[0].handler` — Update if you rename the handler file
- `tools[0].inputSchema` — Define the tool's parameters

Optional changes:
- `requires.commands` — Add CLI dependencies (e.g. `["jq", "curl"]`)
- `os` — Restrict to specific platforms if needed
- `workerProfile` — Adjust timeout and tool list

### 3. Update the handler

Edit `handlers/example-tool.js`:
- Update the parameter extraction to match your `inputSchema`
- Replace `getItem()` and `listItems()` with your real implementation
- Add API calls, CLI invocations, or any other logic

Make the handler executable:
```bash
chmod +x handlers/example-tool.js
```

### 4. Test the handler directly

```bash
# Test get action
echo '{"query":"hello","action":"get"}' | node handlers/example-tool.js

# Test list action
echo '{"query":"hello","action":"list","limit":5}' | node handlers/example-tool.js

# Test error handling (missing required param)
echo '{"action":"get"}' | node handlers/example-tool.js; echo "Exit: $?"
```

### 5. Update `SKILL.md`

Replace the placeholder content with real documentation for your skill. The agent
uses this file to understand when and how to call each tool.

### 6. Install the skill

Place the skill directory in your OrionOmega skills folder:

```bash
mv my-new-skill ~/.orionomega/skills/
```

## Extending the template

### Add authentication

If your skill requires credentials, add a `setup` block to `manifest.json`:

```json
{
  "setup": {
    "required": true,
    "description": "Add your API key to use this skill.",
    "auth": {
      "methods": [{
        "type": "api-key",
        "label": "API Key",
        "description": "Find your key at your-service.com/settings",
        "tokenUrl": "https://your-service.com/settings/api-keys",
        "envVar": "YOUR_SERVICE_API_KEY",
        "validateCommand": "node -e \"fetch('https://api.your-service.com/me',{headers:{Authorization:'Bearer '+process.env.YOUR_SERVICE_API_KEY}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
      }]
    }
  },
  "hooks": {
    "healthCheck": "hooks/health.js"
  }
}
```

Then read the key in your handler:
```js
const API_KEY = process.env.SKILL_MY_NEW_SKILL_YOUR_SERVICE_API_KEY;
```

### Add more tools

Add entries to `manifest.json`'s `tools[]` array and create corresponding handler files:

```json
{
  "name": "my_skill_create",
  "description": "Create a new item.",
  "handler": "handlers/create.js",
  "timeout": 30000,
  "inputSchema": { ... }
}
```

### Add a health check

Create `hooks/health.js`:

```js
#!/usr/bin/env node
async function main() {
  // Check that auth/config is working
  process.stdout.write(JSON.stringify({ healthy: true, message: 'Ready' }));
}
main();
```

```bash
chmod +x hooks/health.js
```

### Add CLI dependencies

If your handlers call external CLI tools, declare them in `requires.commands`:

```json
{
  "requires": {
    "commands": ["jq", "curl"],
    "skills": [],
    "env": []
  }
}
```

Skills with unmet command dependencies will fail to load with a descriptive error.

## Handler writing rules

1. Start every handler with `#!/usr/bin/env node`
2. Read ALL stdin before parsing: `for await (const chunk of process.stdin) raw += chunk`
3. Write ONLY valid JSON to stdout
4. Write debug/log output to stderr (never stdout)
5. Exit 0 on success, non-zero on failure
6. Validate all required parameters before doing work
7. Read credentials from env vars — never hardcode them
8. Use `AbortSignal.timeout()` for all network requests

## Reference

- [SKILLS_SDK.md](../../docs/SKILLS_SDK.md) — Complete API reference
- [SKILL_TEMPLATE.md](../../docs/SKILL_TEMPLATE.md) — Copy-paste templates for common patterns
- [SETTINGS_SCHEMA_GUIDE.md](../../docs/SETTINGS_SCHEMA_GUIDE.md) — Auth and settings guide
- [AGENT_INSTRUCTIONS.md](../../docs/AGENT_INSTRUCTIONS.md) — Procedural guide for AI agents

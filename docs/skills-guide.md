# Skills Guide

This guide walks you through creating custom skills for OrionOmega — from directory structure to testing.

## What is a Skill?

A skill is a self-contained capability package that adds tools and domain knowledge to OrionOmega workers. Skills are how you teach the system new abilities — calling APIs, processing data, interacting with services.

Each skill consists of:

- **A manifest** (`manifest.json`) — metadata, dependencies, tool definitions, and triggers
- **Documentation** (`SKILL.md`) — instructions for the agent on how and when to use the skill
- **Tool handlers** (`scripts/`) — executable scripts that perform the actual work
- **Optional prompts** (`prompts/`) — system prompts for workers using this skill

Skills are loaded automatically on startup from `~/.orionomega/skills/` (configurable via `config.skills.directory`).

## Directory Structure

```
my-skill/
├── manifest.json           # Required — skill metadata and tool definitions
├── SKILL.md                # Required — agent-facing documentation
├── scripts/
│   ├── handler.ts          # Tool handler script(s)
│   └── health-check.ts     # Optional health check script
├── prompts/
│   └── worker.md           # Optional worker system prompt
└── assets/                 # Optional static assets
```

Scaffold a new skill with:

```bash
orionomega skill create my-skill
```

This creates the directory structure with starter files.

## manifest.json Reference

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "Short description of what this skill does",
  "author": "Your Name",
  "license": "MIT",
  "homepage": "https://github.com/you/my-skill",
  "repository": "https://github.com/you/my-skill",

  "orionomega": ">=0.1.0",
  "os": ["linux"],
  "arch": ["x64", "arm64"],

  "requires": {
    "commands": ["curl", "jq"],
    "skills": [],
    "env": ["MY_API_KEY"],
    "ports": [],
    "services": []
  },

  "tools": [
    {
      "name": "my_tool",
      "description": "What this tool does",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search query" },
          "limit": { "type": "number", "description": "Max results", "default": 10 }
        },
        "required": ["query"]
      },
      "handler": "scripts/handler.ts",
      "timeout": 30000
    }
  ],

  "triggers": {
    "keywords": ["my-skill", "my-tool"],
    "patterns": ["\\bmy[-\\s]?skill\\b"],
    "commands": ["/myskill"]
  },

  "workerProfile": {
    "model": "claude-haiku-4-20250514",
    "tools": ["my_tool", "web_fetch"],
    "maxTimeout": 60000
  },

  "hooks": {
    "postInstall": "scripts/post-install.sh",
    "preLoad": "scripts/pre-load.sh",
    "healthCheck": "scripts/health-check.ts"
  }
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Unique slug identifier (lowercase, hyphens) |
| `version` | string | ✅ | Semver version |
| `description` | string | ✅ | Human-readable description |
| `author` | string | ✅ | Author name or handle |
| `license` | string | ✅ | SPDX license identifier |
| `homepage` | string | — | URL to documentation |
| `repository` | string | — | URL to source code |
| `orionomega` | string | ✅ | Semver range for OrionOmega compatibility |
| `os` | string[] | — | Supported operating systems |
| `arch` | string[] | — | Supported CPU architectures |
| `requires.commands` | string[] | — | CLI commands that must be on PATH |
| `requires.skills` | string[] | — | Other skills that must be installed |
| `requires.env` | string[] | — | Environment variables that must be set |
| `requires.ports` | number[] | — | Network ports that must be available |
| `requires.services` | string[] | — | Systemd services that must be running |
| `tools` | SkillTool[] | — | Tool definitions (see below) |
| `triggers.keywords` | string[] | — | Keywords that activate this skill |
| `triggers.patterns` | string[] | — | Regex patterns to match user input |
| `triggers.commands` | string[] | — | Slash commands (e.g., `/myskill`) |
| `workerProfile.model` | string | — | Preferred model when running as a worker |
| `workerProfile.tools` | string[] | — | Available tools for the worker |
| `workerProfile.maxTimeout` | number | — | Max execution timeout (ms) |
| `hooks.postInstall` | string | — | Script to run after installation |
| `hooks.preLoad` | string | — | Script to run before loading |
| `hooks.healthCheck` | string | — | Script for health checks |

### Tool Definition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Unique name within the skill |
| `description` | string | ✅ | What the tool does (shown to the agent) |
| `inputSchema` | object | ✅ | JSON Schema for input parameters |
| `handler` | string | ✅ | Path to handler script (relative to skill dir) |
| `timeout` | number | — | Execution timeout in milliseconds |

## SKILL.md Best Practices

`SKILL.md` is the primary document the agent reads to understand your skill. Write it for an AI agent, not a human developer.

**Structure:**

```markdown
# My Skill

One-sentence description of what this skill does.

## When to Use

- Bullet list of scenarios where this skill applies
- Be specific — "when the user asks about weather" not "for data retrieval"

## When NOT to Use

- Scenarios where another approach is better

## Tools

### my_tool

Description of what it does and when to call it.

**Parameters:**
- `query` (required) — what to search for
- `limit` (optional, default 10) — max results

**Example:**
\```json
{ "query": "San Francisco", "limit": 5 }
\```

## Notes

- Any gotchas, rate limits, or quirks
- Authentication requirements
```

**Tips:**

- Be explicit about when to use and when not to use the skill
- Include concrete parameter examples
- Document error cases the agent should handle
- Keep it under 500 lines — agents have limited context

## Writing Tool Handlers

Tool handlers are scripts that receive JSON on stdin and return JSON on stdout. They can be written in TypeScript (executed via `tsx`) or any language that reads stdin and writes stdout.

### TypeScript Handler

```typescript
#!/usr/bin/env tsx
// scripts/handler.ts

import { readFileSync } from 'node:fs';

// Read JSON params from stdin
const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));

interface Params {
  query: string;
  limit?: number;
}

const params = input as Params;

// Do the work
async function run() {
  const response = await fetch(
    `https://api.example.com/search?q=${encodeURIComponent(params.query)}&limit=${params.limit ?? 10}`,
    {
      headers: { Authorization: `Bearer ${process.env.MY_API_KEY}` },
    }
  );

  if (!response.ok) {
    // Return error as JSON
    console.log(JSON.stringify({
      error: true,
      message: `API returned ${response.status}: ${response.statusText}`,
    }));
    process.exit(0); // exit 0 — error is in the JSON payload
  }

  const data = await response.json();

  // Return result as JSON
  console.log(JSON.stringify({
    results: data.items,
    count: data.items.length,
    query: params.query,
  }));
}

run().catch((err) => {
  console.log(JSON.stringify({ error: true, message: err.message }));
  process.exit(0);
});
```

### Protocol

1. **Input**: JSON object on stdin matching the tool's `inputSchema`
2. **Output**: JSON object on stdout
3. **Exit code**: Always `0` for handled responses (even errors). Non-zero exit codes are treated as crashes.
4. **Stderr**: Logged but not returned to the agent. Use for debug output.
5. **Timeout**: If the handler exceeds `timeout` (or the global `workerTimeout`), it is killed.

### Error Convention

Return errors as JSON rather than crashing:

```json
{ "error": true, "message": "Human-readable error description" }
```

This lets the agent decide how to handle the error — retry, try a different approach, or report to the user.

## Testing Your Skill

### Validate the manifest

```bash
orionomega skill list
# Your skill should appear. If not, check for validation errors:
orionomega skill list --verbose
```

### Test a tool handler directly

```bash
echo '{"query": "test"}' | tsx scripts/handler.ts
```

### Test with a live agent

1. Start the gateway: `orionomega gateway start`
2. Launch the TUI: `orionomega`
3. Send a message that matches your skill's triggers
4. Verify the agent discovers and uses your skill's tools

### Health check

If your skill defines a `hooks.healthCheck` script:

```bash
orionomega doctor
# Runs all skill health checks
```

## Example: Building a Weather Skill

Let's build a complete skill that fetches weather data from Open-Meteo (no API key required).

### 1. Scaffold

```bash
orionomega skill create weather
cd ~/.orionomega/skills/weather
```

### 2. manifest.json

```json
{
  "name": "weather",
  "version": "1.0.0",
  "description": "Get current weather and forecasts for any location",
  "author": "Your Name",
  "license": "MIT",

  "orionomega": ">=0.1.0",

  "requires": {
    "commands": []
  },

  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather conditions and forecast for a location by latitude/longitude",
      "inputSchema": {
        "type": "object",
        "properties": {
          "latitude": { "type": "number", "description": "Location latitude" },
          "longitude": { "type": "number", "description": "Location longitude" },
          "days": { "type": "number", "description": "Forecast days (1-7)", "default": 3 }
        },
        "required": ["latitude", "longitude"]
      },
      "handler": "scripts/get-weather.ts",
      "timeout": 15000
    }
  ],

  "triggers": {
    "keywords": ["weather", "temperature", "forecast"],
    "commands": ["/weather"]
  },

  "workerProfile": {
    "model": "claude-haiku-4-20250514",
    "tools": ["get_weather"]
  }
}
```

### 3. SKILL.md

```markdown
# Weather

Get current weather and forecasts using Open-Meteo.

## When to Use

- User asks about current weather conditions
- User asks for a weather forecast
- User asks about temperature for a location

## When NOT to Use

- Historical weather data (Open-Meteo free tier is current + 7-day forecast)
- Severe weather alerts

## Tools

### get_weather

Fetches current conditions and forecast for a lat/lon coordinate.

**Parameters:**
- `latitude` (required) — decimal latitude
- `longitude` (required) — decimal longitude  
- `days` (optional, default 3) — forecast days, 1–7

**Returns:** Current temperature, conditions, humidity, wind, and daily forecast.

## Notes

- No API key required
- Coordinates must be decimal degrees (e.g., 41.8781 for Chicago)
- Use a geocoding tool or your knowledge to convert city names to coordinates
```

### 4. scripts/get-weather.ts

```typescript
#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));

const { latitude, longitude, days = 3 } = input as {
  latitude: number;
  longitude: number;
  days?: number;
};

async function run() {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weather_code');
  url.searchParams.set('forecast_days', String(Math.min(days, 7)));
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');

  const res = await fetch(url.toString());
  if (!res.ok) {
    console.log(JSON.stringify({ error: true, message: `Open-Meteo returned ${res.status}` }));
    return;
  }

  const data = await res.json();
  console.log(JSON.stringify({
    latitude: data.latitude,
    longitude: data.longitude,
    current: data.current,
    daily: data.daily,
    units: data.current_units,
  }));
}

run().catch((err) => {
  console.log(JSON.stringify({ error: true, message: err.message }));
});
```

### 5. Test It

```bash
# Test the handler directly
echo '{"latitude": 41.8781, "longitude": -87.6298}' | tsx scripts/get-weather.ts

# Verify it loads
orionomega skill list

# Try it live
orionomega
# > What's the weather in Chicago?
```

That's it — you've built a complete skill. The agent will automatically discover it via keyword triggers and use the `get_weather` tool when weather questions come up.

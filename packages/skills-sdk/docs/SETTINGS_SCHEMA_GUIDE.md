# Settings Schema Guide

Complete reference for defining the `setup` block in a skill's `manifest.json`.
The setup block controls how users configure a skill before it can be used.

---

## Overview

The `setup` object tells the system:
- Whether configuration is required before the skill activates
- What authentication methods are available
- What additional user preferences to collect
- How to validate that the configuration works

```json
{
  "setup": {
    "required": true,
    "description": "Human-readable explanation of what setup accomplishes.",
    "auth": { "methods": [ ... ] },
    "fields": [ ... ],
    "handler": "hooks/setup.js"
  }
}
```

**All sub-fields are optional except `required`.**

---

## `setup.required`

| Value | Behavior |
|-------|----------|
| `true` | Skill will not activate until setup is complete (`config.configured = true`) |
| `false` | Skill is always considered configured; no setup needed |
| *(omitted)* | Same as `false` |

Skills without credentials or preferences should omit `setup` entirely.

---

## `setup.description`

A sentence or two explaining what setup does and why it is needed.
Shown to users in the setup wizard.

```json
{
  "setup": {
    "required": true,
    "description": "Authenticate with Linear to manage issues, projects, and teams. You'll need a Personal API Key from linear.app/settings."
  }
}
```

---

## `setup.auth`

Defines available authentication methods. The user picks exactly one.

```json
{
  "setup": {
    "required": true,
    "auth": {
      "methods": [ ... ]
    }
  }
}
```

### Auth method fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Auth strategy (see types below) |
| `label` | string | Yes | Display name shown to user |
| `description` | string | No | One-sentence explanation |
| `command` | string | No | CLI command to run for oauth/login |
| `tokenUrl` | string | No | URL where user generates a token |
| `scopes` | string[] | No | Required OAuth scopes (informational) |
| `envVar` | string | No | Environment variable name for the credential |
| `validateCommand` | string | No | Shell command to verify auth. Exit 0 = valid. |

### Auth types

#### `"oauth"` — OAuth via CLI device flow

Use when the service supports OAuth and there is a CLI tool that manages the auth flow.

```json
{
  "type": "oauth",
  "label": "GitHub OAuth (recommended)",
  "description": "Sign in via GitHub device flow — works over SSH without browser auto-open",
  "command": "gh auth login --web --git-protocol https",
  "validateCommand": "gh auth status"
}
```

- `command` is run to initiate auth (user executes it in their terminal)
- `validateCommand` is run to verify auth is still valid
- The CLI tool manages credential storage (no `envVar` needed)

#### `"pat"` — Personal access token

Use when the service provides personal access tokens from a web dashboard.

```json
{
  "type": "pat",
  "label": "Personal Access Token",
  "description": "Create a token at github.com/settings/tokens",
  "tokenUrl": "https://github.com/settings/tokens/new?scopes=repo,workflow",
  "scopes": ["repo", "workflow", "read:org"],
  "envVar": "GH_TOKEN",
  "validateCommand": "node -e \"fetch('https://api.github.com/user',{headers:{Authorization:'token '+process.env.GH_TOKEN}}).then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))\""
}
```

- `tokenUrl` opens the page where the user creates the token
- `scopes` lists required permissions (shown to user, not enforced by SDK)
- `envVar` is the environment variable name where the token will be stored
- `validateCommand` shell-tests that the token is valid

#### `"api-key"` — API key from a developer portal

Like `pat` but semantically for API keys (not OAuth-scoped tokens).

```json
{
  "type": "api-key",
  "label": "Personal API Key (recommended)",
  "description": "Create a key at linear.app/settings → Security & access → Personal API keys",
  "tokenUrl": "https://linear.app/settings/account/security",
  "envVar": "LINEAR_API_KEY",
  "validateCommand": "node -e \"fetch('https://api.linear.app/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:process.env.LINEAR_API_KEY},body:JSON.stringify({query:'{viewer{name}}'})}).then(r=>r.json()).then(d=>d.data?.viewer?process.exit(0):process.exit(1)).catch(()=>process.exit(1))\""
}
```

#### `"login"` — Interactive CLI login

Use when the CLI tool has an interactive login that doesn't fit the oauth device flow.

```json
{
  "type": "login",
  "label": "Interactive Login",
  "description": "Full interactive login — choose SSH or HTTPS, browser or token",
  "command": "gh auth login",
  "validateCommand": "gh auth status"
}
```

#### `"ssh-key"` — SSH key authentication

For services that authenticate via SSH key pairs.

```json
{
  "type": "ssh-key",
  "label": "SSH Key",
  "description": "Authenticate using your SSH key pair",
  "envVar": "SSH_KEY_PATH"
}
```

#### `"env"` — Use existing environment variable

For CI/CD environments where credentials are already injected.

```json
{
  "type": "env",
  "label": "Use GITHUB_TOKEN environment variable",
  "description": "For CI/CD or environments where the token is already set",
  "envVar": "GITHUB_TOKEN",
  "validateCommand": "node -e \"fetch('https://api.github.com/user',{headers:{Authorization:'token '+process.env.GITHUB_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
}
```

---

## `setup.fields`

An array of additional configuration values to collect from the user.
Used for preferences, defaults, and non-auth settings.

### Field structure

```json
{
  "name": "field_key",
  "type": "string",
  "label": "Human-readable label",
  "description": "Help text shown below the input",
  "required": false,
  "default": "default-value"
}
```

### Field types

#### `"string"` — Text input

```json
{
  "name": "default_owner",
  "type": "string",
  "label": "Default repository owner",
  "description": "Your GitHub username or org — used when --repo is omitted",
  "required": false,
  "default": ""
}
```

For secret/sensitive string values, add `"mask": true`:

```json
{
  "name": "webhook_secret",
  "type": "string",
  "label": "Webhook secret",
  "description": "HMAC secret for verifying webhook payloads",
  "required": false,
  "mask": true
}
```

#### `"number"` — Numeric input

```json
{
  "name": "max_results",
  "type": "number",
  "label": "Default result limit",
  "description": "Maximum number of results to return per query (1–100)",
  "required": false,
  "default": 25
}
```

#### `"boolean"` — Toggle / checkbox

```json
{
  "name": "include_drafts",
  "type": "boolean",
  "label": "Include draft PRs",
  "description": "Show draft pull requests in list results",
  "required": false,
  "default": false
}
```

#### `"select"` — Dropdown with options

```json
{
  "name": "region",
  "type": "select",
  "label": "API region",
  "description": "Choose the region closest to your location",
  "required": false,
  "default": "us-east",
  "options": [
    { "label": "US East (Virginia)", "value": "us-east" },
    { "label": "US West (Oregon)", "value": "us-west" },
    { "label": "EU (Frankfurt)", "value": "eu-central" },
    { "label": "Asia Pacific (Singapore)", "value": "ap-southeast" }
  ]
}
```

#### `"password"` — Masked credential input

Use for API keys, tokens, and any secret that must be redacted in logs and API responses. The UI renders a password `<input>` and the value is stored encrypted at rest. Handlers receive the value via environment variable, never in stdin.

```json
{
  "name": "api_key",
  "type": "password",
  "label": "API Key",
  "description": "Your secret API key — never shared or logged",
  "required": true,
  "group": "auth"
}
```

#### `"url"` — URL input

For endpoint overrides and webhook URLs. The UI renders a text input with URL format validation.

```json
{
  "name": "base_url",
  "type": "url",
  "label": "API base URL",
  "description": "Override the default API endpoint (e.g. for self-hosted instances)",
  "required": false,
  "default": "https://api.example.com"
}
```

#### `"textarea"` — Multi-line text

For longer values such as PEM certificates, SSH keys, or multi-line configuration snippets.

```json
{
  "name": "pem_cert",
  "type": "textarea",
  "label": "PEM certificate",
  "description": "Paste the full PEM-encoded certificate block",
  "required": false
}
```

#### `"multiselect"` — Multi-option select

Returns an array of strings. Use when the user may need to choose several values from a fixed list.

```json
{
  "name": "enabled_labels",
  "type": "multiselect",
  "label": "Default labels",
  "description": "Labels automatically applied when creating issues",
  "required": false,
  "options": [
    { "label": "Bug", "value": "bug" },
    { "label": "Feature", "value": "feature" },
    { "label": "Documentation", "value": "docs" }
  ]
}
```

### Field naming rules

| Rule | Example |
|------|---------|
| `name` must be `snake_case` | `default_team`, `api_region` |
| `name` becomes the key in `config.json` under `fields` | `fields.default_team` |
| `name` determines the env var injected into handlers | `SKILL_LINEAR_DEFAULT_TEAM` |

---

## Environment variable delivery

Field values are delivered to handler scripts as environment variables.

**Naming formula:**

```
SKILL_{SKILLNAME}_{FIELDNAME}

SKILLNAME = manifest.name.toUpperCase().replace(/-/g, '_')
FIELDNAME = field.name.toUpperCase().replace(/-/g, '_')
```

**Examples:**

| Skill name | Field name | Environment variable |
|-----------|------------|----------------------|
| `github` | `default_owner` | `SKILL_GITHUB_DEFAULT_OWNER` |
| `linear` | `default_team` | `SKILL_LINEAR_DEFAULT_TEAM` |
| `my-api` | `api_key` | `SKILL_MY_API_API_KEY` |
| `web-fetch` | `max_size_kb` | `SKILL_WEB_FETCH_MAX_SIZE_KB` |

**Reading in handlers:**

```js
// Node.js
const defaultTeam = process.env.SKILL_LINEAR_DEFAULT_TEAM || '';
const maxResults = parseInt(process.env.SKILL_MYSKILL_MAX_RESULTS || '25', 10);
const includeDrafts = process.env.SKILL_MYSKILL_INCLUDE_DRAFTS === 'true';
```

```bash
# Bash
DEFAULT_TEAM="${SKILL_LINEAR_DEFAULT_TEAM:-}"
MAX_RESULTS="${SKILL_MYSKILL_MAX_RESULTS:-25}"
```

**Important:** Boolean fields are delivered as the string `"true"` or `"false"`.
Always compare with `=== 'true'` in JavaScript or `[ "$VAR" = "true" ]` in Bash.

---

## `setup.handler`

Optional path to a post-setup validation script. Runs after the user completes setup
to perform custom validation or initialization.

```json
{
  "setup": {
    "required": true,
    "handler": "hooks/setup.js"
  }
}
```

The handler receives no stdin input. Exit 0 = setup succeeded. Non-zero = setup failed.

---

## Configuration storage

When setup is complete, values are stored at:

```
~/.orionomega/skills/{skill-name}/config.json
```

```json
{
  "name": "linear",
  "enabled": true,
  "configured": true,
  "authMethod": "api-key",
  "configuredAt": "2025-03-15T10:00:00.000Z",
  "fields": {
    "default_team": "ENG"
  }
}
```

The `fields` object maps field `name` values to the values entered by the user.

---

## Health check integration

When auth is required, always include a `healthCheck` hook so users can verify
their configuration is working:

```json
{
  "hooks": {
    "healthCheck": "hooks/health.js"
  }
}
```

The health check script writes a JSON object to stdout:

**Healthy:**
```json
{ "healthy": true, "message": "Connected as user@example.com" }
```

**Unhealthy:**
```json
{ "healthy": false, "message": "API key is invalid or expired. Re-run setup." }
```

The health check always exits 0 — only the stdout JSON is read.

---

## Complete examples

### Example 1 — Public API skill (no auth)

```json
{
  "name": "weather",
  "version": "0.1.0",
  "description": "Get weather data from Open-Meteo. No API key required.",
  "author": "OrionOmega",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": { "commands": [], "skills": [], "env": [] },
  "triggers": {
    "keywords": ["weather", "temperature", "forecast"],
    "commands": ["/weather"]
  },
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current temperature and conditions for a location.",
      "handler": "handlers/get_weather.js",
      "timeout": 15000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "City name or lat,lon" }
        },
        "required": ["location"]
      }
    }
  ]
}
```

No `setup` block — skill is always ready.

---

### Example 2 — API key with optional preferences

```json
{
  "name": "linear",
  "version": "1.0.0",
  "description": "Manage Linear issues, projects, and teams.",
  "author": "OrionOmega",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": { "commands": [], "skills": [], "env": [] },
  "setup": {
    "required": true,
    "description": "Authenticate with Linear to manage issues, projects, teams, and more.",
    "auth": {
      "methods": [
        {
          "type": "api-key",
          "label": "Personal API Key (recommended)",
          "description": "Create a key at linear.app/settings → Security & access → Personal API keys",
          "tokenUrl": "https://linear.app/settings/account/security",
          "envVar": "LINEAR_API_KEY",
          "validateCommand": "node -e \"fetch('https://api.linear.app/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:process.env.LINEAR_API_KEY},body:JSON.stringify({query:'{viewer{name}}'})}).then(r=>r.json()).then(d=>d.data?.viewer?process.exit(0):process.exit(1)).catch(()=>process.exit(1))\""
        },
        {
          "type": "oauth",
          "label": "OAuth 2.0",
          "description": "For applications — requires OAuth app registration",
          "tokenUrl": "https://linear.app/settings/api"
        }
      ]
    },
    "fields": [
      {
        "name": "default_team",
        "type": "string",
        "label": "Default team key",
        "description": "Team key used when team is omitted (e.g. 'ENG')",
        "required": false
      }
    ],
    "handler": "hooks/setup.js"
  },
  "triggers": {
    "keywords": ["linear", "issue", "ticket", "project"],
    "commands": ["/linear"]
  },
  "tools": [ ... ],
  "hooks": {
    "healthCheck": "hooks/health.js",
    "postInstall": "hooks/setup.js"
  }
}
```

---

### Example 3 — OAuth via CLI with multiple auth options

```json
{
  "name": "github",
  "version": "1.0.0",
  "description": "Full-featured GitHub integration via the gh CLI.",
  "author": "OrionOmega",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": {
    "commands": ["gh", "git"],
    "skills": [],
    "env": []
  },
  "setup": {
    "required": true,
    "description": "Authenticate with GitHub to manage repos, issues, PRs, workflows, and more.",
    "auth": {
      "methods": [
        {
          "type": "oauth",
          "label": "GitHub OAuth (recommended)",
          "description": "Sign in via GitHub device flow — works over SSH, no browser auto-open",
          "command": "gh auth login --web --git-protocol https",
          "validateCommand": "gh auth status"
        },
        {
          "type": "pat",
          "label": "Personal Access Token",
          "description": "Paste a token from github.com/settings/tokens",
          "tokenUrl": "https://github.com/settings/tokens/new?scopes=repo,workflow,read:org,read:user",
          "scopes": ["repo", "workflow", "read:org", "read:user"],
          "envVar": "GH_TOKEN",
          "validateCommand": "gh auth status"
        },
        {
          "type": "login",
          "label": "Interactive gh CLI Login",
          "description": "Full interactive login — choose SSH or HTTPS, browser or token",
          "command": "gh auth login",
          "validateCommand": "gh auth status"
        }
      ]
    },
    "fields": [
      {
        "name": "default_owner",
        "type": "string",
        "label": "Default repository owner",
        "description": "Your GitHub username or org — used when --repo is omitted",
        "required": false
      }
    ],
    "handler": "hooks/setup.js"
  },
  "triggers": {
    "keywords": ["github", "pull request", "PR", "issue", "repository"],
    "patterns": ["\\bgithub\\b", "\\bgh\\s+\\w+\\b"],
    "commands": ["/gh"]
  },
  "tools": [ ... ],
  "hooks": {
    "healthCheck": "hooks/health.js",
    "postInstall": "hooks/setup.js"
  }
}
```

---

## Field grouping guidance

When designing fields, group them by purpose:

| Purpose | Recommendation |
|---------|----------------|
| **Primary auth credential** | Use `setup.auth.methods[]` with `envVar` |
| **Defaults / preferences** | Use `setup.fields[]` |
| **Feature flags** | Use boolean `setup.fields[]` |
| **Multiple region/instance** | Use select `setup.fields[]` |
| **Secret that isn't the main key** | Use string field with `mask: true` |

Keep fields minimal. Each required field is friction for the user. Make fields optional
with sensible defaults whenever possible.

---

## Validation rules for auth methods

| Rule | Applies to |
|------|-----------|
| `envVar` is required | `pat`, `api-key`, `env` types |
| `command` is required | `oauth`, `login` types |
| `validateCommand` should always be present | All types (required to verify auth) |
| `tokenUrl` is strongly recommended | `pat`, `api-key` types |
| `scopes` is informational only | `oauth`, `pat` types |

---

## Testing setup configuration

Test `validateCommand` scripts directly:

```bash
# For api-key type: set the env var manually then run validateCommand
LINEAR_API_KEY="lin_api_test_key_here" node -e "..."

# For oauth type: verify the CLI is authenticated
gh auth status
```

Test field env var delivery by checking what the loader sets:

```bash
# Expected env var for skill "linear", field "default_team"
echo $SKILL_LINEAR_DEFAULT_TEAM
```

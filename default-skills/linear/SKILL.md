# Linear Skill

Full-featured Linear integration for OrionOmega via the GraphQL API. Manage issues, projects, teams, cycles, users, and raw GraphQL queries. Zero external dependencies — uses `fetch` directly.

## Prerequisites

- Linear personal API key ([create one here](https://linear.app/settings/account/security))
- No CLI tools required — communicates directly with the Linear GraphQL API

## Setup

```
orionomega skill setup linear
```

Choose "Personal API Key", paste your key. The setup handler validates it against the API and returns your workspace info.

## Tools

### linear_issue
Manage issues: list, view, create, update, close, reopen, comment, assign, label, search, archive.

**Filtering (list action):** team, state, stateType, priority, assignee (@me supported), project, cycle, label.

**Priority values:** 0=none, 1=urgent 🔴, 2=high 🟠, 3=medium 🟡, 4=low 🔵

### linear_project
Manage projects: list, view, create, update, archive. View progress, members, and issue breakdown.

**Project states:** planned, started, paused, completed, canceled.

### linear_team
View teams: list, view (full detail), members, workflow states, labels, cycles.

Teams are the organizational unit in Linear — issues belong to teams. Use `linear_team states` to discover workflow state IDs for issue creation/updates.

### linear_user
User operations: me (current user + assigned issues), list all users, view assigned issues.

### linear_graphql
Raw GraphQL escape hatch. Execute any query or mutation against the Linear API.

## Usage Examples

```
# View my assigned issues
linear_user { "action": "me" }

# List urgent issues in the ENG team
linear_issue { "action": "list", "team": "ENG", "priority": 1 }

# Create a bug report
linear_issue { "action": "create", "team": "ENG", "title": "Login page crashes on Safari", "priority": 2, "description": "## Steps to reproduce\n1. Open login page in Safari 17\n2. Click 'Sign in'\n3. Page crashes" }

# Search issues
linear_issue { "action": "search", "query": "authentication timeout" }

# View a specific issue
linear_issue { "action": "view", "id": "ENG-123" }

# Close an issue
linear_issue { "action": "close", "id": "ENG-123" }

# Comment on an issue
linear_issue { "action": "comment", "id": "ENG-123", "body": "Fixed in PR #42" }

# List active projects
linear_project { "action": "list", "state": "started" }

# View team workflow states (needed for stateId in create/update)
linear_team { "action": "states", "id": "ENG" }

# View current cycle
linear_team { "action": "cycles", "id": "ENG", "limit": 1 }

# Raw GraphQL query
linear_graphql { "query": "{ organization { name urlKey subscription { type } } }" }
```

## Architecture

- **Zero dependencies**: Handlers use native `fetch` (Node.js 18+) to call `https://api.linear.app/graphql`
- **API key from skill config**: Reads from `~/.orionomega/skills/linear/config.json` field `LINEAR_API_KEY`, falls back to `LINEAR_API_KEY` env var
- **Smart resolution**: Team keys (e.g. "ENG") auto-resolve to UUIDs. Close/reopen auto-discover the correct workflow state. `@me` filter resolves to current user.
- **Structured output**: Every response is formatted for readability AND downstream orchestration consumption

## Orchestration Patterns

**Sprint planning workflow:**
1. `linear_team { "action": "cycles", "id": "ENG" }` → get current cycle
2. `linear_issue { "action": "list", "stateType": "backlog" }` → find backlog items
3. For each: `linear_issue { "action": "update", "id": "...", "cycleId": "..." }` → add to cycle

**Bug triage workflow:**
1. `linear_issue { "action": "list", "stateType": "triage" }` → find triage items
2. For each: classify priority, then `linear_issue { "action": "update", "priority": N, "stateId": "..." }`
3. Assign: `linear_issue { "action": "assign", "id": "...", "assigneeId": "..." }`

**Project status report:**
1. `linear_project { "action": "view", "id": "..." }` → get progress + issue breakdown
2. `linear_issue { "action": "list", "projectId": "...", "stateType": "started" }` → in-progress items
3. Synthesize into report

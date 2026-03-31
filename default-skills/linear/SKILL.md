# Linear

Full-featured Linear integration via the GraphQL API. Manage issues, projects, teams, cycles, users, and execute raw GraphQL queries. Zero external dependencies — uses native `fetch`.

## When to Use

- Managing Linear issues (create, update, close, assign, search, comment)
- Viewing or managing Linear projects and their progress
- Listing teams, workflow states, labels, and cycles
- Looking up users or viewing assigned work
- Running custom GraphQL queries against the Linear API

## When NOT to Use

- GitHub Issues or other issue trackers — use their respective skills
- Jira, Asana, or other project management tools
- Linear webhook configuration or OAuth app management — use the Linear admin UI

## Tools

All tools return `{ "result": "..." }` on success (human-readable formatted text) or `{ "error": "..." }` on failure.

### `linear_issue`

Manage Linear issues: list, view, create, update, close, reopen, comment, assign, label, search, archive.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `list`, `view`, `create`, `update`, `close`, `reopen`, `comment`, `assign`, `label`, `search`, `archive` |
| `id` | string | no | Issue identifier (e.g. `ENG-123` or UUID) |
| `title` | string | no | Issue title (for `create`, `update`) |
| `description` | string | no | Issue description in markdown (for `create`, `update`) |
| `team` | string | no | Team key (e.g. `ENG`) — resolved to teamId automatically |
| `teamId` | string | no | Team UUID (alternative to team key) |
| `priority` | number | no | Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low |
| `stateId` | string | no | Workflow state UUID |
| `state` | string | no | Filter by state name (for `list`) |
| `stateType` | string | no | Filter by state type: `triage`, `backlog`, `unstarted`, `started`, `completed`, `cancelled` |
| `assigneeId` | string | no | User UUID to assign |
| `assignee` | string | no | Special: `@me` for current user (for `list` filter) |
| `projectId` | string | no | Project UUID |
| `cycleId` | string | no | Cycle UUID |
| `parentId` | string | no | Parent issue UUID (for sub-issues) |
| `labelIds` | string[] | no | Label UUIDs to apply |
| `label` | string | no | Filter by label name (for `list`) |
| `estimate` | number | no | Point estimate |
| `dueDate` | string | no | Due date (ISO 8601) |
| `body` | string | no | Comment body in markdown (for `comment` action) |
| `query` | string | no | Search query text (for `search` action) |
| `limit` | number | no | Max results (default 25) |

**Returns:** `{ "result": "..." }` — for `view`, includes identifier, title, state, priority, assignee, team, labels, description, and URL. For `list`, includes a formatted list with identifier, title, state, priority, and assignee. For `create`, confirms the issue was created with identifier and URL.

**Examples:**

- `{ "action": "list", "team": "ENG", "priority": 1 }` — list urgent ENG issues
- `{ "action": "create", "team": "ENG", "title": "Bug: ...", "priority": 2 }` — create a high-priority issue
- `{ "action": "search", "query": "authentication timeout" }` — search issues

---

### `linear_project`

Manage Linear projects: list, view, create, update, archive. View progress, members, and issue breakdown.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `list`, `view`, `create`, `update`, `archive` |
| `id` | string | no | Project UUID |
| `name` | string | no | Project name (for `create`, `update`) |
| `description` | string | no | Project description in markdown |
| `state` | string | no | Project state: `planned`, `started`, `paused`, `completed`, `canceled` |
| `teamIds` | string[] | no | Team UUIDs (for `create`) |
| `leadId` | string | no | Lead user UUID |
| `startDate` | string | no | Start date (YYYY-MM-DD) |
| `targetDate` | string | no | Target completion date (YYYY-MM-DD) |
| `color` | string | no | Project color (hex) |
| `limit` | number | no | Max results (default 20) |

**Returns:** `{ "result": "..." }` — for `view`, includes name, state, progress percentage, lead, dates, and issue breakdown. For `list`, includes a formatted list with name, state, and progress.

**Examples:**

- `{ "action": "list", "state": "started" }` — list active projects
- `{ "action": "view", "id": "uuid" }` — view project details and progress

---

### `linear_team`

View Linear teams, members, workflow states, labels, and cycles.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `list`, `view`, `members`, `states`, `labels`, `cycles` |
| `id` | string | no | Team key (e.g. `ENG`) or UUID |
| `limit` | number | no | Max results for cycles (default 5) |

**Returns:** `{ "result": "..." }` — for `states`, includes workflow state names, types, and IDs. For `members`, includes user names and roles. For `cycles`, includes cycle name, number, start/end dates, and progress.

**Examples:**

- `{ "action": "list" }` — list all teams
- `{ "action": "states", "id": "ENG" }` — get workflow states for a team
- `{ "action": "cycles", "id": "ENG", "limit": 1 }` — view the current cycle

---

### `linear_user`

View Linear users: current user, list all users, view assigned issues.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `me`, `list`, `assigned` |
| `userId` | string | no | User UUID (for `assigned`; omit for current user) |
| `limit` | number | no | Max results (default 20) |

**Returns:** `{ "result": "..." }` — for `me`, includes user name, email, and assigned issues. For `list`, includes all workspace users. For `assigned`, includes issues assigned to the specified user.

**Examples:**

- `{ "action": "me" }` — view current user and assigned issues
- `{ "action": "list" }` — list all workspace users

---

### `linear_graphql`

Execute raw GraphQL queries and mutations against the Linear API. Use for anything not covered by other tools.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | GraphQL query or mutation string |
| `variables` | object | no | GraphQL variables |

**Returns:** `{ "result": "..." }` — the raw GraphQL response data as formatted JSON text.

**Examples:**

- `{ "query": "{ viewer { name email } }" }` — get current user info
- `{ "query": "{ organization { name urlKey } }" }` — get workspace info

## Notes

- Requires a Linear personal API key (create at linear.app/settings → Security & access)
- Team keys (e.g. `ENG`) are automatically resolved to UUIDs
- Close/reopen actions auto-discover the correct workflow state
- The `@me` assignee filter resolves to the current authenticated user
- All tools return `{ "result": "..." }` with human-readable formatted text or `{ "error": "..." }` on failure

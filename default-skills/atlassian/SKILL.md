# Atlassian

Full-featured Atlassian Cloud integration via the official [Rovo MCP Server](https://www.atlassian.com/platform/remote-mcp-server). Manage Jira issues, Confluence pages, Compass components, JSM alerts, Bitbucket repositories, and perform cross-product search — all through a unified interface.

## When to Use

- Creating, viewing, updating, transitioning, or searching Jira issues
- Managing Confluence pages: create, edit, search, comment
- Searching across Jira and Confluence using natural language (Rovo)
- Managing Compass components and service dependencies
- Monitoring JSM Ops alerts, on-call schedules, and teams
- Working with Bitbucket Cloud repos, pull requests, pipelines, and deployments
- Looking up connected context across Atlassian products (Teamwork Graph)

## When NOT to Use

- GitHub operations — use the `github` skill instead
- Atlassian Server/Data Center (on-premise) — this skill targets Atlassian Cloud only
- Direct REST API calls to Atlassian — use `atlassian_search` with `fetch` for ARI-based lookups

## Prerequisites

1. An Atlassian Cloud site with Jira, Confluence, Compass, JSM, or Bitbucket
2. Authentication configured in Settings → Skills → Atlassian:
   - **OAuth 2.1** (recommended): Supports all tools including Compass. Requires browser consent flow.
   - **Personal API Token** (Basic auth): For headless/unattended access. Some tools may be unavailable.
   - **Service Account API Key** (Bearer token): For CI/CD and automation scenarios.
3. Enable the products you want to use (Jira, Confluence, Compass, JSM, Bitbucket, Search)

## Tools

All tools return `{ "result": "..." }` on success or `{ "error": "..." }` on failure.

---

### `atlassian_jira`

Manage Jira issues: get, create, edit, transition, comment, search via JQL, list projects and issue types.

**Actions:** `get_issue`, `create_issue`, `edit_issue`, `transition_issue`, `add_comment`, `add_worklog`, `search_jql`, `list_projects`, `get_issue_types`, `get_transitions`, `get_link_types`, `get_remote_links`, `lookup_user`, `get_field_metadata`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `issue_key` | string | for issue ops | Jira issue key (e.g. `PROJ-123`) |
| `project_key` | string | for create | Jira project key (e.g. `PROJ`) |
| `issue_type` | string | for create | Issue type: `Story`, `Bug`, `Task`, `Epic` |
| `summary` | string | for create/edit | Issue title |
| `description` | string | no | Issue description |
| `fields` | object | no | Additional fields to set (field IDs or names) |
| `transition_id` | string | for transition | Workflow transition ID |
| `comment` | string | for comment | Comment body text |
| `time_spent` | string | for worklog | Time spent (e.g. `2h 30m`) |
| `jql` | string | for search | JQL query string |
| `query` | string | for lookup | User name or email |
| `max_results` | number | no | Max results (default 10) |
| `cloud_id` | string | no | Atlassian Cloud site ID (uses default if omitted) |

**Examples:**
- `{ "action": "get_issue", "issue_key": "PROJ-123" }` — get issue details
- `{ "action": "create_issue", "project_key": "PROJ", "issue_type": "Bug", "summary": "Login button broken" }` — create a bug
- `{ "action": "search_jql", "jql": "project = PROJ AND status = 'In Progress' ORDER BY updated DESC", "max_results": 5 }` — search issues
- `{ "action": "transition_issue", "issue_key": "PROJ-123", "transition_id": "31" }` — transition issue
- `{ "action": "add_comment", "issue_key": "PROJ-123", "comment": "Fixed in latest deploy." }` — add a comment
- `{ "action": "get_transitions", "issue_key": "PROJ-123" }` — list available transitions (to find transition IDs)

---

### `atlassian_confluence`

Manage Confluence pages and spaces: get, create, update pages, list spaces, search via CQL, manage comments.

**Actions:** `get_page`, `create_page`, `update_page`, `get_descendants`, `list_spaces`, `list_pages_in_space`, `search_cql`, `get_footer_comments`, `get_inline_comments`, `get_comment_children`, `create_footer_comment`, `create_inline_comment`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `page_id` | string | for page ops | Confluence page ID |
| `space_key` | string | for create | Space key |
| `space_id` | string | for list | Space ID |
| `parent_page_id` | string | no | Parent page ID |
| `title` | string | for create/update | Page title |
| `body` | string | for create/update | Page content |
| `comment_text` | string | for comments | Comment text |
| `comment_id` | string | for replies | Parent comment ID |
| `cql` | string | for search | CQL query string |
| `max_results` | number | no | Max results (default 10) |

**Examples:**
- `{ "action": "get_page", "page_id": "12345678" }` — get page content
- `{ "action": "create_page", "space_key": "TEAM", "title": "Sprint Retro", "body": "<p>Notes from retro...</p>" }` — create page
- `{ "action": "search_cql", "cql": "type = page AND text ~ 'deployment guide'", "max_results": 5 }` — search pages
- `{ "action": "list_spaces" }` — list available Confluence spaces
- `{ "action": "create_footer_comment", "page_id": "12345678", "comment_text": "LGTM!" }` — add comment

---

### `atlassian_compass`

Manage Compass components: get, create, list, search, view activity, labels, types, relationships, and custom fields.

**Requires:** OAuth 2.1 authentication (not available with API tokens).

**Actions:** `get_component`, `list_components`, `create_component`, `get_activity`, `get_labels`, `get_types`, `get_custom_fields`, `get_my_team_components`, `create_relationship`, `create_custom_field`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `component_id` | string | for component ops | Component ID |
| `name` | string | for create | Component name |
| `type` | string | no | Component type |
| `query` | string | no | Search query |
| `source_id` | string | for relationship | Source component ID |
| `target_id` | string | for relationship | Target component ID |
| `relationship_type` | string | for relationship | Relationship type |

**Examples:**
- `{ "action": "list_components", "query": "api-gateway" }` — search components
- `{ "action": "get_component", "component_id": "abc-123" }` — get component details
- `{ "action": "get_my_team_components" }` — list my team's components

---

### `atlassian_jsm`

Manage Jira Service Management operations: get alerts, list on-call schedules, view teams, update alert status.

**Requires:** API token authentication (not available with OAuth).

**Actions:** `get_alert`, `search_alerts`, `get_schedule`, `list_schedules`, `get_team`, `list_teams`, `update_alert`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `alert_id` | string | for alert ops | Alert ID or alias |
| `query` | string | for search | Alert search query |
| `schedule_id` | string | for schedule | Schedule ID |
| `team_id` | string | for team | Team ID |
| `alert_action` | string | for update | `acknowledge`, `unacknowledge`, `close`, `escalate` |

**Examples:**
- `{ "action": "search_alerts", "query": "status=open" }` — find open alerts
- `{ "action": "update_alert", "alert_id": "abc-123", "alert_action": "acknowledge" }` — ack an alert

---

### `atlassian_bitbucket`

Manage Bitbucket Cloud repositories, pull requests, pipelines, and deployments.

**Requires:** API token authentication with Bitbucket scopes.

**Actions (read):** `list_workspaces`, `get_workspace`, `list_repos`, `get_repo`, `get_default_reviewers`, `my_pull_requests`, `list_pull_requests`, `get_pull_request`, `get_pr_diff`, `get_pr_comments`, `get_branch`, `get_commit`, `list_files`, `list_pipelines`, `get_pipeline`, `get_pipeline_steps`, `get_step_log`, `list_deployments`, `get_deployment`, `list_environments`

**Actions (write):** `create_pull_request`, `merge_pull_request`, `approve_pull_request`, `comment_on_pr`, `create_branch`, `create_commit`, `run_pipeline`, `create_environment`, `update_environment`, `delete_environment`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `workspace` | string | for most ops | Bitbucket workspace slug |
| `repo_slug` | string | for repo ops | Repository slug |
| `pr_id` | string | for PR ops | Pull request ID |
| `source_branch` | string | for create PR | Source branch name |
| `destination_branch` | string | no | Destination branch (default: main) |
| `title` | string | for create | PR or environment title |
| `comment` | string | for comment | Comment text |

**Examples:**
- `{ "action": "list_repos", "workspace": "myteam" }` — list repos in workspace
- `{ "action": "create_pull_request", "workspace": "myteam", "repo_slug": "api", "source_branch": "feature/auth", "title": "Add auth module" }` — create PR
- `{ "action": "my_pull_requests" }` — list my open PRs

---

### `atlassian_search`

Cross-product Atlassian search and Teamwork Graph queries.

**Actions:** `search`, `fetch`, `get_context`, `get_object`, `get_user_info`, `list_resources`

**Key Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | Action to perform |
| `query` | string | for search | Natural language search query (powered by Rovo) |
| `ari` | string | for fetch/object | Atlassian Resource Identifier |
| `aris` | string[] | for batch object | Multiple ARIs |
| `entity_ari` | string | for context | Entity ARI to get connected context for |
| `max_results` | number | no | Max results (default 10) |

**Examples:**
- `{ "action": "search", "query": "deployment runbook for payment service" }` — natural language search
- `{ "action": "fetch", "ari": "ari:cloud:jira:site-id:issue/12345" }` — fetch by ARI
- `{ "action": "get_context", "entity_ari": "ari:cloud:jira:site-id:issue/12345" }` — get connected context
- `{ "action": "get_user_info" }` — get current user details
- `{ "action": "list_resources" }` — list accessible Atlassian cloud sites

## Notes

- **Authentication**: OAuth 2.1 supports all tools. API token auth disables Compass and may limit some features.
- **Cloud ID**: Set a default in settings to avoid passing `cloud_id` on every call. Use `list_resources` to discover available sites.
- **Rate limits**: The Rovo MCP Server enforces rate limits. Use `max_results` to limit response sizes.
- **Teamwork Graph tools** (`get_context`, `get_object`) are in Beta and may be subject to future Rovo credit billing.
- **Products must be enabled** in skill settings before their tools will work.
- **Endpoint migration**: After June 30, 2026, only `https://mcp.atlassian.com/v1/mcp` is supported (SSE endpoint deprecated).
- All tools return `{ "result": "..." }` with formatted text or `{ "error": "..." }` on failure.

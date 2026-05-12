# Atlassian Skill

Full-featured Atlassian Cloud integration via the official Rovo MCP Server.
Manage Jira issues, Confluence pages, Compass components, JSM alerts,
Bitbucket repositories, and cross-product Rovo search — all from natural
language requests.

## Authentication

This skill supports two authentication methods, configured in **Settings → Skills → Atlassian**:

### OAuth 2.0 (3LO) — Recommended

Best for interactive use. Supports ALL Atlassian products including Compass.

**Setup steps:**
1. Go to [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/)
2. Create a new app (or select an existing one)
3. Under **Authorization**, click **Configure** next to **OAuth 2.0 (3LO)**
4. Set the **Callback URL** to `http://localhost:9876/callback` (or your custom URL)
5. Under **Permissions**, add the APIs you need (Jira, Confluence, etc.) and their scopes
6. Under **Settings**, copy the **Client ID** and **Client Secret**
7. In OrionOmega settings, enter:
   - **OAuth Client ID** — from step 6
   - **OAuth Client Secret** — from step 6
   - **OAuth Callback URL** — must match step 4 exactly
   - **OAuth Scopes** — space-separated list matching your app's permissions
8. Complete the authorization flow to get your access token

**Required scopes by product:**
- **Jira**: `read:jira-work write:jira-work read:jira-user manage:jira-project manage:jira-configuration`
- **Confluence**: `read:confluence-content.all write:confluence-content read:confluence-space.summary write:confluence-space`
- **Bitbucket**: `repository pullrequest`
- **Offline access**: `offline_access` (for refresh tokens)

### Personal API Token (Basic Auth)

Simpler setup for headless/unattended use. Some products (e.g. Compass) may be unavailable.

1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**, give it a label
3. In OrionOmega settings, enter:
   - **Atlassian Account Email** — your login email
   - **Personal API Token** — the token you just created

## When to use this skill

Use this skill whenever the user mentions or implies interaction with:
- **Jira** — issues, tickets, sprints, epics, stories, bugs, projects, JQL
- **Confluence** — pages, spaces, wiki, CQL search
- **Compass** — components, services, relationships
- **Jira Service Management** — alerts, on-call schedules, teams
- **Bitbucket** — repositories, pull requests, pipelines, deployments
- **Cross-product search** — natural language search across all Atlassian products

### Pattern matching
- Jira issue keys like `PROJ-123`, `DEV-42`
- Keywords: atlassian, jira, confluence, compass, bitbucket, jsm, sprint, epic, jql, cql
- Action phrases: "create issue", "search tickets", "update page", "merge PR"

## Tools

### `atlassian_jira`
Manage Jira issues and projects. Actions:
- `get_issue` — get issue details by key (e.g. PROJ-123)
- `create_issue` — create a new issue (requires project_key, summary)
- `edit_issue` — update issue fields
- `transition_issue` — move issue through workflow
- `add_comment` — add a comment to an issue
- `add_worklog` — log time on an issue
- `search_jql` — search issues using JQL
- `list_projects` — list accessible projects
- `get_issue_types` — get issue types for a project
- `get_transitions` — get available workflow transitions
- `get_link_types` — list issue link types
- `get_remote_links` — get remote links on an issue
- `lookup_user` — find a user by name or email
- `get_field_metadata` — get field metadata for issue creation

### `atlassian_confluence`
Manage Confluence pages and spaces. Actions:
- `get_page` — get a page by ID
- `create_page` — create a new page
- `update_page` — update page content
- `get_descendants` — get child pages
- `list_spaces` — list accessible spaces
- `list_pages_in_space` — list pages in a space
- `search_cql` — search using CQL
- `get_footer_comments` / `get_inline_comments` — read comments
- `create_footer_comment` / `create_inline_comment` — add comments

### `atlassian_compass`
Manage Compass components and relationships. Requires OAuth 2.0. Actions:
- `get_component` / `list_components` / `create_component`
- `get_activity` / `get_labels` / `get_types`
- `get_custom_fields` / `get_my_team_components`
- `create_relationship` / `create_custom_field`

### `atlassian_jsm`
Manage Jira Service Management operations. Actions:
- `get_alert` / `search_alerts` — view and search alerts
- `get_schedule` / `list_schedules` — on-call schedules
- `get_team` / `list_teams` — operations teams
- `update_alert` — acknowledge, close, or escalate alerts

### `atlassian_bitbucket`
Manage Bitbucket Cloud repositories and CI/CD. Actions:
- Repositories: `list_repos`, `get_repo`, `list_files`
- Pull requests: `list_pull_requests`, `get_pull_request`, `create_pull_request`, `merge_pull_request`
- Pipelines: `list_pipelines`, `get_pipeline`, `run_pipeline`
- Deployments: `list_deployments`, `list_environments`
- Code: `get_branch`, `get_commit`, `create_branch`, `create_commit`

### `atlassian_search`
Cross-product search and Teamwork Graph. Actions:
- `search` — natural language search across Jira and Confluence (Rovo)
- `fetch` — fetch a resource by ARI
- `get_context` — get connected context for an entity
- `get_object` — get object details by ARI(s)
- `get_user_info` — get current user info
- `list_resources` — list available resource types

## Product Enablement

Users can toggle each product on/off in settings. When a product is disabled,
its tools won't be loaded. Default enabled: Jira, Confluence, Search.

## Error Handling

All handlers return JSON with either `{ result: ... }` or `{ error: "message" }`.
Auth failures will suggest the user check their credentials in Settings.
Token refresh is automatic when a refresh token is available.

# Pipedream Skill

Pipedream Connect integration for workflow automation, managed auth,
and 3,000+ app integrations. Run pre-built actions, deploy triggers,
manage connected accounts, and invoke workflows — all from natural
language requests.

## Authentication

This skill supports two authentication methods, configured in
**Settings → Skills → Pipedream**:

### OAuth Client Credentials (Recommended)

Best for full API access with automatic token refresh.

**Setup steps:**
1. Go to [pipedream.com/settings/api](https://pipedream.com/settings/api)
2. Click **New OAuth Client** and name it (e.g. "OrionOmega")
3. Copy the **Client ID** and **Client Secret** (secret shown once!)
4. In OrionOmega settings, enter:
   - **OAuth Client ID** — from step 3
   - **OAuth Client Secret** — from step 3
   - **Project ID** — from your project settings (proj_xxx)
5. Choose your **Environment** (Development or Production)

### User API Key (Legacy)

Simpler but limited endpoint support.

1. Go to [pipedream.com/settings/account](https://pipedream.com/settings/account)
2. Copy your **API Key**
3. Paste in OrionOmega settings

## When to Use This Skill

Use this skill when the user wants to:
- Search or browse available third-party app integrations
- Run an action (send a Slack message, create a Jira issue, etc.)
- Deploy a trigger to listen for events (new GitHub PR, new email, etc.)
- Manage connected accounts or external users
- Invoke a Pipedream workflow
- Route custom API requests through Pipedream's proxy

### Pattern Matching
- Keywords: pipedream, workflow, automation, integration, trigger, action
- Action phrases: "run action", "deploy trigger", "list apps", "connect account"
- Commands: `/pipedream`, `/pd`

## Tools

### `pipedream_apps`
Search and browse 3,000+ app integrations.
- `list_apps` — search apps by name, category, or capability
- `get_app` — get detailed info for a specific app
- `list_categories` — list all app categories

### `pipedream_components`
Discover and inspect component definitions.
- `list_components` — search action and trigger components
- `get_component` — get full prop schema for a component
- `configure_prop` — get dynamic options for a configurable prop
- `reload_props` — reload props after setting a dynamic prop

### `pipedream_actions`
Execute pre-built API operations.
- `list_actions` — search available actions by app or keyword
- `get_action` — get action definition and configurable props
- `configure_prop` — configure a prop (get remote options)
- `reload_props` — reload dynamic props
- `run_action` — execute an action with configured props

### `pipedream_triggers`
Deploy and manage event sources.
- `list_triggers` / `get_trigger` — discover trigger components
- `deploy_trigger` — deploy a trigger with webhook/workflow destination
- `list_deployed` / `get_deployed` — view deployed triggers
- `update_deployed` / `delete_deployed` — manage deployed triggers
- `get_events` — retrieve events from a deployed trigger

### `pipedream_accounts`
Manage connected accounts.
- `list_accounts` — list all connected accounts (optionally by user or app)
- `get_account` — get account details (optionally with credentials)
- `delete_account` — remove a connected account
- `delete_accounts_by_app` — remove all accounts for a specific app

### `pipedream_users`
Manage external users and tokens.
- `list_users` — list all external users
- `delete_user` — delete a user and all their resources
- `create_connect_token` — create a short-lived token for frontend auth flows

### `pipedream_workflows`
Invoke Pipedream workflows.
- `invoke_workflow` — trigger a workflow via HTTP with custom payload

### `pipedream_proxy`
Route API requests through Pipedream's Connect Proxy.
- `proxy_request` — send any HTTP request through Pipedream with managed auth

## Feature Enablement

Toggle features on/off in settings. Disabled features won't load tools.
Defaults: all enabled except Connect Proxy.

## Key Concepts

### External User ID
Your app's user identifier. Required for actions, triggers, and accounts.
Set a default in settings or pass per-call.

### Auth Provision ID (apn_xxx)
A connected account's ID. Required in `configured_props` for actions/triggers
that need third-party auth (e.g. `{ slack: { authProvisionId: "apn_xxx" } }`).

### Dynamic Props
Some components have props that change based on prior selections.
When `reloadProps: true`, call `reload_props` after setting that prop,
then include the returned `dynamic_props_id` in the run/deploy call.

## Error Handling

All handlers return `{ result: ... }` or `{ error: "message" }`.
Auth failures trigger automatic token refresh. Rate limits report
the retry-after delay.

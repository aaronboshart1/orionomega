# GitHub

Full-featured GitHub integration via the `gh` CLI. Manage repositories, issues, pull requests, CI/CD workflows, releases, and make raw API calls.

## When to Use

- Managing GitHub repositories (list, create, clone, fork, archive, delete)
- Working with issues (create, edit, close, assign, label, search)
- Managing pull requests (create, review, merge, check CI status)
- Monitoring or triggering GitHub Actions workflows
- Creating or managing releases and release assets
- Making raw GitHub REST or GraphQL API calls

## When NOT to Use

- Non-GitHub version control (GitLab, Bitbucket) — use their respective skills
- Local-only git operations (commit, branch, rebase) — use git directly
- GitHub Packages or Container Registry management — use `gh_api` for unsupported endpoints

## Tools

All tools return `{ "result": "..." }` on success (human-readable formatted text) or `{ "error": "..." }` on failure.

### `gh_repo`

Manage GitHub repositories: list, view, clone, create, fork, archive, delete, rename.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `list`, `view`, `clone`, `create`, `fork`, `archive`, `delete`, `rename` |
| `repo` | string | no | Repository in `owner/name` format |
| `name` | string | no | Repository name (for `create`) |
| `description` | string | no | Repository description (for `create`) |
| `private` | boolean | no | Whether the repo should be private (for `create`) |
| `limit` | number | no | Max results to return (default 30) |
| `topic` | string | no | Filter by topic |
| `language` | string | no | Filter by primary language |

**Returns:** `{ "result": "..." }` — for `view`, includes name, visibility, stars, forks, languages, and URL. For `list`, includes a formatted list of repositories with stars, language, and description.

**Examples:**

- `{ "action": "list", "limit": 10 }` — list your repositories
- `{ "action": "create", "name": "my-app", "private": true }` — create a private repo
- `{ "action": "view", "repo": "owner/repo" }` — view repo details

---

### `gh_issue`

Manage GitHub issues: list, view, create, edit, close, reopen, comment, assign, label, search, transfer, pin, lock.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `list`, `view`, `create`, `edit`, `close`, `reopen`, `comment`, `assign`, `label`, `search`, `transfer`, `pin`, `lock` |
| `repo` | string | no | Repository in `owner/name` format |
| `number` | number | no | Issue number (for `view`, `edit`, `close`, `reopen`, `comment`) |
| `title` | string | no | Issue title (for `create`, `edit`) |
| `body` | string | no | Issue body text (for `create`, `edit`, `comment`) |
| `labels` | string[] | no | Labels to apply |
| `assignees` | string[] | no | Users to assign |
| `milestone` | string | no | Milestone name or number |
| `state` | string | no | Filter by state: `open`, `closed`, `all` |
| `query` | string | no | Search query (for `search` action) |
| `limit` | number | no | Max results (default 30) |
| `sort` | string | no | Sort field: `created`, `updated`, `comments` |

**Returns:** `{ "result": "..." }` — for `view`, includes number, title, state, author, labels, assignees, body, and URL. For `list`, includes a formatted table of issues. For `create`, includes the new issue number and URL.

**Examples:**

- `{ "action": "list", "repo": "owner/repo", "state": "open" }` — list open issues
- `{ "action": "create", "repo": "owner/repo", "title": "Bug: ...", "labels": ["bug"] }` — create an issue
- `{ "action": "search", "query": "is:open label:bug" }` — search issues

---

### `gh_pr`

Manage pull requests: list, view, create, edit, merge, close, reopen, comment, review, diff, checks, ready, draft.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `list`, `view`, `create`, `edit`, `merge`, `close`, `reopen`, `comment`, `review`, `diff`, `checks`, `ready`, `draft` |
| `repo` | string | no | Repository in `owner/name` format |
| `number` | number | no | PR number |
| `title` | string | no | PR title (for `create`, `edit`) |
| `body` | string | no | PR body (for `create`, `edit`, `comment`, `review`) |
| `base` | string | no | Base branch (for `create`) |
| `head` | string | no | Head branch (for `create`) |
| `draft` | boolean | no | Create as draft PR |
| `merge_method` | string | no | Merge method: `merge`, `squash`, `rebase` |
| `review_event` | string | no | Review event: `APPROVE`, `REQUEST_CHANGES`, `COMMENT` |
| `labels` | string[] | no | Labels to apply |
| `assignees` | string[] | no | Users to assign |
| `reviewers` | string[] | no | Reviewers to request |
| `state` | string | no | Filter: `open`, `closed`, `merged`, `all` |
| `limit` | number | no | Max results (default 30) |

**Returns:** `{ "result": "..." }` — for `view`, includes number, title, state, author, base/head branches, review status, and URL. For `diff`, includes the full diff text. For `checks`, includes CI check results.

**Examples:**

- `{ "action": "create", "repo": "owner/repo", "title": "Feature X", "head": "feature-x" }` — create a PR
- `{ "action": "merge", "repo": "owner/repo", "number": 99, "merge_method": "squash" }` — squash merge
- `{ "action": "checks", "repo": "owner/repo", "number": 99 }` — check CI status

---

### `gh_workflow`

Manage GitHub Actions: list workflows, view/trigger/cancel/rerun runs, view logs, list/download artifacts.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `list`, `runs`, `view`, `trigger`, `cancel`, `rerun`, `logs`, `artifacts`, `download` |
| `repo` | string | no | Repository in `owner/name` format |
| `workflow` | string | no | Workflow filename or ID (for `trigger`, `runs`) |
| `run_id` | string | no | Run ID (for `view`, `cancel`, `rerun`, `logs`) |
| `ref` | string | no | Git ref for trigger (branch/tag) |
| `inputs` | object | no | Workflow dispatch inputs |
| `limit` | number | no | Max results (default 10) |

**Returns:** `{ "result": "..." }` — for `runs`, includes a formatted list with run ID, status, conclusion, branch, and event. For `logs`, includes the run's log output. For `trigger`, confirms the workflow was dispatched.

**Examples:**

- `{ "action": "trigger", "repo": "owner/repo", "workflow": "ci.yml", "ref": "main" }` — trigger a workflow
- `{ "action": "logs", "repo": "owner/repo", "run_id": "12345" }` — view run logs

---

### `gh_release`

Manage releases: list, view, create, edit, delete, upload/download assets.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | yes | One of: `list`, `view`, `create`, `edit`, `delete`, `upload`, `download` |
| `repo` | string | no | Repository in `owner/name` format |
| `tag` | string | no | Release tag (e.g. `v1.0.0`) |
| `title` | string | no | Release title |
| `notes` | string | no | Release notes |
| `draft` | boolean | no | Create as draft |
| `prerelease` | boolean | no | Mark as prerelease |
| `generate_notes` | boolean | no | Auto-generate release notes |
| `files` | string[] | no | File paths to upload as assets |
| `target` | string | no | Target commitish (branch or SHA) |
| `limit` | number | no | Max results (default 10) |

**Returns:** `{ "result": "..." }` — for `view`, includes tag, title, release notes, assets, and URL. For `create`, confirms the release was created with tag and URL.

**Examples:**

- `{ "action": "create", "repo": "owner/repo", "tag": "v1.0.0", "generate_notes": true }` — create a release
- `{ "action": "list", "repo": "owner/repo" }` — list releases

---

### `gh_api`

Make raw GitHub API requests. Supports REST and GraphQL. Use for any endpoint not covered by other tools.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `endpoint` | string | yes | REST API path (e.g. `/repos/{owner}/{repo}/branches`) or `graphql` for GraphQL |
| `method` | string | no | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (default `GET`) |
| `body` | object | no | Request body (for `POST`, `PUT`, `PATCH`) |
| `query` | string | no | GraphQL query string (when endpoint is `graphql`) |
| `variables` | object | no | GraphQL variables |
| `jq` | string | no | jq expression to filter response |
| `paginate` | boolean | no | Auto-paginate results |

**Returns:** `{ "result": "..." }` — the raw API response as JSON text, optionally filtered by `jq`.

**Examples:**

- `{ "endpoint": "/repos/owner/repo/branches", "jq": ".[].name" }` — list branch names
- `{ "endpoint": "graphql", "query": "{ viewer { login } }" }` — GraphQL query

## Notes

- Requires `gh` CLI installed and authenticated (`gh auth login`)
- Requires `git` installed
- All tools return `{ "result": "..." }` with human-readable formatted text or `{ "error": "..." }` on failure
- Long outputs are truncated to prevent context overflow

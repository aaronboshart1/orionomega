# GitHub Skill

Full-featured GitHub integration for OrionOmega via the `gh` CLI. Manage repositories, issues, pull requests, CI/CD workflows, releases, and raw API access.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth login`)
- `git` installed

## Tools

### gh_repo
Manage repositories: list, view, clone, create, fork, archive, delete, rename.

### gh_issue
Manage issues: list, view, create, edit, close, reopen, comment, assign, label, search, transfer, pin, lock.

### gh_pr
Manage pull requests: list, view, create, edit, merge, close, reopen, comment, review, diff, checks, ready, draft.

### gh_workflow
Manage GitHub Actions: list workflows, view/trigger/cancel/rerun runs, view logs, list/download artifacts.

### gh_release
Manage releases: list, view, create, edit, delete, upload/download assets.

### gh_api
Raw GitHub REST and GraphQL API requests. Use for anything not covered by the other tools.

## Usage Examples

```
# List open issues
gh_issue { "action": "list", "repo": "owner/repo", "state": "open" }

# Create an issue
gh_issue { "action": "create", "repo": "owner/repo", "title": "Bug: ...", "labels": ["bug"] }

# List PRs
gh_pr { "action": "list", "repo": "owner/repo" }

# Create a PR
gh_pr { "action": "create", "repo": "owner/repo", "title": "Feature X", "head": "feature-x", "body": "..." }

# Merge a PR
gh_pr { "action": "merge", "repo": "owner/repo", "number": 42, "merge_method": "squash" }

# Check CI status
gh_pr { "action": "checks", "repo": "owner/repo", "number": 42 }

# View PR diff
gh_pr { "action": "diff", "repo": "owner/repo", "number": 42 }

# Trigger a workflow
gh_workflow { "action": "trigger", "repo": "owner/repo", "workflow": "ci.yml", "ref": "main" }

# View workflow run logs
gh_workflow { "action": "logs", "repo": "owner/repo", "run_id": "12345" }

# Create a release
gh_release { "action": "create", "repo": "owner/repo", "tag": "v1.0.0", "generate_notes": true }

# Raw API call
gh_api { "endpoint": "/repos/owner/repo/branches", "jq": ".[].name" }

# GraphQL query
gh_api { "endpoint": "graphql", "query": "{ viewer { login repositories(first: 5) { nodes { name } } } }" }
```

## Orchestration

This skill is designed for autonomous orchestration workflows. All tools:
- Accept structured JSON input via the skill handler protocol
- Return structured results suitable for downstream node consumption
- Include error messages that are actionable (not just "failed")
- Truncate long outputs to prevent context overflow
- Use the lightweight worker tier (Haiku) by default

### Common Patterns

**Issue triage workflow:**
1. `gh_issue { "action": "search", "query": "is:open label:bug" }` → find bugs
2. For each: `gh_issue { "action": "view", "number": N }` → get details
3. CODING_AGENT implements fix
4. `gh_pr { "action": "create", ... }` → open PR
5. `gh_issue { "action": "close", "number": N, "body": "Fixed in #PR" }`

**CI monitoring loop:**
1. `gh_workflow { "action": "runs", "repo": "..." }` → check latest
2. If failed: `gh_workflow { "action": "logs", "run_id": "..." }` → get failure logs
3. CODING_AGENT fixes the issue
4. `gh_workflow { "action": "trigger", ... }` → re-run

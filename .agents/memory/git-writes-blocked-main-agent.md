---
name: Destructive git is blocked in the main agent
description: Why GitHub merge/push tasks cannot run as the main agent and must go to an isolated task agent
---

# Destructive git operations are blocked in the main-agent sandbox

Any git command that writes under `.git/` is refused in the main agent with:
`Destructive git operations are not allowed in the main agent` (it trips on the
lockfile, e.g. `.git/ORIG_HEAD.lock` / `.git/objects/maintenance.lock`). This
includes `git fetch`, `git merge` (even against an **already-fetched** ref like
`origin/main`), `git commit`, and `git push`. Read-only git
(`log`/`status`/`diff`/`show`/`ls-tree`/`cat-file`/`rev-list`) works fine.

**Why:** the platform routes destructive git through isolated task agents that
have system-level protections; the main agent intentionally cannot.

**How to apply:** a "merge/sync to GitHub" goal can NEVER be completed by the
main agent. It must be executed by an **isolated task agent**. The main agent
cannot reassign a task to an isolated agent — that is a user UI action. So the
main agent's job is limited to: (1) keep the working tree buildable/tested, (2)
write a complete, self-contained merge recipe into the task plan file
(`.local/tasks/task-NNN.md`), and (3) tell the user to reassign the task to an
isolated agent.

**Do NOT** call `mark_task_complete` on a git-sync task from the main agent to
"finish" it — that only makes a local commit of working-tree changes (plan
files, rebuilt `dist/`) and does NOT push or merge `origin/main`. It falsely
marks the task done while the divergence remains (and gets worse: local goes
further ahead). This has bitten this project twice.

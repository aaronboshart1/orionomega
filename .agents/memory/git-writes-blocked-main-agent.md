---
name: Destructive git is blocked in the main agent
description: Why GitHub merge/push tasks cannot run as the main agent and must go to an isolated task agent
---

# Destructive git operations are blocked in the main-agent sandbox

Any git command that writes under `.git/` is refused in the main agent with:
`Destructive git operations are not allowed in the main agent` (it trips on the
lockfile, e.g. `.git/ORIG_HEAD.lock` / `.git/objects/maintenance.lock`). This
includes `git fetch`, `git merge` (even against an **already-fetched** ref like
`origin/main`), `git commit`, and `git push`. Even a plain `rm .git/index.lock`
(or any `rm` of a `.git/*.lock` file) is refused — the guard watches the path,
not just the `git` binary. Read-only git
(`log`/`status`/`diff`/`show`/`ls-tree`/`cat-file`/`rev-list`) works fine. The
user's interactive **Shell** is NOT sandboxed this way, so the user can clear a
stale lockfile there: `rm -f .git/index.lock .git/ORIG_HEAD.lock .git/objects/maintenance.lock`.

**Editing working-tree files is NOT a git op** — it is always allowed, even
during an in-progress merge. This is the key to the Git-pane merge path below.

**Why:** the platform routes destructive git through isolated task agents that
have system-level protections; the main agent intentionally cannot.

**How to apply:** the main agent cannot itself run `git commit`/`push`/`merge`.
There are two ways to actually land a merge/sync:

1. **Git-pane path (works, preferred when the user is hands-on).** The user
   starts the merge in the Replit Git pane (Pull/Sync). If it stops on
   conflicts, the main agent resolves them by **editing the working-tree files
   directly** (normal file writes — allowed), removing all `<<<<<<<`/`=======`/
   `>>>>>>>` markers, then builds + tests to verify. The user then stages each
   resolved file in the Git pane (the "+"/"mark resolved" action — NOT the
   "use origin"/"use main" buttons, which would discard the hand-merge),
   commits the merge, and pushes. The push is the user's click; the agent
   cannot do it.
2. **Isolated task agent** (when the user wants it fully automated): routed via
   Plan mode propose→accept; the main agent cannot reassign — that is a user UI
   action.

**Silent auto-merge duplicates:** when both sides add the same top-level symbol
(e.g. a helper function) at *different* line ranges, git merges BOTH copies with
NO conflict marker → duplicate-definition compile error. After any merge, grep
for duplicate defs and rely on a full typecheck/build to catch them; do not trust
"no conflict markers" as "merge is clean".

**`-X ours` does NOT fix double-adds or type/usage splits.** `git merge -X ours`
only favors our side on *conflicting* hunks; non-conflicting changes from both
sides are still applied. So it re-introduces the silent double-add above, and it
can pair our side's *type definition* with origin's *usage code* (or vice-versa)
→ compile errors (e.g. usage referencing an interface field our side lacked).
After a `-X ours` merge you MUST rebuild + run the full test suite and be ready
to re-apply the same hand fixes you made in a prior resolution. It IS, however,
the cleanest way to record a proper merge commit (origin becomes an ancestor →
push fast-forwards) when local already contains the substance of the merge.

**Platform auto-checkpoint can abort an in-progress merge.** A "Loop ended"
checkpoint commits working-tree changes as a *regular single-parent* commit and
the merge gets aborted (MERGE_HEAD gone, merge-base unchanged, origin NOT an
ancestor) — so the resolved files are committed but origin's other files are
reverted and the history shows "N and N diverged" / push rejected
non-fast-forward. Recovery: redo the merge in the Shell (`git merge -X ours
origin/main -m ...`), re-apply hand fixes, rebuild+test, then `git push`.

**Git-pane "Sync" button vs Shell `git push`.** The Replit Git-pane "Sync" runs
its own pull/merge cycle and can falsely report a "merge conflict" even when the
local repo is pristine (no MERGE_HEAD, no unmerged paths, clean tree, origin
already an ancestor of HEAD, just ahead N). When local is clean + ahead, tell the
user to bypass the Sync button and run `git push origin main` in the Shell — it
fast-forwards cleanly. Confirm the real remote tip first (read-only) with
`git ls-remote origin refs/heads/main` and check it is an ancestor of HEAD.

**Do NOT** call `mark_task_complete` on a git-sync task to "finish" it while the
push is still pending — the auto-commit (a) may itself be blocked by the git
guard, and (b) does NOT push `origin`, so it falsely marks the task done while
the divergence remains. Wait for the user to confirm the push landed.

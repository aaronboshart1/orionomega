---
name: core vitest full-run hangs
description: running the entire packages/core vitest suite at once produces no output; chunk it
---

Running the **entire** `packages/core` vitest suite in one invocation
(`npx vitest run` with no path args, or a broad multi-dir glob with default
file parallelism) intermittently exits with no output and a -1 reason in this
container — looks like a hang/OOM under parallel worker fan-out, not a real
test failure.

**Why:** too many heavy test files (coding-orchestrator, safe-commit, executor
integration spin up real `git init` repos / child processes) running in parallel
saturate the container.

**How to apply:** run the suite in chunks by directory with
`--no-file-parallelism`, e.g.
`npx vitest run src/orchestration/__tests__ src/orchestration/coding/__tests__ --reporter=dot --no-file-parallelism`
then a second chunk for `src/agent/__tests__ src/anthropic src/memory/__tests__ src/models/__tests__ src/utils/__tests__`.
Full core suite total is ~862 tests across those two chunks.

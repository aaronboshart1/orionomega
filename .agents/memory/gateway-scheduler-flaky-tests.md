---
name: gateway scheduler tests are timing-flaky
description: scheduler.test.ts abort/timeout cases fail under CPU load — don't mistake for a regression
---

The gateway `src/__tests__/scheduler.test.ts` abort/timeout cases (e.g. "passes an
AbortSignal that fires when the per-attempt timeout elapses") assert that an
`AbortSignal` fires within tight real-time `setTimeout` windows (~1500ms waits).

**Why:** Under a CPU-starved isolated/CI environment they fail intermittently
(observed 4/32 failing) even on a clean tree with unrelated changes — the abort
just hasn't fired yet when the assertion runs. They reproduce in isolation, so
isolation does not prove a real break.

**How to apply:** If only these timing cases fail and your diff doesn't touch
`packages/gateway/src/scheduler*` or core scheduler code, treat them as
environment flakiness, not your regression. Verify your own changed surface
with a targeted test run instead.

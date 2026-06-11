---
name: native multi-agent session substrate
description: How the OFF-by-default native-session pilot plugs into the executor without changing default behavior.
---

# Native multi-agent session substrate (roadmap R3)

A pilot that runs ONE eligible sub-DAG layer via a single Anthropic native multi-agent
session (coordinator query + `agents` roster) instead of in-house per-node dispatch.
Lives in `packages/core/src/orchestration/native-session-substrate.ts`; wired into
`executor.ts`.

## Key design rules (durable)

- **Flag is OFF by default.** Gate is `agentSdk.nativeSessions.enabled`. The executor
  must stay byte-identical when off — the branch sits *before* the default
  `Promise.allSettled` and only triggers when `evaluateLayerEligibility` says yes.
- **Same result shape both paths.** The native path returns
  `PromiseSettledResult<WorkerResult>[]` aligned with the layer's runnable nodes, so the
  downstream processing loop / checkpoint / artifact model are untouched. Any new path
  that bypasses per-node dispatch MUST preserve this shape.
- **Executor owns retries/budgets/checkpointing, not the SDK.** Native layer runs once;
  a coordinator-failed node comes back as a rejected settled result and re-enters the
  normal retry/replan machinery. No in-session per-node retry in the pilot (avoids two
  competing controllers).
- **Fail closed.** `parseCoordinatorReport` marks any node missing from the report — or
  an unparseable report — as `error`. Never silent-succeed.
- **Substrate stays SDK-free at import time.** The executor static-imports it for the
  *synchronous* eligibility helpers, so `query` is lazily `await import`-ed inside
  `defaultQueryFn` (and `buildContextEditingSettings` is dynamically imported in the
  executor method). Keep it that way or you pull the heavy SDK into executor module load.

**Why:** the pilot's whole point is to prove the native session as a *substrate* while
keeping OrionOmega's orchestration semantics authoritative. Build-vs-adopt rec (in
`docs/architecture-notes.md`): adopt the session for intra-layer fan-out, keep the
orchestrator as the controller.

**How to apply:** when extending past the pilot (multi-layer, in-session retry), revisit
the single-layer `nativeSessionUsed` guard and the once-only cost attribution split.

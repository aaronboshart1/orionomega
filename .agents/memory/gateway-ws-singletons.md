---
name: gateway WS client singleton constraint
description: Why the web gateway WebSocket lifecycle/connection state cannot be split out of lib/gateway.ts into a sibling module.
---

When splitting the web gateway WebSocket client (`packages/web/src/lib/gateway.ts`) into focused modules, the module-level **mutable** connection-state singletons (the live socket, `wsReady`, `pendingRestart`, the outbound queue, health-check timer/id, reconnect counter, init-ack flag, file-read callbacks, status-fetch controller, client-state interval) MUST stay in the main module.

**Why:** ES `export let` bindings are *read-only in importers* — a sibling module that imports `wsReady` can read it but cannot reassign it. The connection lifecycle (open/close/message handlers, send queue) mutates these across functions, so they can't live behind an import boundary.

**How to apply:** Extract the *pure* / *stateless* concerns instead — message dispatch (`event-handlers`), snapshot/history reconciliation (`snapshot-processor`), URL/helpers (`connection-utils`), logs REST wrappers (`logs-client`). When an extracted module needs to drive the singleton lifecycle (flush queue, set ready, clear health check, set restart flag, replay a frame), hand it a **context object of setter callbacks** (closures over the singletons), not the singletons themselves. The handler stays decoupled; the main module retains ownership of the mutable state. Keep `gateway.ts` as the barrel re-exporting the public API (e.g. `export * from './gateway/logs-client'`) so the ~10 existing `@/lib/gateway` importers don't change.

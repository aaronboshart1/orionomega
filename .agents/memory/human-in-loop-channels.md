---
name: Human-in-the-loop request/response channels
description: How pause-and-ask channels (humanGate boolean, manual-intervention free-text) thread across core→gateway→web, and the foot-guns when adding one.
---

# Human-in-the-loop channels (humanGate, manual-intervention)

OrionOmega has paired "ask the operator, then resume the worker" channels. The
boolean **humanGate** (approve/deny) and the free-text **manual-intervention**
(returns a string, keyed by nodeId) are deliberate mirrors of each other.

**Why:** when adding a new human-in-the-loop interaction, copy the existing
channel end-to-end rather than inventing a new shape — the persistence,
rehydration, and event plumbing are subtle and already battle-tested.

**How to apply — a channel touches every layer, in this order:**
1. core types — NodeType + per-node config + two WorkerEvent types (request/ack).
2. core executor — a callback on ExecutorConfig, an AbortController map aborted
   in `stop()`, and a node-type case that emits the request event, awaits the
   callback, writes an artifact + records a decision, then emits the ack event.
3. core orchestration-bridge + main-agent — a pending-requests map, the callback
   wiring, a `resolve*()` + `listPending*()` pair, public callbacks, and a
   `handle*Response()` on MainAgent.
4. gateway — ClientMessage (response) + two ServerMessages (request/resolved) in
   types AND ws-schemas (the zod union), a websocket routing case + handler, the
   server.ts callbacks (emit over socket AND persist), and **sessions.ts
   persistence mirroring pendingGates**: Session field, the optional snapshot
   field, set/remove methods, plus EVERY init/reset/snapshot/hydrate site (there
   are ~8 — miss one and either it won't compile or state silently won't survive
   reload). Persistence is what makes the panel survive a page refresh while the
   worker is still blocked.
5. web — orchestration store (pending map + setters + the two new event types),
   gateway.ts (socket handlers + a submit helper returned from useGateway() +
   snapshot rehydration), and the UI panel. `useGateway()` uses a singleton
   socket so it is safe to call from child components.

**Foot-gun:** `WorkerEventType` has an EXHAUSTIVE `Record<WorkerEventType, …>`
map (typeLabels in web ActivityFeed). Adding an event type without updating it
fails the web `tsc` build. Other event-type maps in the same file are `Partial<>`
and tolerate omissions — only the exhaustive ones break.

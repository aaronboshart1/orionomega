---
name: Claude Opus 4.8 API constraints
description: Request-shape rules the Anthropic Messages API enforces for claude-opus-4-8 (returns 400 otherwise)
---

# Claude Opus 4.8 (`claude-opus-4-8`) request constraints

When building a request for Opus 4.8 against the raw Messages API (the direct
`fetch` client, not the SDK), the following return HTTP 400:

- **Sampling params**: `temperature`, `top_p`, `top_k` are rejected. Strip them.
- **Manual thinking budget**: only adaptive thinking is allowed
  (`thinking: { type: 'adaptive' }`). Sending `{ type: 'enabled', budget_tokens: N }`
  (or any manual budget alongside adaptive) → 400. Convert/force to adaptive.
- **max_tokens ceiling = 128000** (NOT 131072 — that exact value is what produced
  the observed `max_tokens > 128000` error). Clamp to 128000.

**Why:** these surfaced as instant worker-node crashes / 400s when Opus 4.8 was
selected, while older Opus/Sonnet worked. The fix lives centrally in the direct
client's request-body builder, gated on an `opus-4-8` model-id regex, so callers
can keep passing their usual options regardless of model.

**How to apply:** any new code that hand-builds an Anthropic Messages request
(bypassing the shared client) must apply the same three guards for Opus 4.8.
Per-model output ceilings: Opus 4.8 = 128000; other Opus/Sonnet 4.x = 64000;
everything else = 8192.

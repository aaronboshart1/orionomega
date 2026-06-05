---
name: claude-agent-sdk thinking & effort
description: How @anthropic-ai/claude-agent-sdk 0.3.x expresses thinking depth and effort in query() options
---

# claude-agent-sdk (0.3.x) thinking & effort options

For the worker/coding (SDK) path that calls `query({ options })`:

- **Adaptive thinking takes NO budget field.** The SDK's `ThinkingAdaptive` type
  is `{ type: 'adaptive'; display?: ... }` — no `budgetTokens`. A manual budget
  (camelCase `budgetTokens` or snake_case `budget_tokens`) belongs ONLY to
  `ThinkingEnabled` (`{ type: 'enabled', budgetTokens: N }`). Note the SDK uses
  **camelCase `budgetTokens`**, not the raw API's snake_case `budget_tokens`.
  - Gotcha: a snake_case `budget_tokens` spread into an adaptive-thinking object
    literal compiles silently (object spreads bypass TS excess-property checks)
    but is invalid at runtime. Don't trust "it compiled" here.
- **effort accepts `'low'|'medium'|'high'|'xhigh'|'max'`** (or an integer) and
  **silently downgrades** any level the selected model doesn't support. So pass
  the role's true effort through — no need to pre-collapse `xhigh`→`high`.
  Depth for adaptive thinking is governed by `effort`, not a token budget.
- Legacy `maxThinkingTokens` is deprecated; `thinking` takes precedence over it.

**Why:** upgrading from 0.2.71 (predated Opus 4.8) to 0.3.165 was required to make
the worker path run Opus 4.8 at all; the 0.2→0.3 jump also tightened the message
type (`BetaMessage` no longer has a string index signature, so
`x as Record<string, unknown>` casts need an intermediate `as unknown`).

**How to apply:** when editing SDK `query()` options, keep adaptive thinking
budget-free and let `effort` carry depth; if you must set a fixed budget, switch
the thinking type to `enabled` and use camelCase `budgetTokens`.

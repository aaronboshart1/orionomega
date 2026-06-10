---
name: Model capability registry
description: Where per-model behavior lives in OrionOmega core and how precedence works
---

# Model capability registry

All per-model behavior in `@orionomega/core` is declared in one table:
`packages/core/src/models/model-registry.ts` (`ModelCapability`). This is the single
source of truth for tier, output ceilings, thinking style, pricing, beta headers,
fast-mode, sampling support, mid-conversation-system support, effort aliasing, and
access gating. Add a model = edit data (a default entry, a discovery seed, or a
`config.yaml` `models.registry` override), not code.

**Precedence (per field): config > discovery > defaults.**
- Defaults seed the base table.
- `seedRegistryFromDiscovery()` (inside `discoverModels`) is **additive only** — it
  never overwrites an existing entry, so config/defaults keep precedence.
- `applyRegistryOverrides()` (from `readConfig`) merges field-by-field on top.

**Why:** model behavior used to be scattered across `client.ts`, `model-discovery.ts`,
`coding-budget.ts`, and `planner.ts` as `model.includes('opus-4-8')`-style branches;
every new model needed edits in 4+ files. Consolidating made it a data edit.

**How to apply:**
- Resolve via `getModelCapability(id)`; never re-introduce inline `model.includes(...)`
  tier/pricing/ceiling checks in consumers.
- Two distinct output concepts both matter: `defaultMaxOutput` (comfortable default
  `max_tokens`) and `maxOutput` (hard API ceiling — a 400 above it). They differ for
  opus/sonnet (16384 vs 64000).
- `mythos` tier sits above `opus`; `inferModelTier` maps `fable`/`mythos` IDs to it
  (checked before `opus`). `fable-5` is `accessGated: true` — gated-model fallback is a
  separate task, not handled in the registry itself.
- Lookup matches longest alias first, so `opus-4-8` wins over a broader `opus` token;
  dated variants (`claude-opus-4-8-20260601`) resolve via alias substring.
- Adaptive-thinking models (opus-4-8, mythos) reject sampling params and manual
  `budget_tokens`; the registry encodes this via `thinking`, `supportsSampling`.

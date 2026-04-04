# Migration Guide

**OrionOmega v0.1.0 → v0.1.1**

---

## Overview

v0.1.1 is a backward-compatible patch release. Existing deployments running v0.1.0 will work without any configuration changes. However, **three default values have changed** that affect behavior. Review each one to determine whether your deployment needs adjustment.

---

## Breaking Changes

None. All existing configuration files, skill manifests, and API integrations continue to work unchanged.

---

## Changed Defaults (Review Required)

### 1. Relevance threshold: 0.3 → 0.15

**Changed in:** `HindsightClient.recall()` default `minRelevance`

**Before (v0.1.0):** All callers that didn't explicitly set `minRelevance` used 0.3.

**After (v0.1.1):** Default is 0.15. When the API returns `relevance=0` for all results (no embedding backend), the client-side fallback ceiling is also capped at 0.15.

**Impact:** More memories will be returned per recall. This is the intended fix — v0.1.0 was discarding nearly all relevant memories.

**Action required if:** You explicitly set `minRelevance: 0.3` in code and want to keep that behavior when the embedding backend is configured. In that case, your explicit value takes precedence — no change needed. If you relied on the implicit 0.3 as a quality gate, consider setting `minRelevance: 0.25` explicitly.

---

### 2. Recall budget tokens: 30,000 → 8,192

**Changed in:** `ContextAssembler` default `recallBudgetTokens`

**Before (v0.1.0):** Default was 30,000, but was silently clamped to 8,192 by `HindsightClient` (the `high` tier cap).

**After (v0.1.1):** Default is 8,192, matching the actual enforced cap.

**Impact:** No behavioral change — requests were already capped at 8,192. The value in logs and telemetry now accurately reflects the effective budget.

**Action required if:** You overrode `recallBudgetTokens` above 8,192. Your override will continue to be clamped silently. To use a genuinely larger budget, you would need to upgrade Hindsight to a version that supports a higher `high` tier cap.

---

### 3. ContextAssembler `minRelevance`: unset → 0.15

**Changed in:** `ContextAssembler` constructor default

**Before (v0.1.0):** `minRelevance` was not set in `ContextAssembler`, so the `HindsightClient` default (0.3) applied.

**After (v0.1.1):** `ContextAssembler` explicitly sets `minRelevance: 0.15`.

**Impact:** Same as change #1 — more memories will pass the filter.

---

## Upgrade Procedure

### Standard upgrade

```bash
# Pull latest changes
cd /path/to/orionomega
git pull origin main

# Install updated dependencies
pnpm install

# Rebuild
pnpm build

# Restart the gateway
orionomega stop
orionomega start
```

### Verify memory system after upgrade

After restarting, confirm recall is working:

```bash
# Enable verbose logging temporarily
ORIONOMEGA_LOG_LEVEL=verbose orionomega start

# In another terminal, run a query that should hit your memories
# Watch for: "Recall ← core" with resultCount > 0
# Watch for: "usedClientRelevance: true" (confirms fallback scoring active)
```

If you see `"All N results filtered below relevance threshold"` after upgrading, check:
1. Your explicit `minRelevance` override (should be ≤ 0.15 for client-side scoring)
2. Hindsight server health (`curl http://localhost:8888/health`)

---

## Skills SDK Migration (v0.1.0 → v0.1.1)

No changes to the Skills SDK in this release. See `MIGRATION.md` (the existing Skills SDK guide) for the `0.1.0` → `0.2.0` skills migration path.

---

## Existing Memory Banks

Memory banks created in v0.1.0 are fully compatible with v0.1.1. No bank migration or data transformation is needed.

**If you stored many memories in v0.1.0 that were never recalled** (because of the threshold bug), those memories will now be returned in future recalls. This is the intended behavior.

---

## Environment Variables

No new environment variables. No removed variables.

| Variable | Purpose | Changed? |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key | No |
| `HINDSIGHT_API_KEY` | Hindsight API key | No |
| `ORIONOMEGA_LOG_LEVEL` | Override log level | No |
| `ORIONOMEGA_LOG_FORMAT` | Set `json` for structured logs | No |
| `ORIONOMEGA_CONFIG` | Override config file path | No |

---

## Rollback

To roll back to v0.1.0:

```bash
git checkout v0.1.0
pnpm install
pnpm build
orionomega stop && orionomega start
```

There is no data migration in v0.1.1 — rollback is clean and leaves all memory banks unchanged.

---

## Deploying to Existing Production Instances

If you are running v0.1.0 in production with active users:

1. The memory system will immediately begin surfacing previously-stored memories that were silently dropped by the v0.1.0 threshold bug. Users may notice the agent "remembering" things it previously forgot. This is correct behavior.

2. The first session after upgrade will trigger mental model seeding for any models that don't yet exist (F7). This is a one-time operation that runs asynchronously and does not block the session.

3. No downtime is required for the upgrade.

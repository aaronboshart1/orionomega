# OrionOmega — Complete Codebase Review & Upgrade Roadmap

_June 10, 2026_

**Goal of this review:** assess how to evolve OrionOmega so that frontier models (Claude **Opus 4.8** and the new **Fable 5** Mythos-class model) can use the **Claude Agent SDK** to orchestrate large numbers of agents that solve problems requiring massive context (large sets of detailed spec/architecture `.md` files) and execute enormous plans **unattended**. Covers architecture, security, UI/UX, engineering best-practices, efficiency, and developer readability, with a prioritized roadmap.

---

## 1. Executive summary

OrionOmega is an unusually mature, purpose-built agent-orchestration platform. The orchestration core (hierarchical macro/micro planning, layered DAG execution, checkpoint/resume, layered commit-safety) is genuinely strong and ahead of most home-grown systems. The biggest opportunities are **not** "fix what's broken" — they are **strategic alignment with where Anthropic moved the platform in 2026**.

**Three findings dominate everything else:**

1. **The SDK is pinned one tier behind the models you want to run.** The repo uses `@anthropic-ai/claude-agent-sdk@0.3.165`. Anthropic's **0.3.170** release (June 2026) literally *"Added `claude-fable-5` model and the `fable` alias to SDK model types"*; latest is **0.3.172**. Upgrading the SDK is the single smallest change that directly unblocks the stated goal.

2. **Model support is hardcoded, not pluggable.** Tier inference, output-token ceilings, pricing, and thinking-effort behavior are baked into `switch`/`includes()` logic across `client.ts`, `model-discovery.ts`, and `coding-budget.ts`. Each new model (Opus 4.8 → Fable 5 → whatever ships next) currently requires a core code change. A **capability-registry** turns "supporting a new model" from an engineering task into a config edit. This is the highest-leverage architectural change for the project's mission.

3. **Anthropic now ships native primitives that overlap with three things OrionOmega built custom** — context management (context editing + memory tool), Managed-Agents memory, and **multi-agent sessions** (coordinator + isolated/persistent session threads). These are not a reason to throw away your work; they are a reason to make a deliberate **build-vs-adopt** decision per subsystem so you don't carry maintenance cost for problems Anthropic now solves natively.

**Overall health:** solid green on engineering discipline (strict TS, Vitest, checkpointing, commit-safety, prompt caching, cost budgeting). Yellow on a few structural items (2,500+ line god-files, in-process executor memory ceiling, single-user auth model for unattended runs, DAG visualization that won't scale to hundreds of nodes). No red/critical defects found.

---

## 2. External research findings (authoritative, June 2026)

### 2.1 Claude Agent SDK
- **Pinned:** `0.3.165`. **Latest:** `0.3.172`. **`0.3.170`** added `claude-fable-5` + the `fable` alias to SDK model types (confirmed in the GitHub CHANGELOG). `0.3.171` = parity with Claude Code v2.1.171. `0.3.172` adds per-plugin `skipMcpDiscovery`.
- Since `0.2.113` the SDK spawns a **native Claude Code binary** via per-platform optional dependencies (robust subprocess model), Node 18+. Ships subagents, sessions, MCP, and a plugins system.

### 2.2 Claude Opus 4.8 (`claude-opus-4-8`, released May 28 2026)
- **1,000,000-token context window by default at standard pricing** (a 900k request bills at the same per-token rate as a 9k request). **128k max output.** Adaptive thinking with `low / high / xhigh / max`.
- Pricing: **$5 in / $25 out** per 1M; cache read **$0.50**, cache write (5m) **$6.25**; **Fast Mode** research preview (~2.5× faster) at **$10 / $50**.
- This validates the project's existing `opus-4-8` special-casing (128k ceiling, adaptive-only thinking, `fast-mode-2026-02-01` beta, `$5/$25` cost rate).

### 2.3 Claude Fable 5 (`claude-fable-5`, alias `fable`, launched June 9 2026)
- A **new "Mythos-class" tier positioned _above_ Opus** — Anthropic's most capable generally-available model. **1M context. API-only.**
- **Access is gated** (cybersecurity concerns; rollout focused on critical-infrastructure orgs). `Mythos 5` is the same capability without safety classifiers, in limited availability (Project Glasswing).
- **Direct implication for OrionOmega:** the current tier model only knows `opus / sonnet / haiku`. Fable 5 is a *fourth tier above Opus*; tier inference, role→model maps, pricing, and the planner's model guide all need a "mythos/fable" concept. This is exactly why the registry change (§3, R2) matters.

### 2.4 Native platform primitives that overlap with custom subsystems
- **Context editing** (Sept 2025): auto-clears stale tool calls/results as token limits approach, preserving conversation flow → longer runs, sharper focus.
- **Memory tool** (Sept 2025): file-based store/read/update/delete in a dedicated memory dir, client-side, persists across sessions. **Overlaps Hindsight.**
- **Managed Agents Memory + "Dreaming"** (May 2026): platform-managed cross-session memory.
- **Managed Agents multi-agent sessions** (beta `managed-agents-2026-04-01`): a **coordinator** delegates to a **roster** (max 20 agents, depth = 1), via the `agent_toolset_20260401` tool, with `{type: self}` self-spawn. Each agent runs in its **own isolated, persistent session thread**; agents share sandbox/filesystem/vault but not context/tools. **Overlaps the custom DAG executor** — the key build-vs-adopt decision.

---

## 3. Strategic recommendations (the big rocks)

> These are ordered by leverage toward the mission. Effort: **S** ≤ 1–2 days, **M** ≈ a week, **L** ≈ multi-week.

### R1 — Upgrade the Agent SDK to ≥ 0.3.170 (and track 0.3.172). **[S, unblocks goal]**
The pinned `0.3.165` predates `claude-fable-5`/`fable` model types. Bump the dependency, run the full `core` suite (743 tests today), and verify `agent-sdk-bridge.ts` query options still typecheck against the new model union. This is the literal prerequisite to "let models like Opus 4.8 and Fable 5 use the Claude Agent SDK."

### R2 — Make model support a capability registry, not hardcoded branches. **[M, highest architectural leverage]**
Today, model-specific behavior is scattered: tier inference (`inferTier` in `model-discovery.ts`), output ceilings (`modelMaxOutputCeiling` in `client.ts`), thinking rules (adaptive-only for `opus-4-8`), pricing (`MODEL_COST_RATES` in `coding-budget.ts`), and beta headers. Consolidate into a single declarative table:

```
ModelCapability {
  id, aliases[], tier,                 // tier now includes 'mythos'
  contextWindow, maxOutput,
  thinking: 'adaptive' | 'budget',     // opus-4-8 + fable = adaptive-only
  supportedEfforts, effortAliases,     // max -> xhigh mapping lives here
  pricing { in, out, cacheRead, cacheWrite },
  betaHeaders[], accessGated?: boolean // fable 5 is gated
}
```
Seed it from live `/v1/models` discovery, allow `config.yaml` overrides, and have every consumer (planner guide, budget allocator, client, bridge) read from it. **Result:** adding Fable 5 (or the next model) becomes a data edit, and the "mythos" tier and gated-access handling fall out naturally.

### R3 — Make a deliberate build-vs-adopt call on orchestration. **[L, strategic]**
You now have two viable substrates: your custom layered DAG executor, and Anthropic's native **multi-agent sessions** (isolated, persistent threads; orchestrator-worker; shared sandbox). Recommended **hybrid**:
- **Keep** the spec-loader + macro/micro planner — decomposing huge multi-phase spec sets into a DAG is genuinely your differentiator and exceeds the native "20 agents, depth 1" roster.
- **Pilot** native session threads as the *execution substrate* for a sub-DAG layer, to get context isolation, persistent follow-ups, and platform-side context editing for free.
- Decide explicitly which layer owns retries, budgets, and checkpointing so responsibilities don't duplicate. Document the decision in `docs/architecture-notes.md`.

### R4 — Adopt native context editing + memory tool alongside Hindsight. **[M]**
For unattended long runs, enabling **context editing** on agent queries directly attacks context exhaustion (your `executor.ts` already enforces long timeout floors — pair them with auto-trimming). Use the **memory tool** for durable cross-session artifacts and let **Hindsight focus on what it's uniquely good at** (temporal knowledge graph, mental models, project banks). Avoid maintaining two systems that solve the *same* slice; draw the line clearly.

### R5 — Plan for execution scale-out beyond a single process. **[L]**
The executor keeps the whole graph + all node outputs in an in-process `Map`. For "enormous" plans (hundreds–thousands of nodes), this is a memory ceiling and a single point of failure. Introduce a **persistent task queue** (e.g., BullMQ/Redis) so layers can be dispatched across worker processes/machines, with the checkpoint store as the source of truth. This is what turns "big plan" into "unattended at scale."

---

## 4. Findings by area

Each table: **P0** = do soon / high impact, **P1** = important, **P2** = nice-to-have.

### 4.1 Architecture & orchestration
**Strengths:** macro/micro planning cleanly sidesteps context limits; Kahn-layered parallel execution; transient/permanent error classification with backoff+jitter and timeout floors (900s AGENT / 1800s CODING_AGENT); per-layer checkpoint/resume; strong commit-safety (hooks + post-exec preflight in `safe-commit.ts`).

| Pri | Finding | Recommendation |
|---|---|---|
| P0 | `executor.ts` (>2,500 LOC) and `coding-orchestrator.ts` (>2,100 LOC) mix execution, state, safety, artifact collection | Decompose into focused units (LayerScheduler, RetryPolicy, ArtifactCollector, CommitSafetyGate) — improves testability and readability |
| P0 | In-process graph/state Map = memory ceiling for enormous plans | R5 persistent queue + checkpoint-as-truth |
| P1 | `OrchestrationBridge` is a God-object coupling MainAgent ↔ Planner ↔ Executor | Extract a thin `DispatchCoordinator` interface; inject collaborators |
| P1 | Each macro expansion is an extra LLM round-trip | Cache sub-DAGs keyed by phase-body hash; consider streaming expansion (start early sub-layers before full expansion) |
| P2 | Spec phase detection is regex/heading-based | Augment with embedding-based chunk recall for messy specs (ties to §4.3) |

### 4.2 Model & SDK integration
| Pri | Finding | Recommendation |
|---|---|---|
| P0 | SDK pinned `0.3.165`; no `fable`/`claude-fable-5` types | R1 upgrade to ≥0.3.170 |
| P0 | Model metadata hardcoded across 3+ files | R2 capability registry |
| P1 | Tier model lacks a "mythos/above-opus" concept | Add tier in registry; update `buildModelGuide` so the planner can route hardest phases to Fable 5 / escalate |
| P1 | Fable 5 is access-gated; a run could fail mid-flight on an entitlement error | Treat "model unavailable/forbidden" as a classified, *non-retried* error with graceful fallback to next-best tier |
| P2 | `client.ts` (non-SDK fetch client) duplicates model rules the bridge also encodes | Have both read the registry |

### 4.3 Memory & context (Hindsight)
**Strengths:** tiered banks, importance scoring, hot-window ring buffer (30k-token budget), cheap-LLM compaction flush, mental models, federation.

| Pri | Finding | Recommendation |
|---|---|---|
| P1 | Recall is trigram + keyword overlap — misses semantic/synonym matches at massive scale | Add vector embeddings to `similarity.ts` recall (hybrid lexical+semantic) |
| P1 | Clear overlap with native memory tool / Managed-Agents memory | R4: define the boundary; don't double-maintain |
| P2 | `isDuplicateContent` scans can bottleneck on huge ingests | Bloom filters / blocked dedup; pre-filter banks before scoring |
| P2 | Project banks siloed; no cross-project lesson synthesis | Periodic "lessons" rollup into the `core` bank |

### 4.4 Skills system (skills-sdk)
**Strengths:** language-agnostic JSON-over-stdin contract; manifest validation; path-traversal guard; sensitive-env filtering.

| Pri | Finding | Recommendation |
|---|---|---|
| P1 | Security is **advisory** — declared ports/services validated but not sandboxed; only env-var redaction isolates child processes | Offer opt-in hardened execution (container/namespace, restricted FS view) for untrusted skills |
| P2 | No tests in `skills-sdk` | Add unit tests for loader/validator/executor (also §4.7) |
| P2 | Settings validation is shallow (`required` list) | JSON-Schema-driven config validation |

### 4.5 Security
**Strengths:** workspace-root containment (`realpathSync`) + 5MB file-read cap; body-size limits; WS payload cap; secret masking with sentinel-strip on config write; `0o600` config perms; Zod on inbound WS.

| Pri | Finding | Recommendation |
|---|---|---|
| P0 | **Auth defaults to single-user / often `mode: 'none'`; no per-session isolation.** For *unattended* runs that can clone repos, run Bash, and spend money, this is the biggest risk | Default to api-key/token auth; add per-session authorization before any unattended/cloud exposure; document a hardening checklist |
| P1 | Path/ID safety relies on regex at the persistence boundary; workspace remapping logic is complex | Centralize file-access containment into one core utility used everywhere (incl. `spec-loader`); add focused traversal tests |
| P1 | REST routes (`git.ts`, `skills.ts`) use manual `typeof`/regex validation | Extend Zod to REST bodies (parity with WS) |
| P2 | Loopback OAuth proxy/probe (`probeLocalListener`) is a controlled internal SSRF | Keep strictly loopback-scoped; add an allowlist + tests |
| P2 | SQLite event log may persist sensitive tool outputs | Scrub/redact tool outputs before persistence; consistent `audit` events for `handleBackupDb`/`handlePutConfig` |

### 4.6 UI/UX (web frontend)
**Strengths:** dual-view (chat narrative + orchestration/DAG); server-authoritative rehydration survives refresh; pop-out panes for multi-monitor; virtualized chat (`react-virtuoso`); centralized z-index; accessible live regions and 44px touch targets.

| Pri | Finding | Recommendation |
|---|---|---|
| P0 | `DAGVisualization` uses a manual fixed grid (≈350×110) — hundreds of nodes → an unnavigable canvas | Minimap, zoom-to-fit, collapse completed branches, sub-graph nesting (essential to *observe* enormous runs) |
| P0 | Intervention is limited to pause/stop | Add a "manual intervention" node type that halts a worker and opens a human-input panel in `WorkerDetail` (critical for unattended-but-recoverable runs) |
| P1 | Chat floods with tool-call cards on huge runs, burying the narrative | Group-by-agent/phase view; collapse tool storms |
| P1 | No time-series cost/throughput view | "Live budget" burn-rate ($/hr) + spend-over-time, complementing cumulative totals |
| P2 | `lib/gateway.ts` (2,000+ LOC) | Split into WSClient / SnapshotProcessor / EventHandlers |

### 4.7 Engineering, testing, build, dev-ex
**Strengths:** `strict: true` everywhere (tui uses `@tsconfig/strictest`); Vitest across core/gateway/hindsight; high-quality custom logger with truncation + telemetry hook; YAML config with `${VAR}` interpolation and `0o600`; aggressive prompt caching; budget caps.

| Pri | Finding | Recommendation |
|---|---|---|
| P0 | No tests in `skills-sdk`, `tui`, or `web`; no end-to-end TUI→Gateway→Core→Worker test | Add unit suites for skills-sdk/web; one happy-path E2E to protect the critical flow |
| P1 | Loose `any`/`Record<string,unknown>` for some WS payloads | Zod-derive shared types so runtime and compile-time agree |
| P1 | Duplicate logger/`truncate` between core and hindsight (DUP-12) | Extract a shared utility package |
| P2 | No OpenTelemetry; observability is bespoke | Add OTel/Pino sinks behind the existing telemetry hook |
| P2 | `prebuild` build-info generation is per-package | Centralize in root build; document the build-order foot-gun in one place |

### 4.8 Efficiency & cost
**Strengths:** ephemeral cache-control on system prompts + tool defs; `CodingBudgetAllocator` + `sessionMaxUsd` hard caps; role-based model selection (Haiku for cheap extraction).

| Pri | Finding | Recommendation |
|---|---|---|
| P1 | 1M-context Opus/Fable runs can get expensive fast | Surface live burn-rate (UI §4.6); registry-aware budgets; default cheaper tiers for low-complexity phases, escalate only hard phases to Opus/Fable |
| P1 | Macro re-expansion repeats token spend | Sub-DAG cache (§4.1) |
| P2 | Fast Mode (~2.5×) available for latency-sensitive phases | Make Fast Mode a per-role/per-phase option in the registry |

---

## 5. Prioritized upgrade roadmap

**Phase 0 — Unblock the mission (days).**
- R1: bump SDK to ≥0.3.170; green the suite. *(S)*
- R2 (scaffold): introduce the capability registry; migrate `opus-4-8` + add `claude-fable-5`/`fable` (with gated-access flag + mythos tier). *(M)*
- Add a non-retried "model forbidden/unavailable" error class with tier fallback (needed because Fable 5 is gated). *(S)*

**Phase 1 — Harden for unattended operation (1–2 weeks).**
- Security P0: enable auth by default + per-session authZ; centralize file containment; Zod on REST. *(M)*
- UI P0: DAG navigation (minimap/zoom/collapse) + manual-intervention node. *(M–L)*
- Testing P0: skills-sdk + web unit tests; one E2E. *(M)*
- Adopt native **context editing** on agent queries. *(S–M)*

**Phase 2 — Scale & decompose (multi-week).**
- R5: persistent distributed task queue; checkpoint-as-truth. *(L)*
- Decompose `executor.ts` / `coding-orchestrator.ts`; tame `OrchestrationBridge`. *(M–L)*
- Sub-DAG caching + (optional) streaming expansion. *(M)*

**Phase 3 — Platform alignment & intelligence (strategic).**
- R3 hybrid: pilot native multi-agent sessions as a sub-DAG substrate; document ownership of retries/budgets/checkpoints. *(L)*
- R4: vector recall in Hindsight; settle Hindsight-vs-native-memory boundary. *(M–L)*
- Skills sandboxing; OpenTelemetry. *(M)*

---

## 6. Risks & watch-outs
- **Fable 5 entitlement:** API-only and access-gated — builds must degrade gracefully when the model is unavailable, not fail an unattended run mid-plan.
- **Mythos safety posture:** `Mythos 5` (no safety classifiers) is not a drop-in; keep `Fable 5` as the orchestration default and gate any Mythos use explicitly.
- **1M-context economics:** large contexts at $5/$25 add up fast under heavy fan-out; budget guardrails + burn-rate visibility are prerequisites for unattended runs, not nice-to-haves.
- **Don't double-maintain:** the native context/memory/multi-agent primitives overlap real OrionOmega code. Decide the boundary deliberately (R3/R4) to avoid carrying two implementations of the same capability.
- **Auth before exposure:** the current single-user default is fine for local dev but must be closed before any networked/unattended deployment.

---

## 7. Bottom line
OrionOmega's foundations are strong and the mission is within reach. The fastest path to "Opus 4.8 + Fable 5 orchestrating huge unattended plans" is: **(1) upgrade the SDK, (2) make models a registry, (3) harden auth + observability for unattended operation, then (4) decide build-vs-adopt against Anthropic's new native orchestration/memory primitives.** Everything else in §4 is high-quality polish on an already-capable system.

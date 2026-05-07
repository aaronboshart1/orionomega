# Skills SDK Architecture

## Overview

The Skills SDK (`@orionomega/skills-sdk`) provides a complete lifecycle management system for OrionOmega skills. It handles skill discovery, manifest validation, settings resolution, handler execution, and configuration persistence.

## Modules

| Module | Purpose |
|--------|---------|
| `types.ts` | All TypeScript type definitions, enums, and interfaces |
| `interfaces.ts` | `ISkill` interface and `BaseSkill` abstract class |
| `settings.ts` | Settings schema extraction, resolution, validation, and secret masking |
| `loader.ts` | Skill discovery, manifest loading, dependency checking, and `ISkill` instantiation |
| `executor.ts` | Spawns handler scripts with stdin/stdout JSON communication |
| `validator.ts` | Structural and semantic manifest validation |
| `scaffold.ts` | Creates new skill directories from a built-in template |
| `skill-config.ts` | Reads and writes persisted skill configuration files |
| `index.ts` | Public API barrel export |

## Dual-Mode Loading

Skills can be implemented in two ways:

### Manifest Mode (Language-Agnostic)
Any directory with a `manifest.json` is a valid skill. Tools are executed by spawning the handler scripts listed in the manifest. This supports Bash, Python, Node.js, Go, and any language that can read stdin JSON and write stdout JSON.

### Class Mode (TypeScript-Native)
If a compiled `skill.js` exists alongside `manifest.json`, the loader imports it and uses the exported default class (which must extend `BaseSkill`) as the `ISkill` implementation. This provides typed lifecycle hooks, direct tool registration, and in-process execution.

## Settings System

The settings system provides:

1. **Schema extraction** — `getSettingsSchema()` reads the `settings` block from a manifest, or shims a legacy `setup.fields` array
2. **Resolution** — `resolveSettings()` merges manifest defaults with user-saved config
3. **Validation** — `validateSettings()` checks types, constraints, and required fields
4. **Secret masking** — `maskSecrets()` redacts password fields in API responses
5. **Secret splitting** — `splitSecrets()` separates config from secrets for secure injection

## Lifecycle

```
discoverAll() → load() → loadISkill() → initialize(ctx) → activate() → [tool calls] → deactivate() → dispose()
```

## Coding-mode Architect / Fan-out Contract

The coding-mode templates (`feature-implementation`, `refactor`,
`test-suite`, `review-iterate`) all hand the architect / analyst node a
structured `FanOutDecision` schema. The architect emits one chunk per
unit of parallel work; the orchestrator turns each chunk into a
concrete `impl-chunk-<id>` worker via
`packages/core/src/orchestration/coding/fanout-expansion.ts`.

**Chunk schema** (defined in
`packages/core/src/orchestration/coding/coding-types.ts → FanOutDecision.chunks`):

| Field                  | Type                                 | Notes                                                                 |
|------------------------|--------------------------------------|-----------------------------------------------------------------------|
| `id`                   | `string`                             | Unique; becomes `impl-chunk-<id>`.                                    |
| `label`                | `string`                             | Human-readable.                                                       |
| `fileCluster`          | `string[]`                           | Files this chunk owns exclusively (lock-acquired).                    |
| `sharedFiles`          | `string[]`                           | Files multiple chunks reference; stitcher reconciles.                 |
| `task`                 | `string`                             | Implementer instructions.                                             |
| `estimatedComplexity`  | `'low' \| 'medium' \| 'high'`        | `high` triggers a one-shot architect re-plan (see safety net below).  |
| `dependsOn` *(opt.)*   | `string[]` *(Task #174)*             | Other chunk ids this chunk waits on. Absent / empty → all-parallel.   |

**Multi-phase spec override (Task #174).** When the user task references
a `*.md` / `*.txt` / `*.spec` file containing **3 or more** `## Phase N`
/ `## Step N` / numbered top-level headings, the architect prompt
mandates **one chunk per phase** instead of the default 2–4 generic
chunks. The pre-loaded spec contents and per-phase dependency map are
inlined in the planner preamble by
`packages/core/src/agent/spec-loader.ts`. Explicit "depends on Phase N"
/ "after Phase N" / "requires Phase N" language in the spec is
extracted into the corresponding chunk's `dependsOn` array, so the
expansion engine wires the phases as serial edges; phases without such
language remain parallel siblings.

**Complexity safety net.** Before dispatching workers, the orchestrator
calls `analyzeFanOutComplexity(decision)` which (1) logs each chunk's
`estimatedComplexity` on dispatch and (2) returns a one-shot re-plan
instruction listing every `high`-tagged chunk; the architect is asked
to subdivide each into 2–4 sibling chunks (sharing the same
`dependsOn`). The re-plan is capped at one pass — pass
`{ alreadyReplanned: true }` after the second architect turn to
short-circuit further loops.

**Expansion semantics** (`expandFanOut`):

- The placeholder `impl-placeholder` node is removed; one
  `impl-chunk-<id>` node is emitted per chunk in the order the
  architect listed them.
- Each chunk node's `dependsOn` = the placeholder's original upstreams
  (e.g. `['architecture-design']`) ∪ the mapped `chunk.dependsOn`
  (chunk-id → `impl-chunk-<id>`). Self-edges and unknown references are
  stripped with a warning, never an error.
- Every successor of the placeholder (the stitcher / integration node
  in particular) has its `dependsOn` rewritten to fan-in to **all**
  chunk nodes — the join semantics that made the original placeholder
  meaningful are preserved.
- Per-chunk `fileScope.owned` / `readable` are sourced from
  `fileCluster` / `sharedFiles`.
- Duplicate chunk ids throw — the architect output is rejected loudly
  so collisions never silently collapse two phases into one node.

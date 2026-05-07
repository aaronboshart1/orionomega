/**
 * @module orchestration/coding/fanout-expansion
 *
 * Task #174: Runtime fan-out expansion for coding-mode template DAGs.
 *
 * The coding-mode template DAGs (`feature-implementation`, `refactor`,
 * `test-suite`, `review-iterate`) all carry a single `impl-placeholder`
 * CODING_AGENT node downstream of the architect / analyst node. After
 * the architect emits a {@link FanOutDecision}, this module turns that
 * placeholder into N concrete `impl-chunk-<id>` nodes:
 *
 *   - One node per chunk in `decision.chunks`.
 *   - Per-chunk `dependsOn` is composed of the placeholder's original
 *     `dependsOn` (typically `['architecture-design']`) **plus** any
 *     intra-chunk `dependsOn` declared by the architect (mapped from
 *     chunk ids → `impl-chunk-<id>` ids). This implements the
 *     inter-phase ordering for multi-phase specs.
 *   - Every node downstream of the placeholder has its `dependsOn`
 *     rewritten so each occurrence of the placeholder id is replaced
 *     by **all** chunk-node ids — preserving the join semantics.
 *
 * Also exports {@link analyzeFanOutComplexity}, the complexity safety
 * net: it scans a {@link FanOutDecision} for `high`-complexity chunks,
 * logs each chunk's complexity at dispatch, and returns whether the
 * orchestrator should request a one-shot re-plan before dispatching.
 *
 * Both helpers are pure and deterministic — they don't talk to the
 * model and don't touch disk, so they're directly unit-testable.
 */

import type { WorkflowNode, NodeStatus } from '../types.js';
import type { FanOutDecision } from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('fanout-expansion');

/** The well-known id of the placeholder node every coding template emits. */
export const FANOUT_PLACEHOLDER_ID = 'impl-placeholder';

/** Build a stable concrete node id from a chunk id. */
export function chunkNodeId(chunkId: string): string {
  return `impl-chunk-${chunkId}`;
}

/** Inputs to {@link expandFanOut}. */
export interface ExpandFanOutInput {
  /** The template DAG returned from `buildFeatureImplementationTemplate` etc. */
  template: WorkflowNode[];
  /** Architect-emitted decision driving the expansion. */
  decision: FanOutDecision;
  /** Optional override of the placeholder node id (defaults to `impl-placeholder`). */
  placeholderId?: string;
}

/**
 * Expand the placeholder node into N concrete chunk nodes.
 *
 * Returns a fresh array — does **not** mutate `input.template`.
 *
 * Behaviour:
 *   - When `decision.chunks` is empty, the template is returned
 *     unchanged (the caller likely wants to fail fast or keep the
 *     placeholder for diagnostics).
 *   - When the placeholder is missing, the template is returned
 *     unchanged with a warning logged (defensive: not every template
 *     has a placeholder; e.g. the legacy linear orchestrator path).
 *   - Per-chunk node ids are `impl-chunk-<chunk.id>`. Chunk ids are
 *     trusted to be unique — duplicates surface as a thrown error so
 *     the architect output is rejected loudly instead of silently
 *     collapsing nodes.
 *   - `chunk.dependsOn` (Task #174 addition) is mapped chunk-id →
 *     `impl-chunk-<id>` and merged onto the placeholder's original
 *     deps, so the dependent chunk only fires after BOTH its
 *     architect-side prerequisites and its phase predecessors finish.
 *   - Successor nodes that referenced the placeholder are rewritten
 *     to depend on every chunk node (fan-in). The stitcher /
 *     integration node naturally becomes the join point.
 */
export function expandFanOut(input: ExpandFanOutInput): WorkflowNode[] {
  const placeholderId = input.placeholderId ?? FANOUT_PLACEHOLDER_ID;
  const template = input.template;
  const decision = input.decision;

  const placeholder = template.find((n) => n.id === placeholderId);
  if (!placeholder) {
    log.warn('expandFanOut: placeholder not found; returning template unchanged', {
      placeholderId,
      nodeIds: template.map((n) => n.id),
    });
    return template.slice();
  }
  if (!decision.chunks || decision.chunks.length === 0) {
    log.warn('expandFanOut: empty FanOutDecision; returning template unchanged');
    return template.slice();
  }

  // Reject duplicate chunk ids loudly — silently dropping nodes is the
  // exact failure mode this expansion is supposed to prevent.
  const seen = new Set<string>();
  for (const c of decision.chunks) {
    if (seen.has(c.id)) {
      throw new Error(`expandFanOut: duplicate chunk id "${c.id}" in FanOutDecision`);
    }
    seen.add(c.id);
  }

  const chunkIdToNodeId = new Map<string, string>();
  for (const c of decision.chunks) chunkIdToNodeId.set(c.id, chunkNodeId(c.id));
  const allChunkNodeIds = decision.chunks.map((c) => chunkNodeId(c.id));

  // Build the concrete chunk nodes, preserving the placeholder's coding
  // config / model / cwd (so per-run cwd pinning + model resolution
  // survive the expansion) but overriding the per-node task with the
  // chunk-specific one.
  const chunkNodes: WorkflowNode[] = decision.chunks.map((chunk) => {
    // Per-chunk dependsOn: placeholder's upstreams + mapped intra-chunk deps.
    const intraDeps: string[] = [];
    for (const dep of chunk.dependsOn ?? []) {
      const mapped = chunkIdToNodeId.get(dep);
      if (!mapped) {
        // Unknown reference — skip with a warn; the architect output
        // is otherwise valid and we don't want to abort the whole run.
        log.warn('expandFanOut: chunk references unknown dependency', {
          chunkId: chunk.id,
          unknownDep: dep,
        });
        continue;
      }
      if (mapped === chunkNodeId(chunk.id)) continue; // self-edge guard
      intraDeps.push(mapped);
    }
    const mergedDeps = Array.from(new Set([...(placeholder.dependsOn ?? []), ...intraDeps]));

    const chunkTask = chunk.task && chunk.task.length > 0
      ? chunk.task
      : (placeholder.codingAgent?.task ?? `Implement chunk ${chunk.id}`);

    const node: WorkflowNode = {
      ...placeholder,
      id: chunkNodeId(chunk.id),
      label: chunk.label ?? `Implementation: ${chunk.id}`,
      dependsOn: mergedDeps,
      status: 'pending' as NodeStatus,
      ...(placeholder.codingAgent
        ? {
            codingAgent: {
              ...placeholder.codingAgent,
              task: chunkTask,
            },
          }
        : {}),
      ...(placeholder.codingConfig
        ? {
            codingConfig: {
              ...placeholder.codingConfig,
              task: chunkTask,
              fileScope: {
                ...(placeholder.codingConfig.fileScope ?? { owned: [], readable: [], lockRequired: true }),
                owned: chunk.fileCluster ?? [],
                readable: chunk.sharedFiles ?? [],
              },
            },
          }
        : {}),
    };
    return node;
  });

  // Rewrite every non-placeholder, non-chunk node's dependsOn so that
  // any reference to the placeholder fans in to ALL chunk nodes.
  const rewritten: WorkflowNode[] = [];
  for (const n of template) {
    if (n.id === placeholderId) continue; // dropped — replaced by chunk nodes
    if (!n.dependsOn || !n.dependsOn.includes(placeholderId)) {
      rewritten.push(n);
      continue;
    }
    const newDeps = Array.from(
      new Set([
        ...n.dependsOn.filter((d) => d !== placeholderId),
        ...allChunkNodeIds,
      ]),
    );
    rewritten.push({ ...n, dependsOn: newDeps });
  }

  // Splice the chunk nodes into the position the placeholder occupied
  // so layered ordering / topological enumeration in downstream tooling
  // sees them in a sensible spot.
  const placeholderIndex = template.findIndex((n) => n.id === placeholderId);
  const before = rewritten.filter((n) => template.findIndex((t) => t.id === n.id) < placeholderIndex);
  const after = rewritten.filter((n) => template.findIndex((t) => t.id === n.id) > placeholderIndex);
  return [...before, ...chunkNodes, ...after];
}

// ── Complexity safety net ────────────────────────────────────────────────────

/** Result of {@link analyzeFanOutComplexity}. */
export interface FanOutComplexityReport {
  /** Per-chunk (id, complexity) pairs as logged at dispatch. */
  perChunk: Array<{ id: string; estimatedComplexity: 'low' | 'medium' | 'high' }>;
  /** Chunk ids tagged `high`. */
  highComplexityIds: string[];
  /** True when at least one chunk is `high` and a re-plan should be requested. */
  requiresReplan: boolean;
  /** Human-readable reason string, ready to feed the architect re-plan turn. */
  replanInstruction: string | null;
}

// ── Deterministic in-code subdivision (Task #178) ────────────────────────────

/** Result of {@link subdivideHighComplexityChunks}. */
export interface SubdivisionReport {
  /**
   * Per original-chunk-id → list of sub-chunk ids that replaced it.
   * Entries are present only for chunks that were actually subdivided.
   * Empty when no chunks were oversized (or when subdivision was capped).
   */
  splits: Array<{ originalId: string; subIds: string[] }>;
}

/** Inputs to {@link subdivideHighComplexityChunks}. */
export interface SubdivideOptions {
  /**
   * Cap the safety net at one pass: when true, the function is a no-op
   * (returns the input decision and an empty report). Mirrors the same
   * `alreadyReplanned` flag used by {@link analyzeFanOutComplexity} so
   * callers can use the same gating signal.
   */
  alreadyReplanned?: boolean;
  /** Minimum number of siblings produced per high chunk. Default: 2. */
  minSubchunks?: number;
  /** Maximum number of siblings produced per high chunk. Default: 4. */
  maxSubchunks?: number;
}

/**
 * Task #178 — deterministic subdivision of `estimatedComplexity: 'high'`
 * chunks before dispatch.
 *
 * The Task #174 safety net asks the planner LLM to subdivide oversized
 * phases via a re-plan turn. That contract is soft — if the model
 * ignores it, the run still ends up with a giant implementer node. This
 * function enforces subdivision in code: every `high`-tagged chunk is
 * split into N (`min..max`, default 2..4) sibling chunks that:
 *
 *   - Inherit the original chunk's `dependsOn` (so phase ordering is
 *     preserved — siblings run in parallel after the same predecessors).
 *   - Partition the original `fileCluster` as evenly as possible. When
 *     the cluster is empty, every sibling shares an empty `owned` set
 *     (the implementer figures it out from the task text); when the
 *     cluster has fewer files than `minSubchunks`, N falls to the file
 *     count (still ≥ `minSubchunks=2`, hard floor).
 *   - Carry the original `sharedFiles` list verbatim — sub-tasks of the
 *     same phase still need to read the shared files.
 *   - Get a derived `task` description that names the parent and the
 *     sub-task's owned files so the implementer prompt is unambiguous.
 *   - Are tagged `estimatedComplexity: 'medium'` so the safety net does
 *     not loop on the next dispatch (defense-in-depth alongside the
 *     `alreadyReplanned` cap).
 *
 * Any other chunk whose `dependsOn` referenced the split chunk's id is
 * rewritten to fan-in to every sibling, mirroring the fan-in semantics
 * `expandFanOut` applies to placeholder successor nodes.
 *
 * The function is **pure** — it returns a fresh `FanOutDecision` and
 * never mutates the input.
 */
export function subdivideHighComplexityChunks(
  decision: FanOutDecision,
  options: SubdivideOptions = {},
): { decision: FanOutDecision; report: SubdivisionReport } {
  if (options.alreadyReplanned) {
    return { decision, report: { splits: [] } };
  }
  const minSubchunks = Math.max(2, options.minSubchunks ?? 2);
  const maxSubchunks = Math.max(minSubchunks, options.maxSubchunks ?? 4);

  const highChunks = decision.chunks.filter((c) => c.estimatedComplexity === 'high');
  if (highChunks.length === 0) {
    return { decision, report: { splits: [] } };
  }

  const splits: SubdivisionReport['splits'] = [];
  const replacementMap = new Map<string, string[]>();
  const newChunks: FanOutDecision['chunks'] = [];

  for (const chunk of decision.chunks) {
    if (chunk.estimatedComplexity !== 'high') {
      newChunks.push(chunk);
      continue;
    }

    // Decide N: clamp file count into [minSubchunks, maxSubchunks];
    // an empty cluster still produces `minSubchunks` siblings so that a
    // high-tagged chunk without explicit files (e.g. "scaffold the
    // module") still gets parallelism.
    const fileCount = chunk.fileCluster.length;
    const n = fileCount === 0
      ? minSubchunks
      : Math.min(maxSubchunks, Math.max(minSubchunks, fileCount));

    const partitions = partitionEvenly(chunk.fileCluster, n);
    const subIds: string[] = [];

    for (let i = 0; i < n; i++) {
      const subId = `${chunk.id}-part${i + 1}`;
      subIds.push(subId);
      const owned = partitions[i] ?? [];
      const fileBlurb = owned.length > 0
        ? `Files owned by this sub-task: ${owned.join(', ')}.`
        : 'No specific files pre-assigned to this sub-task — coordinate via the parent chunk\'s description.';
      const subTask =
        `Sub-task ${i + 1}/${n} of phase "${chunk.id}" (auto-subdivided ` +
        `from a high-complexity chunk by the orchestrator).\n\n` +
        `Parent task:\n${chunk.task}\n\n${fileBlurb}`;
      newChunks.push({
        id: subId,
        label: `${chunk.label} (part ${i + 1}/${n})`,
        fileCluster: owned,
        sharedFiles: chunk.sharedFiles.slice(),
        task: subTask,
        estimatedComplexity: 'medium',
        ...(chunk.dependsOn ? { dependsOn: chunk.dependsOn.slice() } : {}),
      });
    }

    splits.push({ originalId: chunk.id, subIds });
    replacementMap.set(chunk.id, subIds);
  }

  // Rewrite any remaining chunk's dependsOn references that pointed at
  // a now-split chunk so they fan-in to every sibling.
  const finalChunks: FanOutDecision['chunks'] = newChunks.map((c) => {
    if (!c.dependsOn || c.dependsOn.length === 0) return c;
    let changed = false;
    const remapped: string[] = [];
    for (const dep of c.dependsOn) {
      const subs = replacementMap.get(dep);
      if (subs) {
        changed = true;
        for (const s of subs) remapped.push(s);
      } else {
        remapped.push(dep);
      }
    }
    if (!changed) return c;
    return { ...c, dependsOn: Array.from(new Set(remapped)) };
  });

  log.info('subdivideHighComplexityChunks: split oversized chunks', {
    originalCount: decision.chunks.length,
    finalCount: finalChunks.length,
    splits,
  });

  const subdividedDecision: FanOutDecision = {
    chunks: finalChunks,
    maxParallelism: Math.max(decision.maxParallelism, finalChunks.length),
  };
  return { decision: subdividedDecision, report: { splits } };
}

/** Split `items` into `n` near-equal-length partitions. Empty arrays are filled in. */
function partitionEvenly<T>(items: T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < items.length; i++) {
    out[i % n]!.push(items[i]!);
  }
  return out;
}

/**
 * Inspect a {@link FanOutDecision} for oversized chunks, log each
 * chunk's complexity at dispatch (single structured log line — easy to
 * grep for in production), and decide whether the orchestrator should
 * trigger a one-shot architect re-plan before dispatching workers.
 *
 * The caller is responsible for actually invoking the re-plan; this
 * helper is the deterministic decision + logging side. Cap the re-plan
 * at one pass — call this helper with `alreadyReplanned: true` after
 * the second architect turn to short-circuit further loops.
 */
export function analyzeFanOutComplexity(
  decision: FanOutDecision,
  options: { alreadyReplanned?: boolean } = {},
): FanOutComplexityReport {
  const perChunk = decision.chunks.map((c) => ({
    id: c.id,
    estimatedComplexity: c.estimatedComplexity,
  }));
  const highComplexityIds = perChunk.filter((c) => c.estimatedComplexity === 'high').map((c) => c.id);

  // Single structured log line per dispatch — bug report acceptance
  // criterion: "the orchestrator logs it on dispatch".
  log.info('FanOutDecision dispatch complexity', {
    chunkCount: perChunk.length,
    highComplexityIds,
    perChunk,
  });

  const requiresReplan = !options.alreadyReplanned && highComplexityIds.length > 0;
  const replanInstruction = requiresReplan
    ? `The following chunk(s) were tagged \`estimatedComplexity: "high"\` and are too large for a single ` +
      `implementer in one shot: ${highComplexityIds.join(', ')}. Subdivide each into 2–4 sibling chunks ` +
      `that share the same \`dependsOn\`, then re-emit the FanOutDecision JSON. Cap subdivision at one ` +
      `pass — do not recurse.`
    : null;

  return { perChunk, highComplexityIds, requiresReplan, replanInstruction };
}

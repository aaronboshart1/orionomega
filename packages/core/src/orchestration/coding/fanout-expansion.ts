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

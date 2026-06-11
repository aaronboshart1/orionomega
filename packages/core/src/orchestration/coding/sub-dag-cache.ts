/**
 * @module orchestration/coding/sub-dag-cache
 *
 * Task #239: Sub-DAG caching for hierarchical macro planning.
 *
 * Each MACRO_NODE expansion (Task #197) is a separate planner LLM
 * round-trip. Re-expanding an identical phase — the same phase body
 * dispatched again within a long-lived bridge, or a retried run — repeats
 * that token spend for no benefit. This cache stores the sub-DAG produced
 * for a given phase, keyed primarily by a hash of the phase BODY (the
 * thing the task asks us to key on), so an identical phase reuses the
 * cached sub-DAG instead of calling the planner again.
 *
 * Correctness notes:
 *   - The cache key folds in the discriminators that actually change the
 *     sub-planner output (phase id, model, repo preamble, upstream-phase
 *     summary) alongside the phase body. A body change therefore always
 *     produces a different key (correct invalidation), and a stale entry
 *     can never be served for a different phase id / model / context.
 *   - Cached nodes are DEEP-CLONED on both `set` and `get`. The executor
 *     mutates each sub-DAG's `dependsOn` arrays in place while splicing
 *     (inbound/outbound rewire); returning the stored copy directly would
 *     corrupt the cache for the next hit.
 */

import { createHash } from 'node:crypto';
import type { WorkflowNode, MacroExpansionResult } from '../types.js';

/** Inputs that fully determine a sub-DAG expansion. */
export interface SubDagCacheKeyInput {
  /** Verbatim phase body — the primary invalidation lever. */
  phaseBody: string;
  /** Stable phase id (drives the spliced node-id prefix). */
  phaseId: string;
  /** Resolved planner model id. */
  model: string;
  /** Repository preamble inherited from the parent run. */
  repoPreamble?: string;
  /** Compact upstream-phase summary, if any. */
  upstreamPhaseSummary?: string;
}

type CachedUsage = NonNullable<MacroExpansionResult['usage']>;

interface CacheEntry {
  nodes: WorkflowNode[];
  usage?: CachedUsage;
}

/** Observable counters for logging / run-summary surfacing. */
export interface SubDagCacheStats {
  hits: number;
  misses: number;
  /** Current number of distinct entries held. */
  size: number;
  /** Entries dropped because the cache exceeded `maxEntries`. */
  evictions: number;
}

/** What a cache hit returns: cloned nodes plus the original pass usage. */
export interface SubDagCacheHit {
  nodes: WorkflowNode[];
  usage?: CachedUsage;
}

/**
 * Bounded, in-memory LRU cache of expanded sub-DAGs keyed by phase-body
 * hash. Intentionally process-local: it lives on the long-lived
 * {@link Planner} instance (constructed once in the orchestration bridge),
 * so repeated identical phases reuse the cached sub-DAG across runs for the
 * lifetime of the gateway process.
 */
export class SubDagCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? 256);
  }

  /**
   * Compute the cache key for a phase expansion. The phase body is the
   * primary lever (any body edit changes the digest), with the
   * output-affecting discriminators folded in. NUL separators prevent
   * field-boundary collisions (e.g. body ending in the next field's text).
   */
  keyFor(input: SubDagCacheKeyInput): string {
    const h = createHash('sha256');
    h.update('phaseId\0');
    h.update(input.phaseId);
    h.update('\0model\0');
    h.update(input.model);
    h.update('\0preamble\0');
    h.update(input.repoPreamble ?? '');
    h.update('\0upstream\0');
    h.update(input.upstreamPhaseSummary ?? '');
    h.update('\0body\0');
    h.update(input.phaseBody);
    return h.digest('hex');
  }

  /**
   * Look up a cached sub-DAG. Returns a DEEP CLONE so the caller (and the
   * executor's in-place splice) can never corrupt the stored copy. Records
   * a hit or miss for observability.
   */
  get(key: string): SubDagCacheHit | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    // LRU touch: re-insert at the tail so the recently-used entry survives
    // eviction longest.
    this.store.delete(key);
    this.store.set(key, entry);
    return {
      nodes: structuredClone(entry.nodes),
      usage: entry.usage ? { ...entry.usage } : undefined,
    };
  }

  /**
   * Store a freshly expanded sub-DAG under `key`. The nodes are cloned on
   * the way in so subsequent mutation of the caller's copy (the executor
   * splice) doesn't reach back into the cache. Evicts the oldest entries
   * when over capacity.
   */
  set(key: string, nodes: WorkflowNode[], usage?: CachedUsage): void {
    // Delete-then-set guarantees the entry lands at the Map's tail
    // (newest), keeping insertion order == recency order for eviction.
    this.store.delete(key);
    this.store.set(key, {
      nodes: structuredClone(nodes),
      usage: usage ? { ...usage } : undefined,
    });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions += 1;
    }
  }

  /** Snapshot of hit/miss/size/eviction counters. */
  stats(): SubDagCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.store.size,
      evictions: this.evictions,
    };
  }

  /** Drop all entries (counters are preserved). */
  clear(): void {
    this.store.clear();
  }
}

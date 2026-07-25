/**
 * @module memory/memory-tools
 * The agent-facing memory tools (docs/memory-architecture-v2.md §11).
 *
 * Three tools rather than one with an `op` discriminator: separate schemas
 * describe distinct operations far more legibly to the model, and the tool
 * surface here is small enough that three names cost nothing.
 *
 *   memory_search — ranked snippets across scopes
 *   memory_read   — a contiguous verbatim span (what search fragments cannot give)
 *   memory_pin    — durable facts that always load
 *
 * ── WHY THE GUARDS ARE NOT OPTIONAL ───────────────────────────────────────
 *
 * The conversation loop is `for (let round = 0; ; round++)` with NO round cap,
 * and its circuit breaker only counts results starting with `"Error:"`. A
 * search that finds nothing returns a SUCCESS string — and success *decrements*
 * the breaker's counter. An agent that reaches for memory, finds nothing, and
 * rephrases can therefore loop indefinitely, replaying the whole message array
 * each round.
 *
 * So three things are enforced here, not left to the model's judgement:
 *
 *   1. A zero-result search returns an explicit, machine-readable NO_RESULTS
 *      marker with corpus stats, so "nothing is there" is distinguishable from
 *      "your query was bad".
 *   2. A per-turn call budget, after which the tools hard-refuse.
 *   3. Byte ceilings with explicit continuation markers, so an unbounded span
 *      read cannot pull an arbitrary fraction of the session back into context
 *      and defeat the dynamic window entirely.
 */

import { createLogger } from '../logging/logger.js';
import type { RedisMemoryStore } from './redis-store.js';

const log = createLogger('memory-tools');

/** An in-process tool the main agent can call. */
export interface MemoryTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** How a tool call ended, as reported to {@link MemoryToolOptions.onEvent}. */
export type MemoryToolOutcome = 'ok' | 'no_results' | 'refused' | 'error';

export interface MemoryToolOptions {
  /** Scope used when a call does not name one. */
  defaultScope: string;
  /** Max memory_search calls per turn. Default 3. */
  maxSearchesPerTurn?: number;
  /** Max memory_read calls per turn. Default 2. */
  maxReadsPerTurn?: number;
  /** Byte ceiling per tool result. Default 30 000, matching read_file/exec. */
  maxChars?: number;
  /**
   * Reports each tool call so the memory feed can show agent-initiated access.
   *
   * Without this, the three tools that ARE the agent-facing memory system are
   * invisible: the feed shows the retain/recall the framework performs on the
   * agent's behalf, but nothing the agent asks for itself.
   *
   * Never throws into the caller — a reporting failure must not fail the tool.
   */
  onEvent?: (event: {
    tool: string;
    detail: string;
    scope: string;
    outcome: MemoryToolOutcome;
    meta?: Record<string, unknown>;
  }) => void;
}

const DEFAULT_MAX_SEARCHES = 3;
const DEFAULT_MAX_READS = 2;
/** Mirrors the inline caps read_file and exec already use. */
const DEFAULT_MAX_CHARS = 30_000;
/** Per-snippet ceiling in search results, so one huge record cannot crowd out the rest. */
const SNIPPET_CHARS = 600;
const DEFAULT_SEARCH_LIMIT = 8;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Trim to a byte ceiling, appending an explicit marker rather than truncating silently. */
function capped(body: string, maxChars: number, more: string): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars — ${more}]`;
}

/**
 * Build a fresh toolset for ONE turn.
 *
 * The call budget lives in this closure, so a new turn gets a new allowance and
 * the counters can never leak across turns.
 */
export function buildMemoryTools(store: RedisMemoryStore, opts: MemoryToolOptions): MemoryTool[] {
  const maxSearches = opts.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES;
  const maxReads = opts.maxReadsPerTurn ?? DEFAULT_MAX_READS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  let searches = 0;
  let reads = 0;

  const scopeOf = (args: Record<string, unknown>): string =>
    typeof args.scope === 'string' && args.scope ? args.scope : opts.defaultScope;

  const memory_search: MemoryTool = {
    name: 'memory_search',
    description:
      'Search prior conversation and stored memory by relevance. Returns ranked snippets with their seq numbers. ' +
      'Use memory_read to pull the full surrounding context for a result. ' +
      'NOTE: tool results (file contents, command output) are stored but NOT searchable — reach them with memory_read.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        scope: { type: 'string', description: 'Memory scope. Defaults to the current conversation.' },
        limit: { type: 'number', description: `Max results (default ${DEFAULT_SEARCH_LIMIT}).` },
        minRelevance: { type: 'number', description: 'Relevance floor 0–1 (default 0.15).' },
      },
      required: ['query'],
    },
    async execute(args) {
      if (++searches > maxSearches) {
        return (
          `REFUSED — memory_search limit reached for this turn (${maxSearches}). ` +
          `Repeated searching will not surface new results. Work with what you have, ` +
          `or use memory_read on a segment from the MEMORY MAP.`
        );
      }

      const query = String(args.query ?? '').trim();
      if (!query) return 'Error: memory_search requires a non-empty query.';

      const scope = scopeOf(args);
      const limit = Math.max(1, Math.min(50, Number(args.limit) || DEFAULT_SEARCH_LIMIT));
      const minRelevance = Number.isFinite(Number(args.minRelevance))
        ? Number(args.minRelevance)
        : undefined;

      try {
        const out = await store.recall(scope, query, {
          ...(minRelevance !== undefined ? { minRelevance } : {}),
          maxTokens: 100_000, // the byte cap below is the real bound
        });

        if (out.records.length === 0) {
          // Explicit and machine-readable: the loop guard depends on the model
          // being able to tell "empty corpus" from "bad query".
          return (
            `NO_RESULTS — searched ${store.indexSize.toLocaleString('en-US')} indexed records ` +
            `in scope '${scope}' at relevance >= ${minRelevance ?? 0.15}; nothing matched "${clip(query, 120)}".\n` +
            `Do not retry the same query. Either broaden the terms once, or use memory_read ` +
            `on a segment listed in the MEMORY MAP.`
          );
        }

        const shown = out.records.slice(0, limit);
        const head =
          `${shown.length} of ${out.records.length} result(s) for "${clip(query, 120)}" in scope '${scope}':`;
        const body = shown
          .map(
            (r) =>
              `[relevance ${r.relevance.toFixed(2)} · ${r.context || 'record'} · ${r.timestamp.slice(0, 10)}]\n` +
              clip(r.content, SNIPPET_CHARS),
          )
          .join('\n\n');

        return capped(
          `${head}\n\n${body}`,
          maxChars,
          `${out.records.length - shown.length} further result(s) not shown; narrow the query`,
        );
      } catch (err) {
        log.warn('memory_search failed', { error: err instanceof Error ? err.message : String(err) });
        return `Error: memory_search failed — ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const memory_read: MemoryTool = {
    name: 'memory_read',
    description:
      'Read a contiguous span of memory verbatim, in order. Address it either by segment id from the MEMORY MAP ' +
      '(e.g. "seg:core:4") or by a centre point and radius. This is how you retrieve full context around a ' +
      'search hit, and the only way to reach stored tool output.',
    inputSchema: {
      type: 'object',
      properties: {
        segment: { type: 'string', description: 'Segment id from the MEMORY MAP, e.g. "seg:core:4".' },
        around: { type: 'number', description: 'Centre seq to read around.' },
        radius: { type: 'number', description: 'How many seq either side of `around` (default 10, max 100).' },
        scope: { type: 'string', description: 'Memory scope. Defaults to the current conversation.' },
      },
    },
    async execute(args) {
      if (++reads > maxReads) {
        return (
          `REFUSED — memory_read limit reached for this turn (${maxReads}). ` +
          `Pulling more history would displace the context you already have.`
        );
      }

      const scope = scopeOf(args);
      try {
        let from: number;
        let to: number;
        let label: string;

        if (typeof args.segment === 'string' && args.segment) {
          const segments = await store.listSegments(scope);
          const found = segments.find((s) => s.id === args.segment);
          if (!found) {
            return (
              `Error: no segment '${args.segment}' in scope '${scope}'. ` +
              `Known segments: ${segments.map((s) => s.id).join(', ') || '(none)'}.`
            );
          }
          from = found.from;
          to = found.to;
          label = `${found.id} (${found.label})`;
        } else if (Number.isFinite(Number(args.around))) {
          const centre = Number(args.around);
          const radius = Math.max(1, Math.min(100, Number(args.radius) || 10));
          from = centre - radius;
          to = centre + radius;
          label = `seq ${from}–${to}`;
        } else {
          return 'Error: memory_read requires either `segment` or `around`.';
        }

        const records = await store.range(scope, from, to);
        if (records.length === 0) {
          return `NO_RECORDS — nothing in scope '${scope}' within ${label}.`;
        }

        const head = `${records.length} record(s) from ${label} in scope '${scope}':`;
        const body = records
          .map((r) => `[seq ${r.seq} · ${r.context || 'record'} · ${r.timestamp.slice(0, 10)}]\n${r.content}`)
          .join('\n\n');

        const last = records[records.length - 1]!;
        return capped(
          `${head}\n\n${body}`,
          maxChars,
          `continue with {around: ${last.seq + 1}, radius: 10}`,
        );
      } catch (err) {
        log.warn('memory_read failed', { error: err instanceof Error ? err.message : String(err) });
        return `Error: memory_read failed — ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const memory_pin: MemoryTool = {
    name: 'memory_pin',
    description:
      'Record a durable fact that should always be loaded — a stable preference, decision, or constraint. ' +
      'Keyed by a short name, so re-pinning the same key revises it rather than accumulating duplicates. ' +
      'Use sparingly: pins are injected on every turn.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short stable name, e.g. "deploy-target".' },
        content: { type: 'string', description: 'The fact. Omit to remove the pin.' },
        scope: { type: 'string', description: 'Memory scope. Defaults to the current conversation.' },
      },
      required: ['key'],
    },
    async execute(args) {
      const scope = scopeOf(args);
      const key = String(args.key ?? '').trim();
      if (!key) return 'Error: memory_pin requires a `key`.';

      try {
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (!content) {
          await store.unpin(scope, key);
          return `Removed pin '${key}' from scope '${scope}'.`;
        }
        await store.pin(scope, key, content);
        const total = (await store.listPins(scope)).length;
        return `Pinned '${key}' in scope '${scope}' (${total} pin(s) total).`;
      } catch (err) {
        log.warn('memory_pin failed', { error: err instanceof Error ? err.message : String(err) });
        return `Error: memory_pin failed — ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  return [memory_search, memory_read, memory_pin].map(instrument);

  /**
   * Wrap a tool so every call is reported once, from one place.
   *
   * Reporting at each `return` inside the tools would mean touching a dozen
   * exit points and would drift the first time one is added.
   *
   * The outcome is read from the result's leading marker. That is a real
   * coupling, but not an incidental one: `REFUSED`, `NO_RESULTS` and `Error:`
   * are the tools' documented protocol with the model — the loop guard already
   * depends on the model distinguishing them — so they are load-bearing
   * strings rather than log prose. `outcomeOf` is pinned by tests.
   */
  function instrument(tool: MemoryTool): MemoryTool {
    const onEvent = opts.onEvent;
    if (!onEvent) return tool;

    return {
      ...tool,
      async execute(args) {
        const started = Date.now();
        const scope = scopeOf(args);
        const report = (outcome: MemoryToolOutcome, detail: string) => {
          try {
            onEvent({
              tool: tool.name,
              detail,
              scope,
              outcome,
              meta: {
                durationMs: Date.now() - started,
                ...(typeof args.query === 'string' ? { query: args.query } : {}),
                ...(typeof args.segment === 'string' ? { segment: args.segment } : {}),
                ...(typeof args.key === 'string' ? { key: args.key } : {}),
              },
            });
          } catch (err) {
            // A broken reporter must not fail the agent's memory access.
            log.warn('memory tool event reporting failed', {
              tool: tool.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        };

        let result: string;
        try {
          result = await tool.execute(args);
        } catch (err) {
          // The tools catch internally, so this is a defect rather than an
          // expected path — report it and let it propagate unchanged.
          report('error', `${tool.name} threw — ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }

        const outcome = outcomeOf(result);
        report(outcome, describe(tool.name, outcome, args, result));
        return result;
      },
    };
  }
}

/** Classify a tool result by its documented leading marker. */
export function outcomeOf(result: string): MemoryToolOutcome {
  if (result.startsWith('REFUSED')) return 'refused';
  if (result.startsWith('NO_RESULTS')) return 'no_results';
  if (result.startsWith('Error:')) return 'error';
  return 'ok';
}

/** One human-readable line per tool call, for the memory feed. */
function describe(
  tool: string,
  outcome: MemoryToolOutcome,
  args: Record<string, unknown>,
  result: string,
): string {
  const subject =
    typeof args.query === 'string' && args.query ? `"${clip(args.query, 60)}"`
      : typeof args.segment === 'string' && args.segment ? args.segment
        : typeof args.key === 'string' && args.key ? `'${args.key}'`
          : '';

  switch (outcome) {
    case 'refused':
      return `${tool} refused — per-turn call budget spent`;
    case 'no_results':
      return `${tool} found nothing for ${subject || 'the query'}`;
    case 'error':
      return `${tool} failed${subject ? ` for ${subject}` : ''}`;
    case 'ok': {
      // The count is already in the result's first line; reuse it rather than
      // recomputing and risking a number that disagrees with what the agent saw.
      const head = result.split('\n', 1)[0] ?? '';
      const count = /^(\d+) of (\d+) result/.exec(head);
      if (count) return `${tool} returned ${count[1]} of ${count[2]} result(s) for ${subject}`;
      return subject ? `${tool} ${subject}` : tool;
    }
  }
}

/**
 * @module orchestration/native-session-substrate
 *
 * Task #240 (roadmap R3) — PILOT: Anthropic native multi-agent sessions as a
 * sub-DAG substrate.
 *
 * OrionOmega normally executes a layer of independent CODING_AGENT nodes with
 * its own per-node dispatch loop ({@link GraphExecutor.executeNode} →
 * {@link executeCodingAgent}), one isolated `query()` per node. This module is
 * an *experimental alternative* that runs ONE eligible layer through Anthropic's
 * **native** multi-agent sessions instead: a single `query()` call carrying an
 * `agents` roster (one {@link AgentDefinition} per node) plus a coordinator
 * prompt that delegates each node's task to its named subagent via the Task
 * tool.
 *
 * What the platform owns in this mode (the reason to pilot it):
 *  - **Context isolation** — each subagent runs in its own context window. The
 *    coordinator only ever sees a subagent's *final report*, never its full
 *    transcript, so one node's tool spam can't crowd out another's context.
 *    OrionOmega gets this for free instead of hand-rolling per-node `query()`s.
 *  - **Session threading + persistent follow-ups** — the session is persisted
 *    (`persistSession: true`) and its id captured, so a follow-up can `resume`
 *    the very same thread (see {@link submitNativeSessionFollowUp}) — the
 *    coordinator remembers what each subagent did.
 *  - **Native context editing** — the SDK's auto-compaction applies to the
 *    coordinator thread just like the per-node path.
 *
 * What OrionOmega's executor keeps owning (deliberately NOT delegated):
 *  - retries / model fallback (the executor re-dispatches failed nodes),
 *  - per-run budgets and wall-clock timeouts,
 *  - DAG checkpointing + artifact collection.
 *
 * This file is intentionally **git-free and SDK-injectable**: the real
 * `query()` is the default, but every entry point accepts a `queryFn` so the
 * eligibility gate, roster construction, coordinator-report parsing and result
 * mapping are unit-testable against a fake message stream with no live API.
 *
 * The whole substrate is gated behind `agentSdk.nativeSessions.enabled` (OFF by
 * default). When disabled, the executor never calls into here and behaves
 * exactly as before.
 */

import type { AgentDefinition, Settings } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../logging/logger.js';

const log = createLogger('native-session');

/** Resolved, defaulted native-session pilot config. */
export interface NativeSessionConfig {
  enabled: boolean;
  maxAgentsPerLayer: number;
}

const DEFAULT_MAX_AGENTS_PER_LAYER = 8;

/**
 * Normalise the raw `agentSdk.nativeSessions` config block into a fully
 * defaulted shape. Missing/undefined → disabled. The cap is clamped to >=1 so
 * a misconfigured `0` can't silently disable eligibility for every layer.
 */
export function resolveNativeSessionConfig(
  raw: { enabled?: boolean; maxAgentsPerLayer?: number } | undefined,
): NativeSessionConfig {
  const enabled = raw?.enabled === true;
  const rawCap = raw?.maxAgentsPerLayer;
  const maxAgentsPerLayer =
    typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap >= 1
      ? Math.floor(rawCap)
      : DEFAULT_MAX_AGENTS_PER_LAYER;
  return { enabled, maxAgentsPerLayer };
}

/** Minimal node shape the eligibility gate needs. */
export interface EligibilityNode {
  id: string;
  type: string;
}

export interface EligibilityVerdict {
  eligible: boolean;
  /** Human-readable explanation, surfaced in logs/telemetry. */
  reason: string;
}

/**
 * Decide whether a runnable layer should be executed via the native
 * multi-agent session substrate.
 *
 * A layer is eligible iff:
 *  1. the pilot flag is on,
 *  2. it has >= 2 runnable nodes (a single node gains nothing from a
 *     coordinator — the regular per-node path is strictly simpler), and
 *  3. every node is a CODING_AGENT (the only node type the substrate models),
 *  4. the node count does not exceed `maxAgentsPerLayer`.
 *
 * The gate is intentionally conservative: anything it can't model cleanly
 * falls back to the in-house path, so the pilot never changes behaviour for
 * mixed or oversized layers.
 */
export function evaluateLayerEligibility(
  nodes: readonly EligibilityNode[],
  config: NativeSessionConfig,
): EligibilityVerdict {
  if (!config.enabled) {
    return { eligible: false, reason: 'native-sessions disabled' };
  }
  if (nodes.length < 2) {
    return {
      eligible: false,
      reason: `layer has ${nodes.length} runnable node(s); need >= 2`,
    };
  }
  const nonCoding = nodes.filter((n) => n.type !== 'CODING_AGENT');
  if (nonCoding.length > 0) {
    return {
      eligible: false,
      reason: `layer contains ${nonCoding.length} non-CODING_AGENT node(s) (${nonCoding
        .map((n) => `${n.id}:${n.type}`)
        .join(', ')})`,
    };
  }
  if (nodes.length > config.maxAgentsPerLayer) {
    return {
      eligible: false,
      reason: `layer has ${nodes.length} nodes > maxAgentsPerLayer ${config.maxAgentsPerLayer}`,
    };
  }
  return {
    eligible: true,
    reason: `${nodes.length} CODING_AGENT node(s) eligible for native multi-agent session`,
  };
}

/** One node's contribution to the native session. */
export interface NativeSessionNodeSpec {
  /** Graph node id — the correlation key threaded through the coordinator. */
  nodeId: string;
  /** Human-readable label (used for the agent description). */
  label: string;
  /** The fully-resolved task prompt (already includes upstream context). */
  task: string;
  /** Allowed tools for this node's subagent. Omit to inherit all. */
  tools?: string[];
  /** Model alias / id for this node's subagent. Omit to inherit the main model. */
  model?: string;
  /** Optional role system prompt prepended to the subagent's instructions. */
  roleSystemPrompt?: string;
}

/**
 * Sanitise a node id into a valid SDK agent name. Agent names are referenced by
 * the coordinator's Task tool, so we keep them filename-safe and deterministic.
 */
export function agentNameForNode(nodeId: string): string {
  const cleaned = nodeId.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `node-${cleaned || 'unnamed'}`;
}

/**
 * Build the `agents` roster passed to `query({ options: { agents } })`. One
 * {@link AgentDefinition} per node. Each agent's `prompt` is its system prompt
 * (role guidance + an instruction to do exactly its assigned task and report a
 * concise result); the *concrete* task is also handed to the coordinator (see
 * {@link buildCoordinatorPrompt}) so delegation is unambiguous.
 */
export function buildAgentRoster(
  specs: readonly NativeSessionNodeSpec[],
): Record<string, AgentDefinition> {
  const roster: Record<string, AgentDefinition> = {};
  for (const spec of specs) {
    const name = agentNameForNode(spec.nodeId);
    const promptParts: string[] = [];
    if (spec.roleSystemPrompt && spec.roleSystemPrompt.trim()) {
      promptParts.push(spec.roleSystemPrompt.trim());
    }
    promptParts.push(
      `You are the dedicated agent for workflow node "${spec.nodeId}" (${spec.label}).`,
      'Complete ONLY the task the coordinator delegates to you. Work independently in ' +
        'your own isolated context. When finished, reply with a concise summary of what ' +
        'you changed and any file paths you wrote — this summary is the only thing the ' +
        'coordinator sees from you.',
    );
    const def: AgentDefinition = {
      description: `Executes node ${spec.nodeId}: ${spec.label}`.slice(0, 280),
      prompt: promptParts.join('\n\n'),
    };
    if (spec.tools && spec.tools.length > 0) def.tools = [...spec.tools];
    if (spec.model) def.model = spec.model;
    roster[name] = def;
  }
  return roster;
}

/**
 * Build the coordinator (main-thread) prompt. It instructs the model to fan the
 * independent tasks out to their named subagents via the Task tool — preserving
 * native context isolation — and to emit a single machine-readable JSON report
 * at the end so the executor can map results back onto graph nodes.
 */
export function buildCoordinatorPrompt(specs: readonly NativeSessionNodeSpec[]): string {
  const lines: string[] = [];
  lines.push(
    'You are the COORDINATOR of a native multi-agent session. You have a roster of ' +
      'specialised subagents, one per independent task below. These tasks have NO ' +
      'dependencies on each other and must each run in their OWN subagent so their ' +
      'contexts stay isolated.',
    '',
    'For EACH task: invoke its subagent with the Task tool, passing the task description ' +
      'verbatim. Do the work through the subagents — do not attempt the tasks yourself in ' +
      'the main thread. You may run the subagents concurrently.',
    '',
    '## Tasks',
  );
  for (const spec of specs) {
    const name = agentNameForNode(spec.nodeId);
    lines.push('');
    lines.push(`### Node \`${spec.nodeId}\` → subagent \`${name}\` (${spec.label})`);
    lines.push(spec.task.trim());
  }
  lines.push('');
  lines.push('## Final report (REQUIRED)');
  lines.push(
    'After every subagent has finished, output EXACTLY ONE fenced JSON code block (and ' +
      'nothing after it) describing the outcome of each node. Use this schema:',
  );
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "results": [');
  lines.push(
    '    { "nodeId": "<node id>", "status": "done" | "error", ' +
      '"summary": "<one-paragraph result>", "outputPaths": ["<files written>"] }',
  );
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push(
    'Include one entry per node id listed above. Mark a node "error" (with the reason in ' +
      '"summary") if its subagent could not complete the task. Do not omit any node.',
  );
  return lines.join('\n');
}

/** Loosely-typed SDK message — only the fields the substrate reads. */
export interface NativeSessionSdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  description?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Injectable query function — the real `query()` by default. */
export type NativeSessionQueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<NativeSessionSdkMessage>;

const defaultQueryFn: NativeSessionQueryFn = (args) => {
  // Lazily load the SDK so this module stays SDK-free at import time (the
  // executor static-imports it for the synchronous eligibility helpers). Mirrors
  // the executor's dynamic import of executeCodingAgent.
  async function* run(): AsyncGenerator<NativeSessionSdkMessage> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const iterable = query(
      args as unknown as Parameters<typeof query>[0],
    ) as unknown as AsyncIterable<NativeSessionSdkMessage>;
    for await (const message of iterable) yield message;
  }
  return run();
};

export interface NativeSessionProgress {
  type: 'status' | 'thinking' | 'tool' | 'done' | 'error';
  message: string;
}

/** Aggregated usage drained from one query stream. */
interface DrainedQuery {
  sessionId: string | null;
  text: string;
  finalResult: string | null;
  toolCalls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  errored: boolean;
  errorMessage?: string;
}

/**
 * Iterate a query stream once, accumulating text, tool calls, token usage, the
 * session id and a terminal result. Shared by the layer dispatch and the
 * follow-up path so both parse the stream identically.
 */
async function drainQuery(
  iterable: AsyncIterable<NativeSessionSdkMessage>,
  onProgress?: (p: NativeSessionProgress) => void,
): Promise<DrainedQuery> {
  const acc: DrainedQuery = {
    sessionId: null,
    text: '',
    finalResult: null,
    toolCalls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    errored: false,
  };

  for await (const message of iterable) {
    if (message.session_id && !acc.sessionId) acc.sessionId = message.session_id;

    if (message.type === 'assistant' && message.message) {
      const usage = message.message.usage;
      if (usage) {
        acc.inputTokens += usage.input_tokens ?? 0;
        acc.outputTokens += usage.output_tokens ?? 0;
        acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        acc.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      }
      for (const block of message.message.content ?? []) {
        if (block.type === 'text' && block.text) {
          acc.text += block.text + '\n';
        } else if (block.type === 'thinking' && block.thinking) {
          onProgress?.({ type: 'thinking', message: block.thinking.slice(0, 200) });
        } else if (block.type === 'tool_use') {
          acc.toolCalls++;
          onProgress?.({ type: 'tool', message: `Tool: ${block.name ?? 'unknown'}` });
        }
      }
    } else if (message.type === 'system') {
      if (message.subtype === 'task_started') {
        onProgress?.({ type: 'status', message: `Subagent started: ${message.description ?? ''}` });
      } else if (message.subtype === 'task_progress') {
        onProgress?.({ type: 'status', message: `Subagent progress: ${message.description ?? ''}` });
      }
    } else if (message.type === 'result') {
      if (typeof message.total_cost_usd === 'number') acc.costUsd = message.total_cost_usd;
      if (message.subtype && message.subtype !== 'success') {
        acc.errored = true;
        acc.errorMessage = `SDK result ${message.subtype}`;
      } else if (message.result) {
        acc.finalResult = message.result;
        acc.text += '\n' + message.result;
      }
    }
  }
  return acc;
}

/** Per-node outcome parsed from the coordinator's JSON report. */
export interface ParsedNodeReport {
  status: 'done' | 'error';
  summary: string;
  outputPaths: string[];
}

/**
 * Extract the coordinator's final JSON report from its text output and map it
 * to per-node outcomes. Fails CLOSED: any node missing from the report — or a
 * report that doesn't parse at all — is marked `error`, so the executor's
 * normal retry/fallback path handles it rather than silently "succeeding".
 */
export function parseCoordinatorReport(
  text: string,
  expectedNodeIds: readonly string[],
): { results: Map<string, ParsedNodeReport>; parsed: boolean } {
  const results = new Map<string, ParsedNodeReport>();
  const raw = extractJsonReport(text);
  let parsed = false;
  if (raw) {
    try {
      const obj = JSON.parse(raw) as { results?: unknown };
      const entries = Array.isArray(obj.results) ? obj.results : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const nodeId = typeof e.nodeId === 'string' ? e.nodeId : undefined;
        if (!nodeId) continue;
        const status = e.status === 'error' ? 'error' : 'done';
        const summary = typeof e.summary === 'string' ? e.summary : '';
        const outputPaths = Array.isArray(e.outputPaths)
          ? e.outputPaths.filter((p): p is string => typeof p === 'string')
          : [];
        results.set(nodeId, { status, summary, outputPaths });
      }
      parsed = entries.length > 0;
    } catch (err) {
      log.warn(
        `Failed to parse coordinator report JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fail closed for any expected node the report didn't cover.
  for (const nodeId of expectedNodeIds) {
    if (!results.has(nodeId)) {
      results.set(nodeId, {
        status: 'error',
        summary: parsed
          ? 'Coordinator report omitted this node — treated as failed.'
          : 'Coordinator produced no parseable result report — treated as failed.',
        outputPaths: [],
      });
    }
  }
  return { results, parsed };
}

/** Pull the last fenced ```json block, or a bare object containing "results". */
function extractJsonReport(text: string): string | null {
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(text)) !== null) {
    const body = match[1].trim();
    if (body.includes('"results"')) last = body;
  }
  if (last) return last;

  // Fallback: find the last balanced {...} that mentions "results".
  const idx = text.lastIndexOf('"results"');
  if (idx === -1) return null;
  const start = text.lastIndexOf('{', idx);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface NativeSessionNodeResult {
  nodeId: string;
  success: boolean;
  output: string;
  error?: string;
  outputPaths: string[];
  toolCalls: number;
  costUsd: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface NativeSessionLayerResult {
  /** The persisted session id (for follow-ups), or null if none surfaced. */
  sessionId: string | null;
  /** Per-node outcomes, keyed by node id. */
  perNode: Map<string, NativeSessionNodeResult>;
  /** True iff the coordinator emitted a parseable report. */
  reportParsed: boolean;
  /** Aggregate cost for the whole session. */
  totalCostUsd: number;
  /** Total tool calls observed across the session. */
  totalToolCalls: number;
  /** The coordinator's combined text output (for diagnostics/artifacts). */
  rawOutput: string;
}

export interface ExecuteNativeSessionLayerOptions {
  specs: NativeSessionNodeSpec[];
  cwd: string;
  apiKey: string;
  /** Main/coordinator model. */
  model: string;
  effort?: string;
  maxBudgetUsd?: number;
  runDir?: string;
  abortSignal?: AbortSignal;
  /** SDK Settings (e.g. context-editing). Passed through verbatim. */
  settings?: Settings;
  onProgress?: (p: NativeSessionProgress) => void;
  /** Injectable for tests. Defaults to the real SDK `query()`. */
  queryFn?: NativeSessionQueryFn;
}

/**
 * Run one eligible layer as a SINGLE native multi-agent session.
 *
 * Builds the roster + coordinator prompt, fires one `query()` with
 * `persistSession: true`, drains the stream, parses the coordinator's report,
 * and maps each node to a {@link NativeSessionNodeResult}. The aggregate token
 * usage / cost is split evenly across the nodes (they share one model) so the
 * executor's per-model cost aggregation stays correct without double-counting.
 */
export async function executeNativeSessionLayer(
  opts: ExecuteNativeSessionLayerOptions,
): Promise<NativeSessionLayerResult> {
  const queryFn = opts.queryFn ?? defaultQueryFn;
  const roster = buildAgentRoster(opts.specs);
  const prompt = buildCoordinatorPrompt(opts.specs);
  const nodeIds = opts.specs.map((s) => s.nodeId);

  opts.onProgress?.({
    type: 'status',
    message: `Native multi-agent session: dispatching ${opts.specs.length} node(s)`,
  });

  const options: Record<string, unknown> = {
    model: opts.model,
    cwd: opts.cwd,
    permissionMode: 'acceptEdits',
    agents: roster,
    thinking: { type: 'adaptive' },
    effort: opts.effort ?? 'high',
    // The pilot's headline capability: persist the session so a follow-up can
    // resume this very thread (see submitNativeSessionFollowUp).
    persistSession: true,
    settingSources: ['project'],
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: opts.apiKey,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'orionomega-orchestrator',
      ...(opts.runDir ? { ORIONOMEGA_RUN_DIR: opts.runDir } : {}),
    },
    ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    ...(opts.settings ? { settings: opts.settings } : {}),
    ...(opts.abortSignal ? { abortController: { signal: opts.abortSignal } } : {}),
  };

  const drained = await drainQuery(queryFn({ prompt, options }), opts.onProgress);
  const { results: report, parsed } = parseCoordinatorReport(drained.text, nodeIds);

  // Split aggregate usage evenly across nodes (same model, one session).
  const n = opts.specs.length || 1;
  const splitInt = (total: number, i: number): number =>
    Math.floor(total / n) + (i === 0 ? total % n : 0);
  const splitCost = (total: number, i: number): number => (i === 0 ? total : 0);

  const perNode = new Map<string, NativeSessionNodeResult>();
  opts.specs.forEach((spec, i) => {
    const r = report.get(spec.nodeId)!;
    const success = r.status === 'done';
    perNode.set(spec.nodeId, {
      nodeId: spec.nodeId,
      success,
      output: r.summary,
      ...(success ? {} : { error: r.summary || 'Native session reported failure' }),
      outputPaths: r.outputPaths,
      toolCalls: splitInt(drained.toolCalls, i),
      costUsd: splitCost(drained.costUsd, i),
      model: spec.model ?? opts.model,
      inputTokens: splitInt(drained.inputTokens, i),
      outputTokens: splitInt(drained.outputTokens, i),
      cacheReadTokens: splitInt(drained.cacheReadTokens, i),
      cacheCreationTokens: splitInt(drained.cacheCreationTokens, i),
    });
  });

  opts.onProgress?.({
    type: 'done',
    message: `Native session complete: ${[...perNode.values()].filter((r) => r.success).length}/${
      opts.specs.length
    } node(s) succeeded`,
  });

  return {
    sessionId: drained.sessionId,
    perNode,
    reportParsed: parsed,
    totalCostUsd: drained.costUsd,
    totalToolCalls: drained.toolCalls,
    rawOutput: drained.text,
  };
}

export interface FollowUpOptions {
  /** Session id captured from {@link executeNativeSessionLayer}. */
  sessionId: string;
  /** The follow-up instruction. */
  prompt: string;
  cwd: string;
  apiKey: string;
  model: string;
  effort?: string;
  runDir?: string;
  settings?: Settings;
  onProgress?: (p: NativeSessionProgress) => void;
  queryFn?: NativeSessionQueryFn;
}

export interface FollowUpResult {
  sessionId: string | null;
  output: string;
  finalResult: string | null;
  costUsd: number;
  toolCalls: number;
}

/**
 * Persistent follow-up: resume a previously-persisted native session by id and
 * send another instruction. Demonstrates that the coordinator's session thread
 * survives the original layer dispatch — the platform remembers what each
 * subagent did without OrionOmega re-supplying context.
 */
export async function submitNativeSessionFollowUp(opts: FollowUpOptions): Promise<FollowUpResult> {
  const queryFn = opts.queryFn ?? defaultQueryFn;
  const options: Record<string, unknown> = {
    model: opts.model,
    cwd: opts.cwd,
    permissionMode: 'acceptEdits',
    thinking: { type: 'adaptive' },
    effort: opts.effort ?? 'high',
    // The crux of the follow-up: resume the persisted thread.
    resume: opts.sessionId,
    persistSession: true,
    settingSources: ['project'],
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: opts.apiKey,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'orionomega-orchestrator',
      ...(opts.runDir ? { ORIONOMEGA_RUN_DIR: opts.runDir } : {}),
    },
    ...(opts.settings ? { settings: opts.settings } : {}),
  };

  const drained = await drainQuery(queryFn({ prompt: opts.prompt, options }), opts.onProgress);
  return {
    sessionId: drained.sessionId ?? opts.sessionId,
    output: drained.text,
    finalResult: drained.finalResult,
    costUsd: drained.costUsd,
    toolCalls: drained.toolCalls,
  };
}

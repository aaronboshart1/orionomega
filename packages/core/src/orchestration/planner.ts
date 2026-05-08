/**
 * @module orchestration/planner
 * Task decomposition and workflow graph generation via the Anthropic API.
 *
 * Sends the task description to the planner LLM, parses the returned JSON
 * into a WorkflowGraph, and falls back to a single-node plan on failure.
 */

import type { PlannerOutput, WorkflowNode } from './types.js';
import { buildGraph } from './graph.js';
import { AnthropicClient } from '../anthropic/client.js';
import { readConfig } from '../config/loader.js';
import { createLogger } from '../logging/logger.js';
import { isExternalAction } from '../memory/query-classifier.js';
import { discoverModels, buildModelGuide, pickModelByTier, type DiscoveredModel } from '../models/model-discovery.js';
import { getPortAvoidanceInstructions } from '../utils/port-restrictions.js';

const log = createLogger('planner');

/** Configuration for the planner. */
export interface PlannerConfig {
  /** Model identifier for the planner LLM. */
  model: string;
  /** Maximum number of concurrent workers. Defaults to 8. */
  maxWorkers?: number;
}

/**
 * Decomposes a task description into a workflow graph using the Anthropic API.
 *
 * Sends the planning prompt to the configured planner model, parses the JSON
 * response into WorkflowNodes, and builds a WorkflowGraph. Falls back to a
 * single AGENT node if parsing fails.
 */
export class Planner {
  private readonly config: PlannerConfig;

  constructor(config: PlannerConfig) {
    this.config = config;
  }

  /** The model used for planning. */
  get model(): string { return this.config.model; }

  /**
   * Generates an execution plan for the given task.
   *
   * @param task - Natural language task description.
   * @param context - Optional context for richer planning.
   * @returns A PlannerOutput with the workflow graph, reasoning, and estimates.
   */
  async plan(
    task: string,
    context?: {
      memories?: string[];
      availableSkills?: string[];
      workspaceFiles?: string[];
    },
    preRecalledContext?: string,
  ): Promise<PlannerOutput> {
    const appConfig = readConfig();
    const apiKey = appConfig.models.apiKey;
    const model = appConfig.models.planner || this.config.model;

    if (!apiKey) {
      log.warn('No API key configured — falling back to single-node plan');
      return this.fallbackPlan(task, 'No API key configured');
    }

    const client = new AnthropicClient(apiKey);

    let discoveredModels: DiscoveredModel[] = [];
    try {
      discoveredModels = await discoverModels(apiKey);
    } catch {
      log.warn('Model discovery failed — planner will use configured defaults');
    }

    const defaultWorkerModel = discoveredModels.length > 0
      ? (pickModelByTier(discoveredModels, 'sonnet')?.id ?? appConfig.models.default)
      : appConfig.models.default;

    // Coerce planner-supplied model names to real, discoverable models. The
    // planner LLM occasionally hallucinates IDs (e.g. "claude-opus-4-7" when
    // only "claude-opus-4-6" exists). Passing a fake model to Claude Code makes
    // the spawned process exit immediately with code 1, which surfaces to the
    // user as "Coding agent error: Claude Code process exited with code 1".
    const coerceModel = (raw: unknown): string => {
      const id = raw == null ? '' : String(raw).trim();
      if (!id) return defaultWorkerModel;
      if (discoveredModels.length === 0) return id;
      if (discoveredModels.some((m) => m.id === id)) return id;
      const lower = id.toLowerCase();
      const inferredTier: 'opus' | 'sonnet' | 'haiku' | null =
        lower.includes('opus') ? 'opus'
        : lower.includes('sonnet') ? 'sonnet'
        : lower.includes('haiku') ? 'haiku'
        : null;
      const replacement = inferredTier
        ? (pickModelByTier(discoveredModels, inferredTier)?.id ?? defaultWorkerModel)
        : defaultWorkerModel;
      log.warn(
        `Planner picked unknown model "${id}" — substituting "${replacement}"` +
        (inferredTier ? ` (inferred ${inferredTier} tier)` : ' (default worker model)'),
      );
      return replacement;
    };

    let infraContext: string | undefined = preRecalledContext;
    if (!infraContext && !isExternalAction(task)) {
      try {
        const hindsightUrl = appConfig.hindsight?.url;
        if (hindsightUrl) {
          const { HindsightClient } = await import('@orionomega/hindsight');
          const hsClient = new HindsightClient(hindsightUrl);
          const recallQuery = this.extractRecallQuery(task);

          const recalls = await Promise.allSettled([
            hsClient.recall('infra', recallQuery, { maxTokens: 1024, budget: 'low' }),
            hsClient.recall(appConfig.hindsight?.defaultBank ?? 'default', recallQuery, { maxTokens: 1024, budget: 'low' }),
          ]);

          const parts: string[] = [];
          for (const r of recalls) {
            if (r.status === 'fulfilled' && r.value) {
              const memories = r.value.results ?? [];
              for (const m of memories) {
                if (m.content) parts.push(m.content);
              }
            }
          }
          if (parts.length > 0) {
            infraContext = parts.join('\n');
            log.debug(`Pre-planning context: ${parts.length} memories, ${infraContext.length} chars`);
          }
        }
      } catch (err) {
        log.debug(`Pre-planning recall failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // C1: Build the prompt with a token-budget guard so we never blow past
    // the planner model's input limit. If the assembled prompt is too large
    // we trim the lowest-priority sections first (infraContext → memories →
    // files); if it's still too large we hard-truncate.
    const systemPrompt = this.buildBoundedPlannerPrompt({
      task,
      context,
      discoveredModels,
      mainModel: appConfig.models.default,
      infraContext,
    });

    try {
      log.info(`Planning task with model ${model}: "${task.slice(0, 80)}..."`);

      // Force structured output via tool-use rather than free-form JSON.
      //
      // Free-form JSON output is unreliable at scale: large CODING MODE
      // preambles (multi-thousand-line spec files inlined) regularly
      // caused the model to either return markdown prose describing a DAG
      // (cascading into fallbackPlan) or return near-empty output. An
      // assistant-prefill of `{` mitigated some of that but is rejected
      // outright by some models (e.g. claude-opus-4-6).
      //
      // Forcing the model to call a `submit_plan` tool with a strict
      // input schema makes prose output structurally impossible — the API
      // itself enforces that the response is a single tool_use block with
      // arguments that match the schema. Works on every Claude 3+ model.
      //
      // Note: Claude 4+ models reject the deprecated `temperature` field —
      // intentionally not set.
      // IMPORTANT: property order matters. Models emit JSON fields in
      // schema order, and a truncated response (stop_reason=max_tokens)
      // loses everything after the cutoff. We put `nodes` FIRST so the
      // critical payload always lands inside the output budget; metadata
      // and reasoning come after and may be truncated harmlessly.
      const submitPlanTool = {
        name: 'submit_plan',
        description:
          'Submit the orchestration plan as structured data. You MUST call this tool exactly once and produce no other output. CRITICAL: emit the `nodes` array first and keep `reasoning` to two short sentences (under 60 words). The output token budget is finite — long prose in `reasoning` causes truncation that loses the plan.',
        input_schema: {
          type: 'object',
          additionalProperties: true,
          required: ['nodes', 'summary'],
          properties: {
            nodes: {
              type: 'array',
              description:
                'Workflow nodes. Emit this FIRST. Every node requires id, type, label, dependsOn. Include only the relevant config key per type (agent / tool / router / codingAgent / loop).',
              items: {
                type: 'object',
                additionalProperties: true,
                required: ['id', 'type', 'label', 'dependsOn'],
                properties: {
                  id: { type: 'string' },
                  type: {
                    type: 'string',
                    enum: ['AGENT', 'TOOL', 'ROUTER', 'JOIN', 'CODING_AGENT', 'LOOP'],
                  },
                  label: { type: 'string' },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  timeout: { type: 'number' },
                  retries: { type: 'number' },
                  tokenBudget: { type: 'number' },
                  agent: { type: 'object', additionalProperties: true },
                  codingAgent: { type: 'object', additionalProperties: true },
                  tool: { type: 'object', additionalProperties: true },
                  router: { type: 'object', additionalProperties: true },
                  loop: { type: 'object', additionalProperties: true },
                },
              },
            },
            summary: {
              type: 'string',
              description: 'One-line summary of the overall workflow (under 120 chars).',
            },
            estimatedCost: {
              type: 'number',
              description: 'Estimated total cost in USD.',
            },
            estimatedTime: {
              type: 'number',
              description: 'Estimated total runtime in seconds.',
            },
            reasoning: {
              type: 'string',
              description:
                'Two short sentences (max ~60 words / 400 chars). Do not enumerate phases or restate the spec.',
            },
          },
        },
      } as const;

      const response = await client.createMessage({
        model,
        messages: [{ role: 'user', content: task }],
        system: systemPrompt,
        maxTokens: 16384,
        tools: [submitPlanTool],
        toolChoice: { type: 'tool', name: 'submit_plan' },
      });

      // The forced tool_use response should contain exactly one tool_use
      // block whose `input` IS the parsed plan object. Find it.
      const toolUseBlock = response.content.find(
        (b) => b.type === 'tool_use' && b.name === 'submit_plan',
      );

      let parsed: Record<string, unknown> | null = null;
      if (toolUseBlock && toolUseBlock.input && typeof toolUseBlock.input === 'object') {
        parsed = toolUseBlock.input as Record<string, unknown>;
      } else {
        // Defensive fallback: some adapters / older models may still emit
        // text content. Try to recover JSON from text blocks.
        const rawResponseText = response.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('');
        if (rawResponseText) {
          parsed = this.extractJson(rawResponseText);
        }
      }

      if (!parsed) {
        log.warn('Planner returned no submit_plan tool_use and no parseable JSON', {
          stopReason: response.stop_reason,
          contentTypes: response.content.map((b) => b.type),
        });
        return this.fallbackPlan(
          task,
          'The planner could not structure this task into a multi-step plan. Running as a single task instead.',
        );
      }

      // Detect output truncation. With forced tool-use, max_tokens means
      // the model ran out of output budget mid-arguments — `nodes` may be
      // missing or partial. Surface this distinctly so the user knows to
      // simplify or split the request rather than treating it as a generic
      // planner failure.
      if (response.stop_reason === 'max_tokens') {
        const partialNodeCount = Array.isArray(parsed.nodes)
          ? (parsed.nodes as unknown[]).length
          : 0;
        log.warn('Planner output hit max_tokens — plan may be truncated', {
          partialNodeCount,
          outputTokens: response.usage.output_tokens,
        });
        if (partialNodeCount === 0) {
          return this.fallbackPlan(
            task,
            'The planner ran out of output tokens before producing any nodes. The request is too large for a single planning pass — split the spec into smaller phases (e.g. one module per request) or simplify the prompt.',
          );
        }
      }

      // Extract plan metadata
      const reasoning = String(parsed.reasoning ?? 'No reasoning provided');
      const estimatedCost = Number(parsed.estimatedCost ?? 0);
      const estimatedTime = Number(parsed.estimatedTime ?? 0);
      const summary = String(parsed.summary ?? task.slice(0, 120));

      // Build WorkflowNodes from the parsed nodes array
      const rawNodes = parsed.nodes;
      if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
        log.warn('Planner returned no nodes', { reasoning });
        return this.fallbackPlan(task, 'Running as a single task.');
      }

      const nodes: WorkflowNode[] = rawNodes.map(
        (n: Record<string, unknown>) => ({
          id: String(n.id ?? `node-${Math.random().toString(36).slice(2, 8)}`),
          type: String(n.type ?? 'AGENT') as WorkflowNode['type'],
          label: String(n.label ?? 'Unlabelled Node'),
          dependsOn: Array.isArray(n.dependsOn)
            ? (n.dependsOn as string[]).map(String)
            : [],
          status: 'pending' as const,
          timeout: n.timeout != null ? Number(n.timeout) : undefined,
          // Use nullish check, not truthy: a planner-emitted `retries: 0`
          // legitimately means "no retries" and must reach the executor as
          // 0, not get coerced to undefined (which would fall through to the
          // global config default — Infinity when the unlimited sentinel is
          // active).
          retries: n.retries != null ? Number(n.retries) : undefined,
          fallbackNodeId: n.fallbackNodeId
            ? String(n.fallbackNodeId)
            : undefined,
          agent: n.agent
            ? {
                model: coerceModel(
                  (n.agent as Record<string, unknown>).model ?? defaultWorkerModel,
                ),
                task: String(
                  (n.agent as Record<string, unknown>).task ?? '',
                ),
                tools: Array.isArray(
                  (n.agent as Record<string, unknown>).tools,
                )
                  ? ((n.agent as Record<string, unknown>).tools as string[])
                  : undefined,
                skillIds: Array.isArray(
                  (n.agent as Record<string, unknown>).skillIds,
                )
                  ? ((n.agent as Record<string, unknown>).skillIds as string[])
                  : undefined,
                tokenBudget: (n.agent as Record<string, unknown>).tokenBudget
                  ? Number((n.agent as Record<string, unknown>).tokenBudget)
                  : undefined,
              }
            : undefined,
          tool: n.tool
            ? {
                name: String(
                  (n.tool as Record<string, unknown>).name ?? '',
                ),
                params: ((n.tool as Record<string, unknown>)
                  .params as Record<string, unknown>) ?? {},
              }
            : undefined,
          router: n.router
            ? {
                condition: String(
                  (n.router as Record<string, unknown>).condition ?? '',
                ),
                routes: ((n.router as Record<string, unknown>)
                  .routes as Record<string, string>) ?? {},
              }
            : undefined,
          codingAgent: n.codingAgent
            ? (() => {
                const ca = n.codingAgent as Record<string, unknown>;
                return {
                  task: String(ca.task ?? ''),
                  model: ca.model ? coerceModel(ca.model) : undefined,
                  cwd: ca.cwd ? String(ca.cwd) : undefined,
                  additionalDirectories: Array.isArray(ca.additionalDirectories)
                    ? (ca.additionalDirectories as string[])
                    : undefined,
                  systemPrompt: ca.systemPrompt ? String(ca.systemPrompt) : undefined,
                  allowedTools: Array.isArray(ca.allowedTools)
                    ? (ca.allowedTools as string[])
                    : undefined,
                  maxTurns: ca.maxTurns ? Number(ca.maxTurns) : undefined,
                  maxBudgetUsd: ca.maxBudgetUsd ? Number(ca.maxBudgetUsd) : undefined,
                  agents: ca.agents && typeof ca.agents === 'object'
                    ? (ca.agents as Record<string, { description: string; prompt: string; tools?: string[] }>)
                    : undefined,
                };
              })()
            : undefined,
          loop: n.loop
            ? (() => {
                const lp = n.loop as Record<string, unknown>;
                const exitCond = lp.exitCondition as Record<string, unknown> | undefined;
                return {
                  body: Array.isArray(lp.body)
                    ? (lp.body as Record<string, unknown>[]).map((b) => ({
                        id: String(b.id ?? `body-${Math.random().toString(36).slice(2, 8)}`),
                        type: String(b.type ?? 'AGENT') as WorkflowNode['type'],
                        label: String(b.label ?? 'Loop body node'),
                        dependsOn: Array.isArray(b.dependsOn)
                          ? (b.dependsOn as string[]).map(String)
                          : [],
                        status: 'pending' as const,
                        agent: b.agent
                          ? {
                              model: coerceModel((b.agent as Record<string, unknown>).model ?? defaultWorkerModel),
                              task: String((b.agent as Record<string, unknown>).task ?? ''),
                            }
                          : undefined,
                        codingAgent: b.codingAgent
                          ? {
                              task: String((b.codingAgent as Record<string, unknown>).task ?? ''),
                              model: (b.codingAgent as Record<string, unknown>).model
                                ? coerceModel((b.codingAgent as Record<string, unknown>).model)
                                : undefined,
                              cwd: (b.codingAgent as Record<string, unknown>).cwd
                                ? String((b.codingAgent as Record<string, unknown>).cwd)
                                : undefined,
                            }
                          : undefined,
                      }))
                    : [],
                  maxIterations: lp.maxIterations ? Number(lp.maxIterations) : 5,
                  exitCondition: {
                    type: String(exitCond?.type ?? 'all_pass') as 'output_match' | 'llm_judge' | 'all_pass',
                    pattern: exitCond?.pattern ? String(exitCond.pattern) : undefined,
                    judgePrompt: exitCond?.judgePrompt ? String(exitCond.judgePrompt) : undefined,
                  },
                  carryForward: lp.carryForward !== false,
                };
              })()
            : undefined,
        }),
      );

      const graph = buildGraph(nodes, summary.slice(0, 80));

      log.info(
        `Plan generated: ${nodes.length} nodes, ${graph.layers.length} layers`,
      );

      return {
        graph,
        reasoning,
        estimatedCost,
        estimatedTime,
        summary,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Planner failed: ${msg}`);
      return this.fallbackPlan(task, `Planner error: ${msg}`);
    }
  }

  /**
   * Builds the full system prompt for the planner LLM.
   *
   * @param task - The task description.
   * @param context - Optional additional context (memories, skills, files).
   * @returns The complete system prompt string.
   */
  /**
   * C1: Maximum character budget for the planner system prompt + task.
   *
   * The planner runs on Opus (1M token input limit). At ~3.5 chars/token a
   * 1M-token request is ~3.5M chars; we cap at 2.4M chars (~685k tokens) to
   * keep generous headroom for the user's task body and model output. This
   * stops the runaway 2.8M–4.1M-token requests that previously got rejected
   * and forced every plan into the single-node fallback.
   */
  private static readonly MAX_PROMPT_CHARS = 2_400_000;

  /**
   * C1: Assemble the planner prompt with a token-budget guard.
   *
   * If the combined prompt exceeds `MAX_PROMPT_CHARS`, we trim the
   * lowest-priority sections first:
   *   1. infraContext (largest and least essential — recallable later)
   *   2. memories
   *   3. workspace files
   * If after dropping all three we're still over budget, the prompt is
   * hard-truncated. Each step is logged so operators can spot context
   * pressure in the logs.
   */
  buildBoundedPlannerPrompt(args: {
    task: string;
    context?: { memories?: string[]; availableSkills?: string[]; workspaceFiles?: string[] };
    discoveredModels?: DiscoveredModel[];
    mainModel?: string;
    infraContext?: string;
  }): string {
    const { task, discoveredModels, mainModel } = args;
    let { context, infraContext } = args;
    const budget = Planner.MAX_PROMPT_CHARS;

    let prompt = this.buildPlannerPrompt(task, context, discoveredModels, mainModel, infraContext);
    if (prompt.length <= budget) return prompt;

    // 1) Drop infraContext.
    if (infraContext) {
      log.warn('Planner prompt over budget — dropping infra context', {
        promptChars: prompt.length,
        budgetChars: budget,
        infraContextChars: infraContext.length,
      });
      infraContext = undefined;
      prompt = this.buildPlannerPrompt(task, context, discoveredModels, mainModel, infraContext);
      if (prompt.length <= budget) return prompt;
    }

    // 2) Drop memories.
    if (context?.memories?.length) {
      log.warn('Planner prompt still over budget — dropping memories', {
        promptChars: prompt.length,
        budgetChars: budget,
        memoryCount: context.memories.length,
      });
      context = { ...context, memories: [] };
      prompt = this.buildPlannerPrompt(task, context, discoveredModels, mainModel, infraContext);
      if (prompt.length <= budget) return prompt;
    }

    // 3) Drop workspace files.
    if (context?.workspaceFiles?.length) {
      log.warn('Planner prompt still over budget — dropping workspace files', {
        promptChars: prompt.length,
        budgetChars: budget,
        fileCount: context.workspaceFiles.length,
      });
      context = { ...context, workspaceFiles: [] };
      prompt = this.buildPlannerPrompt(task, context, discoveredModels, mainModel, infraContext);
      if (prompt.length <= budget) return prompt;
    }

    // 4) Hard truncate as a last resort. Preserve the head of the prompt
    //    (rules, schema, model guide) and append a marker so the LLM is told
    //    the trailing context was cut.
    log.warn('Planner prompt still over budget after dropping context — hard truncating', {
      promptChars: prompt.length,
      budgetChars: budget,
    });
    const marker = '\n\n[context truncated to fit model input budget]\n';
    return prompt.slice(0, Math.max(0, budget - marker.length)) + marker;
  }

  buildPlannerPrompt(
    task: string,
    context?: object,
    discoveredModels?: DiscoveredModel[],
    mainModel?: string,
    infraContext?: string,
  ): string {
    const ctx = context as
      | {
          memories?: string[];
          availableSkills?: string[];
          workspaceFiles?: string[];
        }
      | undefined;

    const skillsList = ctx?.availableSkills?.length
      ? `\n\nAvailable skills:\n${ctx.availableSkills.map((s) => `- ${s}`).join('\n')}`
      : '';

    const memoriesList = ctx?.memories?.length
      ? `\n\nRelevant memories:\n${ctx.memories.map((m) => `- ${m}`).join('\n')}`
      : '';

    const filesList = ctx?.workspaceFiles?.length
      ? `\n\nWorkspace files:\n${ctx.workspaceFiles.map((f) => `- ${f}`).join('\n')}`
      : '';

    return `You are the OrionOmega Planner — an expert at decomposing complex tasks into parallel execution graphs.

## Rules
1. Maximise parallelism — independent sub-tasks MUST share a layer.
2. One deliverable per worker. CODING_AGENT for coding, AGENT for non-coding.
3. TOOL nodes: execFile only (no pipes/shell). For complex commands use AGENT/CODING_AGENT.
4. LOOP for iterative tasks (exitCondition: all_pass | output_match | llm_judge). Prefer LOOP over retries.
5. ROUTER for conditional branching. JOIN when paths converge.
6. Max ${this.config.maxWorkers ?? 8} concurrent workers per layer.
7. Per-node \`timeout\` is the **wall-clock budget in seconds** (NOT an estimated runtime).
   It MUST be larger than any plausible execution time, or the node will be killed mid-flight.
   Required minimums by node type — emit values >= these or omit the field to inherit defaults:
     • AGENT         >= 600   (research/analysis tasks; default 600s)
     • CODING_AGENT  >= 1800  (multi-turn Read/Edit/Bash loops; default 1800s)
     • TOOL          >= 60    (short-lived shell invocations; floor 60s,
                               inherited default 600s when omitted —
                               raise explicitly for slow build/test commands)
   For *expected* wall time, use the top-level \`estimatedTime\` field instead.
   Always set \`retries\` (0–2) and a \`fallbackNodeId\` when a backup approach exists.
   Pick models from the list below.
## Context Efficiency
Workers auto-receive: upstream outputs, Hindsight memories, infra config. Do NOT create discovery nodes for known info.

## Output File Paths (CRITICAL)
NEVER specify absolute output paths in a worker's \`task\` description.
Each worker is given a private per-node artifact directory by the orchestrator,
and its stdout plus any files it writes there are captured automatically and
surfaced in the run summary.
- BAD:  "Write the spec to /home/user/task-scheduling-spec.md"
- BAD:  "Save analysis to ~/notes.md" or "...to /tmp/report.json"
- GOOD: "Produce a comprehensive implementation specification as markdown."
- GOOD: "Write the analysis to spec.md" (relative filename only)
Only mention an absolute path if the *user's original request* explicitly
named one, in which case quote it verbatim.

## Token Budgets
Only set \`tokenBudget\` when you specifically want to *reduce* a worker below the system default.
Tool-heavy workers (web search, file scanning, large research) burn cache writes fast — leave them
unbounded so the system default applies. If you do set one, use realistic ranges:
retrieval/quick lookups 200K-400K, analysis 500K-800K, deep multi-step research 1M+.

## Output: JSON
The \`estimatedTime\` field is the *expected* total runtime of the entire plan in seconds.
Per-node \`timeout\` values are *budgets* that must comfortably exceed expected runtimes (see rule 7).
\`\`\`json
{"reasoning":"...","estimatedCost":0.05,"estimatedTime":600,"summary":"...","nodes":[{"id":"...","type":"AGENT|TOOL|ROUTER|JOIN|CODING_AGENT|LOOP","label":"...","dependsOn":[],"timeout":600,"retries":1,"agent":{"model":"...","task":"...","skillIds":["linear"]},"codingAgent":{"task":"...","model":"...","allowedTools":["Read","Write","Edit","Bash","Glob","Grep"],"maxTurns":30},"tool":{"name":"BINARY","params":{}},"router":{"condition":"key","routes":{"val":"node-id","default":"node-id"}},"loop":{"body":[...],"maxIterations":5,"exitCondition":{"type":"all_pass|output_match|llm_judge"},"carryForward":true}}]}
\`\`\`
Note: For a CODING_AGENT node specifically, set \`timeout: 1800\` (or higher) — never 120 or 300.
Include only the relevant config key per node type (agent/tool/router/codingAgent/loop). Every node: id, type, label, dependsOn.
CODING_AGENT is preferred for coding tasks (key: codingAgent, not agent). LOOP is essential for iterative build-test-fix cycles.
When a task involves an available skill, add \`"skillIds": ["<skill-name>"]\` inside the \`agent\` config of the AGENT node so its tools are available at runtime.

## ${discoveredModels?.length ? buildModelGuide(discoveredModels, mainModel ?? this.config.model) : `Available models: Use "${mainModel ?? this.config.model}" for all workers.`}
${skillsList}${memoriesList}${filesList}${infraContext ? `\n\n## Known Context (from memory — DO NOT create discovery nodes for this)\n${infraContext}` : ''}

${getPortAvoidanceInstructions()}

## Task
${task}

Respond ONLY with the JSON object. No markdown fences, no commentary.`;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Extracts a concise recall query from a potentially long task string.
   * Hindsight performs best with short, focused queries (under 200 chars),
   * not full multi-paragraph task instructions.
   */
  private extractRecallQuery(task: string): string {
    // Take the first sentence or first 200 chars, whichever is shorter
    const firstSentence = task.match(/^[^.!?\n]+[.!?]?/);
    const candidate = firstSentence ? firstSentence[0] : task;
    return candidate.length > 200 ? candidate.slice(0, 200).trim() : candidate.trim();
  }

  /**
   * Extracts a JSON object from the LLM response text.
   * Tries: fenced ```json blocks, then the entire response as JSON.
   */
  private extractJson(text: string): Record<string, unknown> | null {
    // Try fenced JSON block
    const fencedMatch = text.match(/```json\s*\n?([\s\S]*?)\n?```/);
    if (fencedMatch?.[1]) {
      try {
        return JSON.parse(fencedMatch[1]) as Record<string, unknown>;
      } catch {
        // Fall through
      }
    }

    // Try the entire response as JSON
    try {
      return JSON.parse(text.trim()) as Record<string, unknown>;
    } catch {
      // Fall through
    }

    // Try to find a JSON object in the response (first { to last })
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(
          text.slice(firstBrace, lastBrace + 1),
        ) as Record<string, unknown>;
      } catch {
        // Give up
      }
    }

    return null;
  }

  /**
   * Marker present in every CODING MODE planner preamble built by
   * `buildCodingTaskPreamble` (packages/core/src/agent/coding-dispatch.ts).
   * Used to detect a code-mode task in `fallbackPlan` so we can swap the
   * worker's task for an explicit error message instead of re-feeding the
   * planner instructions to a single AGENT (which would dutifully output
   * prose describing a DAG instead of executing one).
   */
  private static readonly CODING_PREAMBLE_MARKER =
    '## CODING MODE — Structured Software Engineering Workflow';

  /**
   * Builds a single-node fallback plan when the LLM planner fails.
   *
   * For CODING MODE tasks, the verbatim preamble is NOT a sensible thing to
   * pass to a single AGENT — the preamble tells the recipient to "plan a
   * coding workflow", which produces prose describing a DAG rather than
   * actual implementation. In that case we replace the task with a clear
   * error message so the user sees what went wrong and can retry, rather
   * than getting a confusing prose dump.
   */
  private fallbackPlan(task: string, reason: string): PlannerOutput {
    // Fallback uses the main agent model — always the configured default, never hardcoded
    const appConfig = readConfig();
    const fallbackModel = appConfig.models.default || this.config.model;

    const isCodingMode = task.includes(Planner.CODING_PREAMBLE_MARKER);

    const fallbackTask = isCodingMode
      ? `The orchestration planner failed to generate a valid multi-node DAG for the user's coding request.

Reason: ${reason}

Respond to the user with a short, clear error message explaining that the planner could not structure this coding task into a workflow. Suggest they:
- Retry the request (transient LLM hiccups happen and prefilled JSON output usually succeeds on retry).
- If a referenced spec file is very large, split the request into smaller phases.
- Simplify or shorten the request and try again.

Do NOT attempt to plan or execute the coding work yourself. Do NOT clone, write code, run commands, or describe a DAG. Just surface the error in 2–4 sentences.`
      : task;

    const label = isCodingMode ? 'Coding planner failed' : 'Primary Worker';

    const node: WorkflowNode = {
      id: 'worker-1',
      type: 'AGENT',
      label,
      agent: {
        model: fallbackModel,
        task: fallbackTask,
      },
      dependsOn: [],
      status: 'pending',
    };

    const graph = buildGraph([node], (isCodingMode ? 'Coding planner failed' : task).slice(0, 80));

    log.debug(`Fallback plan reason: ${reason}`, { isCodingMode });
    return {
      graph,
      reasoning: reason,
      estimatedCost: 0,
      estimatedTime: 0,
      summary: (isCodingMode ? `Coding planner failed: ${reason}` : task).slice(0, 120),
    };
  }

  /**
   * Generate a fix plan for a failed node.
   * Returns an array of WorkflowNode definitions to execute as a fix,
   * or null if re-planning isn't feasible.
   */
  async generateFixPlan(
    failedNode: WorkflowNode,
    error: string,
    originalTask: string,
  ): Promise<WorkflowNode[] | null> {
    try {
      const prompt = `A workflow node failed. Generate a minimal fix plan.

## Failed Node
- ID: ${failedNode.id}
- Type: ${failedNode.type}
- Label: ${failedNode.label}
- Task: ${failedNode.agent?.task ?? failedNode.codingAgent?.task ?? 'unknown'}

## Error
${error}

## Original Workflow Task
${originalTask}

## Instructions
Generate 1-3 nodes that will fix the error and complete the failed node's task.
Use CODING_AGENT for code fixes, AGENT for other tasks.
Return a JSON array of node objects with: id, type, label, dependsOn (empty array), and the appropriate config (agent or codingAgent).
Return ONLY the JSON array, no explanation.
If the error is unfixable (e.g. missing API key, permission denied), return an empty array [].`;

      const apiKey = readConfig().models?.apiKey;
      if (!apiKey) return null;
      const client = new AnthropicClient(apiKey);

      // M1: Drop the deprecated `temperature` field — Claude 4+ models reject
      // requests that send it (this is a second occurrence — see plan() above).
      const response = await client.createMessage({
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2048,
      });

      const text = response.content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { type: string; text?: string }) => b.text ?? '')
        .join('');

      const jsonStr = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      const nodes = JSON.parse(jsonStr) as WorkflowNode[];

      if (!Array.isArray(nodes) || nodes.length === 0) return null;

      // Ensure proper status
      return nodes.map((n) => ({
        ...n,
        id: n.id ?? `fix-${Math.random().toString(36).slice(2, 8)}`,
        status: 'pending' as const,
        dependsOn: n.dependsOn ?? [],
      }));
    } catch (err) {
      log.warn('Fix plan generation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

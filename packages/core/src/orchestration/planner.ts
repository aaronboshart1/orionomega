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
import { discoverModels, buildModelGuide, pickModelByTier, type DiscoveredModel } from '../models/model-discovery.js';

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
  ): Promise<PlannerOutput> {
    const appConfig = readConfig();
    const apiKey = appConfig.models.apiKey;
    const model = appConfig.models.planner || this.config.model;

    if (!apiKey) {
      log.warn('No API key configured — falling back to single-node plan');
      return this.fallbackPlan(task, 'No API key configured');
    }

    const client = new AnthropicClient(apiKey);

    // Discover available models dynamically — no hardcoded model names
    let discoveredModels: DiscoveredModel[] = [];
    try {
      discoveredModels = await discoverModels(apiKey);
    } catch {
      log.warn('Model discovery failed — planner will use configured defaults');
    }

    // Determine the default worker model (midweight, fallback to main agent model)
    const defaultWorkerModel = discoveredModels.length > 0
      ? (pickModelByTier(discoveredModels, 'sonnet')?.id ?? appConfig.models.default)
      : appConfig.models.default;

    // Pre-planning context recall from Hindsight
    // This prevents workers from wasting tokens discovering things we already know
    let infraContext: string | undefined;
    try {
      const hindsightUrl = appConfig.hindsight?.url;
      if (hindsightUrl) {
        const { HindsightClient } = await import('@orionomega/hindsight');
        const hsClient = new HindsightClient(hindsightUrl);

        const recalls = await Promise.allSettled([
          hsClient.recall('infra', task, { maxTokens: 1024, budget: 'low' }),
          hsClient.recall(appConfig.hindsight?.defaultBank ?? 'default', task, { maxTokens: 1024, budget: 'low' }),
        ]);

        const parts: string[] = [];
        for (const r of recalls) {
          if (r.status === 'fulfilled' && r.value) {
            const memories = r.value.memories ?? ((r.value as unknown as Record<string, unknown>).results as { content: string }[]) ?? [];
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

    const systemPrompt = this.buildPlannerPrompt(task, context, discoveredModels, appConfig.models.default, infraContext);

    try {
      log.info(`Planning task with model ${model}: "${task.slice(0, 80)}..."`);

      const response = await client.createMessage({
        model,
        messages: [{ role: 'user', content: task }],
        system: systemPrompt,
        maxTokens: 4096,
        temperature: 0.2,
      });

      // Extract text content from response
      const responseText = response.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('');

      if (!responseText) {
        log.warn('Empty response from planner LLM');
        return this.fallbackPlan(task, 'Empty LLM response');
      }

      // Parse the JSON from the response
      const parsed = this.extractJson(responseText);
      if (!parsed) {
        log.warn('Failed to parse JSON from planner response');
        return this.fallbackPlan(
          task,
          `Failed to parse planner JSON. Raw response:\n${responseText.slice(0, 500)}`,
        );
      }

      // Extract plan metadata
      const reasoning = String(parsed.reasoning ?? 'No reasoning provided');
      const estimatedCost = Number(parsed.estimatedCost ?? 0);
      const estimatedTime = Number(parsed.estimatedTime ?? 0);
      const summary = String(parsed.summary ?? task.slice(0, 120));

      // Build WorkflowNodes from the parsed nodes array
      const rawNodes = parsed.nodes;
      if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
        log.warn('Planner returned no nodes');
        return this.fallbackPlan(task, `Planner returned no nodes. Reasoning: ${reasoning}`);
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
          timeout: n.timeout ? Number(n.timeout) : undefined,
          retries: n.retries ? Number(n.retries) : undefined,
          fallbackNodeId: n.fallbackNodeId
            ? String(n.fallbackNodeId)
            : undefined,
          agent: n.agent
            ? {
                model: String(
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
                  model: ca.model ? String(ca.model) : undefined,
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

## Your Role
Given a task description, you produce a WorkflowGraph JSON that orchestrates multiple agents and tools to accomplish the task as efficiently as possible.

## Rules
1. **Maximise parallelism.** If two sub-tasks have no data dependency, they MUST be in the same layer (no dependsOn between them).
2. **One deliverable per worker.** Each AGENT node should have a single, well-scoped task that produces one clear output.
3. **Use TOOL nodes sparingly** — only for shell commands (e.g. exec). For file operations, writing documents, web searches, etc., use AGENT nodes — they have built-in tools: exec (shell), read (files), write (files), edit (files). Skills may also provide: web_search, web_fetch.
4. **Use CODING_AGENT nodes for coding tasks.** When a task involves writing code, refactoring, debugging, building features, or any software engineering work, use CODING_AGENT instead of AGENT. CODING_AGENT nodes run via the Claude Agent SDK and have access to the full Claude Code toolset: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, and Task (subagents). They are significantly more capable at coding than generic AGENT nodes. CODING_AGENT nodes also support subagent definitions for complex multi-part coding tasks.
5. **Use ROUTER nodes for conditional logic.** When the next step depends on a previous result, use a ROUTER with condition and routes.
6. **Model assignment:** Pick models from the available models list below. The list is fetched live from the API — only use models that appear in it.
7. **Maximum ${this.config.maxWorkers ?? 8} concurrent workers** per layer.
8. **Always include a JOIN node** when multiple paths converge to a single output.
9. **Set reasonable timeouts** (in seconds) for each node based on expected duration.
10. **Set retries** for nodes that might fail transiently (network calls, API requests).
11. **Set fallbackNodeId** for critical nodes where an alternative approach exists.

## Parallelism — CRITICAL
The executor runs all nodes in the same layer concurrently. Nodes only wait for nodes listed in their dependsOn.

- WRONG: A → B → C → D (sequential chain when B and C are independent)
- RIGHT: A, B (parallel, no deps) → C (depends on A and B) → D (depends on C)
- "Fetch data from source A" and "Fetch data from source B" have ZERO dependencies on each other — they MUST be in the same layer
- Only add a dependency when a node genuinely requires another node's OUTPUT as INPUT
- The executor automatically passes upstream outputs to downstream workers — you don't need intermediate "collect results" nodes unless you're doing a JOIN

## Token Budgets
Each worker has a token budget that limits how many input tokens it can consume. Assign budgets based on task complexity:
- **Retrieval / lookup tasks** (fetch data, query APIs): 50,000–100,000 tokens. Use lightweight models.
- **Analysis / writing tasks** (process data, generate reports): 100,000–200,000 tokens. Use midweight models.
- **Complex reasoning tasks** (architecture, multi-step code): 200,000–400,000 tokens. Use heavyweight models.

Set tokenBudget in the agent config: \`"agent": { "model": "...", "task": "...", "tokenBudget": 100000 }\`
Workers that exceed their budget are gracefully stopped and asked to produce final output.

## Context Efficiency
Workers automatically receive:
- Output from upstream (dependency) workers — no need for "pass-through" or "collect" nodes
- Relevant memories from the knowledge base (Hindsight)
- Known infrastructure details from config

DO NOT create "discovery" or "exploration" nodes for things that are already known (see Known Context below).
Instead, include the known information directly in the worker's task description.

## Output Format
Respond with a JSON object matching this schema:

\`\`\`json
{
  "reasoning": "Step-by-step explanation of your decomposition strategy",
  "estimatedCost": 0.05,
  "estimatedTime": 120,
  "summary": "Human-readable plan summary",
  "nodes": [
    {
      "id": "unique-id",
      "type": "AGENT | TOOL | ROUTER | PARALLEL | JOIN | CODING_AGENT",
      "label": "Human-readable label",
      "dependsOn": ["ids-of-prerequisite-nodes"],
      "timeout": 300,
      "retries": 1,
      "fallbackNodeId": null,
      "agent": {
        "model": "model-name",
        "task": "Detailed task description for this worker",
        "tools": ["tool-names"],
        "skillIds": ["skill-ids"],
        "tokenBudget": 200000
      },
      "codingAgent": {
        "task": "Detailed coding task description",
        "model": "model-name (optional, uses default)",
        "cwd": "/path/to/project (optional)",
        "systemPrompt": "Additional instructions to append to Claude Code prompt (optional)",
        "allowedTools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        "maxTurns": 30,
        "agents": {
          "subagent-name": {
            "description": "What this subagent does",
            "prompt": "System prompt for the subagent",
            "tools": ["Read", "Edit", "Bash"]
          }
        }
      },
      "tool": {
        "name": "shell-command-to-execute (e.g. curl, grep, cat — NOT built-in tools like write/read)",
        "params": { "key": "value" }
      },
      "router": {
        "condition": "state-key-to-check",
        "routes": {
          "value1": "target-node-id",
          "default": "fallback-node-id"
        }
      }
    }
  ]
}
\`\`\`

Only include the relevant config key (agent/tool/router/codingAgent) for each node type.
Every node must have: id, type, label, dependsOn (array, can be empty).
For CODING_AGENT nodes, include the "codingAgent" key (not "agent"). CODING_AGENT nodes get the full Claude Code toolset and are the PREFERRED choice for any coding/engineering task.

## ${discoveredModels?.length ? buildModelGuide(discoveredModels, mainModel ?? this.config.model) : `Available models: Use "${mainModel ?? this.config.model}" for all workers.`}
${skillsList}${memoriesList}${filesList}${infraContext ? `\n\n## Known Context (from memory — DO NOT create discovery nodes for this)\n${infraContext}` : ''}

## Task
${task}

Respond ONLY with the JSON object. No markdown fences, no commentary.`;
  }

  // ── Private helpers ──────────────────────────────────────────────

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
   * Builds a single-node fallback plan when the LLM planner fails.
   */
  private fallbackPlan(task: string, reason: string): PlannerOutput {
    // Fallback uses the main agent model — always the configured default, never hardcoded
    const appConfig = readConfig();
    const fallbackModel = appConfig.models.default || this.config.model;

    const node: WorkflowNode = {
      id: 'worker-1',
      type: 'AGENT',
      label: 'Primary Worker',
      agent: {
        model: fallbackModel,
        task,
      },
      dependsOn: [],
      status: 'pending',
    };

    const graph = buildGraph([node], task.slice(0, 80));

    return {
      graph,
      reasoning: `Single-worker fallback plan. Reason: ${reason}`,
      estimatedCost: 0,
      estimatedTime: 0,
      summary: `Execute task with one agent worker: "${task.slice(0, 120)}"`,
    };
  }
}

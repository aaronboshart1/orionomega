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
    const systemPrompt = this.buildPlannerPrompt(task, context);

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
                  (n.agent as Record<string, unknown>).model ?? model,
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
  buildPlannerPrompt(task: string, context?: object): string {
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
3. **Use TOOL nodes sparingly** — only for shell commands (e.g. exec). For file operations, writing documents, web searches, etc., use AGENT nodes — they have built-in tools: exec (shell), read (files), write (files), edit (files). Skills may also provide: web_search, web_fetch. AGENT nodes should handle almost all work.
4. **Use ROUTER nodes for conditional logic.** When the next step depends on a previous result, use a ROUTER with condition and routes.
5. **Model assignment guidelines:**
   - Use the planner model for complex reasoning, code generation, and creative writing.
   - Use a lighter model (e.g. haiku) for data gathering, simple lookups, and formatting.
6. **Maximum ${this.config.maxWorkers ?? 8} concurrent workers** per layer.
7. **Always include a JOIN node** when multiple paths converge to a single output.
8. **Set reasonable timeouts** (in seconds) for each node based on expected duration.
9. **Set retries** for nodes that might fail transiently (network calls, API requests).
10. **Set fallbackNodeId** for critical nodes where an alternative approach exists.

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
      "type": "AGENT | TOOL | ROUTER | PARALLEL | JOIN",
      "label": "Human-readable label",
      "dependsOn": ["ids-of-prerequisite-nodes"],
      "timeout": 300,
      "retries": 1,
      "fallbackNodeId": null,
      "agent": {
        "model": "model-name",
        "task": "Detailed task description for this worker",
        "tools": ["tool-names"],
        "skillIds": ["skill-ids"]
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

Only include the relevant config key (agent/tool/router) for each node type.
Every node must have: id, type, label, dependsOn (array, can be empty).
${skillsList}${memoriesList}${filesList}

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
    const node: WorkflowNode = {
      id: 'worker-1',
      type: 'AGENT',
      label: 'Primary Worker',
      agent: {
        model: this.config.model,
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

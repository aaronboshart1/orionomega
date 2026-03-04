/**
 * @module orchestration/planner
 * Task decomposition and workflow graph generation.
 *
 * Currently a stub — the LLM planner integration is not yet connected.
 * The `buildPlannerPrompt()` method contains the full prompt that will be
 * sent to the Anthropic API when the planner is wired up.
 */

import type { PlannerOutput, WorkflowNode } from './types.js';
import { buildGraph } from './graph.js';

/** Configuration for the planner. */
export interface PlannerConfig {
  /** Model identifier for the planner LLM. */
  model: string;
  /** Maximum number of concurrent workers. Defaults to 8. */
  maxWorkers?: number;
}

/**
 * Decomposes a task description into a workflow graph.
 *
 * In its current stub form, every task is planned as a single AGENT node.
 * When the Anthropic API integration is connected, `plan()` will call
 * the LLM with the prompt from `buildPlannerPrompt()` and parse the
 * response into a full multi-node WorkflowGraph.
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
    // TODO: Replace with actual LLM call using this.config.model
    // For now, build a single-node graph as a sensible default.

    const node: WorkflowNode = {
      id: 'worker-1',
      type: 'AGENT',
      label: 'Primary Worker',
      agent: {
        model: this.config.model,
        task,
        tools: context?.availableSkills,
      },
      dependsOn: [],
      status: 'pending',
    };

    const graph = buildGraph([node], task.slice(0, 80));

    return {
      graph,
      reasoning: 'Single-worker plan (LLM planner not yet connected)',
      estimatedCost: 0,
      estimatedTime: 0,
      summary: `Execute task with one agent worker: "${task.slice(0, 120)}"`,
    };
  }

  /**
   * Builds the full system prompt for the planner LLM.
   *
   * This prompt instructs the model to decompose a task into a WorkflowGraph
   * with parallel execution, tool nodes, router nodes, and model assignments.
   *
   * @param task - The task description.
   * @param context - Optional additional context (memories, skills, files).
   * @returns The complete system prompt string.
   */
  buildPlannerPrompt(task: string, context?: object): string {
    const ctx = context as {
      memories?: string[];
      availableSkills?: string[];
      workspaceFiles?: string[];
    } | undefined;

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
3. **Use TOOL nodes for deterministic work.** File operations, API calls with known parameters, data transformations — anything that doesn't need reasoning.
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
        "name": "tool-command",
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
}

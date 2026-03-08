/**
 * @module orchestration/worker
 * Worker process wrapper that executes a single workflow node.
 *
 * For AGENT nodes, runs the full Anthropic agent loop with streaming
 * callbacks that emit WorkerEvents through the EventBus.
 */

import { execFile } from 'node:child_process';
import type { WorkflowNode, WorkerEvent } from './types.js';
import type { EventBus } from './event-bus.js';
import { AnthropicClient } from '../anthropic/client.js';
import { runAgentLoop } from '../anthropic/agent-loop.js';
import { getBuiltInTools } from '../anthropic/tools.js';
import { readConfig } from '../config/loader.js';
import { SkillLoader } from '@orionomega/skills-sdk';
import { executeCodingAgent } from './agent-sdk-bridge.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('worker');

/** The result returned when a worker completes execution. */
export interface WorkerResult {
  /** The node that was executed. */
  nodeId: string;
  /** Output data produced by the worker. */
  output: unknown;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Number of tool calls made (for agent workers). */
  toolCallCount: number;
  /** Notable findings discovered during execution. */
  findings: string[];
  /** Paths to files written by this worker. */
  outputPaths: string[];
}

/**
 * Wraps the execution of a single workflow node, emitting structured events
 * through the EventBus as work progresses.
 *
 * For AGENT nodes, runs the Anthropic agent loop with built-in tools.
 * For TOOL nodes, the configured command is executed via child_process.
 */
export class WorkerProcess {
  private readonly node: WorkflowNode;
  private readonly eventBus: EventBus;
  private readonly workspaceDir: string;
  private readonly timeout: number;

  private cancelled = false;
  private currentStatus: string = 'pending';
  private currentProgress = 0;
  private lastEvent: WorkerEvent | undefined;
  private readonly events: WorkerEvent[] = [];
  private readonly context: string | undefined;

  constructor(
    node: WorkflowNode,
    eventBus: EventBus,
    options: { workspaceDir: string; timeout: number; context?: string },
  ) {
    this.node = node;
    this.eventBus = eventBus;
    this.workspaceDir = options.workspaceDir;
    this.timeout = options.timeout;
    this.context = options.context;
  }

  /**
   * Executes the worker based on the node type.
   *
   * @returns The result of the execution.
   * @throws If the node type is unsupported or execution fails.
   */
  async run(): Promise<WorkerResult> {
    const start = Date.now();
    this.currentStatus = 'running';

    try {
      let result: WorkerResult;

      switch (this.node.type) {
        case 'AGENT':
          result = await this.runAgent();
          break;
        case 'TOOL':
          result = await this.runTool();
          break;
        case 'CODING_AGENT':
          result = await this.runCodingAgent();
          break;
        default:
          // ROUTER, PARALLEL, JOIN are structural — pass-through
          result = {
            nodeId: this.node.id,
            output: null,
            durationMs: Date.now() - start,
            toolCallCount: 0,
            findings: [],
            outputPaths: [],
          };
          break;
      }

      result.durationMs = Date.now() - start;
      this.currentStatus = 'done';
      this.currentProgress = 100;
      return result;
    } catch (err) {
      this.currentStatus = 'error';
      this.emitEvent({
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
        message: `Failed: ${this.node.label}`,
      });
      throw err;
    }
  }

  /**
   * Cancels the worker. Currently running work will be abandoned
   * at the next cancellation check point.
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Returns the current execution status of the worker.
   */
  getStatus(): { status: string; progress: number; lastEvent?: WorkerEvent } {
    return {
      status: this.currentStatus,
      progress: this.currentProgress,
      lastEvent: this.lastEvent,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Emits a WorkerEvent through the EventBus and tracks it internally.
   */
  private emitEvent(
    partial: Omit<WorkerEvent, 'workerId' | 'nodeId' | 'timestamp'>,
  ): void {
    const event: WorkerEvent = {
      workerId: this.node.id,
      nodeId: this.node.id,
      timestamp: new Date().toISOString(),
      ...partial,
    };

    if (event.progress !== undefined) {
      this.currentProgress = event.progress;
    }

    this.lastEvent = event;
    this.events.push(event);
    this.eventBus.emit(event);
  }

  /**
   * Truncates a string for event summaries (max 100 chars).
   */
  private summarize(text: string, max: number = 100): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 3) + '...';
  }

  /**
   * Resolves the model to use for this worker.
   *
   * Priority:
   * 1. Explicit model ID in agent config (from planner) — used as-is if it looks like an ID
   * 2. Tier hint (lightweight/midweight/heavyweight) — resolved via cached model discovery
   * 3. Config workers map (if populated)
   * 4. Config default model
   *
   * Tier hints allow skill manifests and planner to specify intent without hardcoding model IDs.
   */
  private resolveWorkerModel(): string {
    const config = readConfig();
    const agentConfig = this.node.agent;

    if (agentConfig?.model) {
      const model = agentConfig.model;

      // Check if it looks like a real model ID (contains a hyphen and digits)
      if (model.includes('-') && /\d/.test(model)) {
        return model;
      }

      // Resolve tier hints to the configured default or a tier-based mapping
      const tierMap: Record<string, 'haiku' | 'sonnet' | 'opus'> = {
        'lightweight': 'haiku',
        'light': 'haiku',
        'haiku': 'haiku',
        'midweight': 'sonnet',
        'mid': 'sonnet',
        'sonnet': 'sonnet',
        'default': 'sonnet',
        'heavyweight': 'opus',
        'heavy': 'opus',
        'opus': 'opus',
        'planner': 'opus',
        // Task-type aliases map to tiers
        'research': 'haiku',
        'data': 'haiku',
        'analysis': 'sonnet',
        'code': 'sonnet',
        'writing': 'sonnet',
      };

      const tier = tierMap[model.toLowerCase()];
      if (tier) {
        // Try workers map first (user may have explicit overrides)
        const workerModel = config.models.workers?.[tier] || config.models.workers?.[model];
        if (workerModel) return workerModel;

        // Fall back to the default model — model discovery happens at planner level,
        // so the planner should have already assigned real model IDs.
        // This is a safety net for skill-triggered workers.
        return config.models.default;
      }

      // Check workers map for custom keys
      const workerModel = config.models.workers?.[model];
      if (workerModel) return workerModel;

      return config.models.default;
    }

    return config.models.default;
  }

  /**
   * Executes an AGENT node using the Anthropic agent loop.
   */
  private async runAgent(): Promise<WorkerResult> {
    if (this.cancelled) return this.cancelledResult();

    const config = readConfig();
    const apiKey = config.models.apiKey;

    if (!apiKey) {
      throw new Error(
        'No Anthropic API key configured. Set models.apiKey in config.',
      );
    }

    const client = new AnthropicClient(apiKey);
    const model = this.resolveWorkerModel();
    const agentConfig = this.node.agent!;
    const tools = getBuiltInTools();

    // Load skill tools for any assigned skillIds
    if (agentConfig.skillIds?.length) {
      const config = readConfig();
      const skillsDir = config.skills?.directory;
      if (skillsDir) {
        try {
          const skillLoader = new SkillLoader(skillsDir);
          for (const skillId of agentConfig.skillIds) {
            try {
              const loaded = await skillLoader.load(skillId);
              for (const skillTool of loaded.tools) {
                // Convert RegisteredTool to BuiltInTool format
                tools.push({
                  name: skillTool.name,
                  description: skillTool.description,
                  inputSchema: skillTool.inputSchema,
                  execute: async (params: Record<string, unknown>): Promise<string> => {
                    const result = await skillTool.execute(params);
                    if (typeof result === "string") return result;
                    if (result && typeof result === "object" && "result" in result) {
                      return String((result as { result: unknown }).result);
                    }
                    if (result && typeof result === "object" && "error" in result) {
                      return `Error: ${String((result as { error: unknown }).error)}`;
                    }
                    return JSON.stringify(result);
                  },
                });
              }
            } catch (err) {
              log.warn(`Failed to load skill tools for "${skillId}"`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (err) {
          log.warn("Failed to initialise SkillLoader for skill tools", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }


    // Build the system prompt
    const systemPrompt = await this.buildWorkerSystemPrompt(agentConfig);

    this.emitEvent({
      type: 'status',
      message: `Starting: ${this.node.label} (${model})`,
      progress: 0,
    });

    log.info(
      `Worker ${this.node.id} starting with model ${model}: "${agentConfig.task.slice(0, 80)}"`,
    );

    let progressEstimate = 5;
    const findings: string[] = [];
    const outputPaths: string[] = [];

    // Determine token budget: explicit > tier-based default
    const tokenBudget = agentConfig.tokenBudget ?? this.defaultTokenBudget(model);

    const result = await runAgentLoop({
      client,
      model,
      systemPrompt,
      tools,
      messages: [{ role: 'user', content: agentConfig.task }],
      maxTokens: 8192,
      maxInputTokens: tokenBudget,
      workingDir: this.workspaceDir,
      isCancelled: () => this.cancelled,

      onThinking: (text: string) => {
        this.emitEvent({
          type: 'thinking',
          thinking: this.summarize(text),
          progress: Math.min(progressEstimate, 90),
        });
      },

      onText: (text: string) => {
        // Only emit status events for substantial text chunks
        if (text.trim().length > 10) {
          this.emitEvent({
            type: 'status',
            message: this.summarize(text.trim()),
            progress: Math.min(progressEstimate, 95),
          });
        }
      },

      onToolCall: (name: string, input: Record<string, unknown>) => {
        progressEstimate = Math.min(progressEstimate + 5, 90);

        // Track file writes for output reporting
        if (name === 'write' && input.path) {
          outputPaths.push(String(input.path));
        }

        // Build a concise summary of tool params
        let summary = name;
        if (name === 'exec' && input.command) {
          summary = `exec: ${this.summarize(String(input.command), 80)}`;
        } else if (name === 'read' && input.path) {
          summary = `read: ${String(input.path)}`;
        } else if (name === 'write' && input.path) {
          summary = `write: ${String(input.path)}`;
        } else if (name === 'edit' && input.path) {
          summary = `edit: ${String(input.path)}`;
        } else if (name === 'web_fetch' && input.url) {
          summary = `fetch: ${this.summarize(String(input.url), 80)}`;
        }

        this.emitEvent({
          type: 'tool_call',
          tool: {
            name,
            action: name,
            file: input.path ? String(input.path) : undefined,
            summary,
          },
          message: summary,
          progress: progressEstimate,
        });
      },

      onToolResult: (name: string, resultText: string) => {
        progressEstimate = Math.min(progressEstimate + 3, 95);

        this.emitEvent({
          type: 'tool_result',
          tool: {
            name,
            action: name,
            summary: this.summarize(resultText),
          },
          message: this.summarize(resultText, 80),
          progress: progressEstimate,
        });
      },
    });

    const cacheHitRate = result.inputTokens > 0
      ? Math.round((result.cacheReadTokens / result.inputTokens) * 100)
      : 0;

    this.emitEvent({
      type: 'done',
      message: `Completed: ${this.node.label}${result.stoppedByBudget ? ' (budget reached)' : ''}`,
      progress: 100,
      data: {
        toolCalls: result.toolCalls,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheHitRate,
        stoppedByBudget: result.stoppedByBudget,
      },
    });

    log.info(
      `Worker ${this.node.id} completed: ${result.toolCalls} tool calls, ` +
        `${result.inputTokens}+${result.outputTokens} tokens ` +
        `(cache: ${result.cacheReadTokens} read, ${result.cacheCreationTokens} created, ${cacheHitRate}% hit rate)` +
        `${result.stoppedByBudget ? ' [BUDGET REACHED]' : ''}`,
    );

    return {
      nodeId: this.node.id,
      output: result.finalText,
      durationMs: 0, // filled by run()
      toolCallCount: result.toolCalls,
      findings,
      outputPaths,
    };
  }

  /**
   * Builds the system prompt for a worker agent.
   *
   * Loads SKILL.md documentation for any skillIds assigned to the node
   * and prepends it to the prompt so the worker has full tool context.
   */
  private async buildWorkerSystemPrompt(agentConfig: {
    task: string;
    systemPrompt?: string;
    skillIds?: string[];
  }): Promise<string> {
    // If there's an explicit system prompt override, use it
    if (agentConfig.systemPrompt) {
      return agentConfig.systemPrompt;
    }

    // Load SKILL.md content for any assigned skills
    let skillDocs = '';
    if (agentConfig.skillIds?.length) {
      const config = readConfig();
      const skillsDir = config.skills?.directory;
      if (skillsDir) {
        try {
          const loader = new SkillLoader(skillsDir);
          const docs: string[] = [];
          for (const skillId of agentConfig.skillIds) {
            try {
              const loaded = await loader.load(skillId);
              // Prefer prompts/worker.md over SKILL.md for workers
              const doc = loaded.workerPrompt || loaded.skillDoc;
              if (doc) {
                docs.push(`## Skill: ${skillId}\n${doc}`);
              }
            } catch (err) {
              log.warn(`Failed to load skill "${skillId}" for worker prompt`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (docs.length) {
            skillDocs = `\n\n# Skill Documentation\n${docs.join('\n\n')}`;
          }
        } catch (err) {
          log.warn('Failed to initialise SkillLoader for worker', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const contextSection = this.context
      ? `## Relevant Context\n${this.context}\n\n`
      : '';

    return `You are a focused worker agent in the OrionOmega orchestration system.

${contextSection}## Your Task
${agentConfig.task}

## Rules
1. Complete the task thoroughly and deliver clear output.
2. Use the available tools (exec, read, write, edit) and any skill tools as needed.
3. Be efficient — avoid unnecessary tool calls.
4. If you encounter an error, try to recover or work around it.
5. When done, provide a clear summary of what you accomplished and any notable findings.

## Working Directory
All relative paths are resolved against the workspace directory.
Use absolute paths when referencing files outside the workspace.${skillDocs}`;
  }

  /**
   * Executes a TOOL node by running the configured command via child_process.
   */
  private async runCodingAgent(): Promise<WorkerResult> {
    const workDir = `${this.workspaceDir}/output/${this.node.id}`;

    this.emitEvent({
      type: 'status',
      message: `Coding agent starting`,
      progress: 0,
    });

    const result = await executeCodingAgent(this.node, workDir, (evt) => {
      this.emitEvent({
        type: evt.type as WorkerEvent['type'],
        message: evt.message,
        progress: evt.progress,
      });
    });

    if (!result.success) {
      throw new Error(result.error ?? 'Coding agent failed');
    }

    this.emitEvent({
      type: 'done',
      message: `Coding agent complete: ${result.toolCalls} tool calls`,
      progress: 100,
    });

    return {
      nodeId: this.node.id,
      output: result.output,
      durationMs: result.durationSec * 1000,
      toolCallCount: result.toolCalls,
      findings: [],
      outputPaths: [],
    };
  }

  private async runTool(): Promise<WorkerResult> {
    const toolConfig = this.node.tool;
    if (!toolConfig) {
      throw new Error(
        `TOOL node '${this.node.id}' missing tool configuration`,
      );
    }

    this.emitEvent({
      type: 'status',
      message: `Running tool: ${toolConfig.name}`,
      progress: 0,
    });

    const output = await new Promise<string>((resolve, reject) => {
      const args = Object.entries(toolConfig.params).map(
        ([k, v]) => `--${k}=${String(v)}`,
      );

      const child = execFile(
        toolConfig.name,
        args,
        {
          cwd: this.workspaceDir,
          timeout: this.timeout * 1000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `Tool '${toolConfig.name}' failed: ${error.message}\n${stderr}`,
              ),
            );
          } else {
            resolve(stdout);
          }
        },
      );

      // If cancelled, kill the child process
      const checkCancel = setInterval(() => {
        if (this.cancelled) {
          child.kill('SIGTERM');
          clearInterval(checkCancel);
        }
      }, 500);

      child.on('close', () => clearInterval(checkCancel));
    });

    this.emitEvent({
      type: 'done',
      message: `Tool '${toolConfig.name}' completed`,
      progress: 100,
    });

    return {
      nodeId: this.node.id,
      output,
      durationMs: 0,
      toolCallCount: 1,
      findings: [],
      outputPaths: [],
    };
  }

  /**
   * Returns a default token budget based on the model tier.
   * Infers tier from model name — same family-name convention as model-discovery.
   */
  private defaultTokenBudget(model: string): number {
    const lower = model.toLowerCase();
    if (lower.includes('haiku')) return 100_000;
    if (lower.includes('opus')) return 500_000;
    // Sonnet and unknown default to midweight budget
    return 300_000;
  }

  /** Returns a result representing a cancelled worker. */
  private cancelledResult(): WorkerResult {
    return {
      nodeId: this.node.id,
      output: null,
      durationMs: 0,
      toolCallCount: 0,
      findings: [],
      outputPaths: [],
    };
  }
}

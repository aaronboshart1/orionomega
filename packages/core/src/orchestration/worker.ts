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

  constructor(
    node: WorkflowNode,
    eventBus: EventBus,
    options: { workspaceDir: string; timeout: number },
  ) {
    this.node = node;
    this.eventBus = eventBus;
    this.workspaceDir = options.workspaceDir;
    this.timeout = options.timeout;
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
        default:
          // ROUTER, PARALLEL, JOIN are structural — pass-through
          result = {
            nodeId: this.node.id,
            output: null,
            durationMs: Date.now() - start,
            toolCallCount: 0,
            findings: [],
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
   * Checks config.models.workers[profile] first (profile from skill's
   * workerProfile), then falls back to config.models.default.
   */
  private resolveWorkerModel(): string {
    const config = readConfig();
    const agentConfig = this.node.agent;

    // If the node has an explicit model, use it
    if (agentConfig?.model) {
      return agentConfig.model;
    }

    // Try to find a profile-based model
    // Skills could set a workerProfile — for now we check skillIds
    if (agentConfig?.skillIds?.length) {
      // Use the first skill ID as a potential profile hint
      for (const skillId of agentConfig.skillIds) {
        const profileModel = config.models.workers[skillId];
        if (profileModel) return profileModel;
      }
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

    // Build the system prompt
    const systemPrompt = this.buildWorkerSystemPrompt(agentConfig);

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

    const result = await runAgentLoop({
      client,
      model,
      systemPrompt,
      tools,
      messages: [{ role: 'user', content: agentConfig.task }],
      maxTokens: 8192,
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

    this.emitEvent({
      type: 'done',
      message: `Completed: ${this.node.label}`,
      progress: 100,
      data: {
        toolCalls: result.toolCalls,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    });

    log.info(
      `Worker ${this.node.id} completed: ${result.toolCalls} tool calls, ` +
        `${result.inputTokens}+${result.outputTokens} tokens`,
    );

    return {
      nodeId: this.node.id,
      output: result.finalText,
      durationMs: 0, // filled by run()
      toolCallCount: result.toolCalls,
      findings,
    };
  }

  /**
   * Builds the system prompt for a worker agent.
   */
  private buildWorkerSystemPrompt(agentConfig: {
    task: string;
    systemPrompt?: string;
    skillIds?: string[];
  }): string {
    // If there's an explicit system prompt override, use it
    if (agentConfig.systemPrompt) {
      return agentConfig.systemPrompt;
    }

    return `You are a focused worker agent in the OrionOmega orchestration system.

## Your Task
${agentConfig.task}

## Rules
1. Complete the task thoroughly and deliver clear output.
2. Use the available tools (exec, read, write, edit, web_fetch) as needed.
3. Be efficient — avoid unnecessary tool calls.
4. If you encounter an error, try to recover or work around it.
5. When done, provide a clear summary of what you accomplished and any notable findings.

## Working Directory
All relative paths are resolved against the workspace directory.
Use absolute paths when referencing files outside the workspace.`;
  }

  /**
   * Executes a TOOL node by running the configured command via child_process.
   */
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
    };
  }

  /** Returns a result representing a cancelled worker. */
  private cancelledResult(): WorkerResult {
    return {
      nodeId: this.node.id,
      output: null,
      durationMs: 0,
      toolCallCount: 0,
      findings: [],
    };
  }
}

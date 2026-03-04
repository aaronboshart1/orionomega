/**
 * @module orchestration/worker
 * Worker process wrapper that executes a single workflow node.
 */

import { execFile } from 'node:child_process';
import type { WorkflowNode, WorkerEvent } from './types.js';
import type { EventBus } from './event-bus.js';

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
 * For AGENT nodes, execution is currently a placeholder that simulates
 * the event sequence. For TOOL nodes, the configured command is executed
 * via child_process.
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
   * Placeholder agent execution.
   *
   * Simulates the full event sequence (thinking → tool_call → tool_result →
   * finding → done) that a real LLM-backed agent would produce.
   *
   * TODO: Replace with actual Anthropic API call.
   */
  private async runAgent(): Promise<WorkerResult> {
    if (this.cancelled) return this.cancelledResult();

    this.emitEvent({
      type: 'status',
      message: `Starting: ${this.node.label}`,
      progress: 0,
    });

    this.emitEvent({
      type: 'thinking',
      thinking: `Planning approach for: ${this.node.agent!.task}`,
      progress: 10,
    });

    if (this.cancelled) return this.cancelledResult();

    this.emitEvent({
      type: 'tool_call',
      tool: {
        name: 'placeholder',
        action: 'execute',
        summary: `Simulated tool call for task: ${this.node.agent!.task}`,
      },
      message: 'Executing tool...',
      progress: 30,
    });

    if (this.cancelled) return this.cancelledResult();

    this.emitEvent({
      type: 'tool_result',
      tool: {
        name: 'placeholder',
        action: 'execute',
        summary: 'Tool execution complete',
      },
      message: 'Tool returned results',
      progress: 50,
    });

    this.emitEvent({
      type: 'finding',
      message: `Placeholder finding for: ${this.node.label}`,
      data: { placeholder: true },
      progress: 70,
    });

    if (this.cancelled) return this.cancelledResult();

    this.emitEvent({
      type: 'status',
      message: 'Processing...',
      progress: 90,
    });

    this.emitEvent({
      type: 'done',
      message: `Completed: ${this.node.label}`,
      progress: 100,
    });

    return {
      nodeId: this.node.id,
      output: { placeholder: true, task: this.node.agent!.task },
      durationMs: 0,
      toolCallCount: 1,
      findings: [`Placeholder finding for: ${this.node.label}`],
    };
  }

  /**
   * Executes a TOOL node by running the configured command via child_process.
   */
  private async runTool(): Promise<WorkerResult> {
    const toolConfig = this.node.tool;
    if (!toolConfig) {
      throw new Error(`TOOL node '${this.node.id}' missing tool configuration`);
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
            reject(new Error(`Tool '${toolConfig.name}' failed: ${error.message}\n${stderr}`));
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

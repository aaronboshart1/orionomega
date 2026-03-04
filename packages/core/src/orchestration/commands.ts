/**
 * @module orchestration/commands
 * Command handler for runtime orchestration control (stop, status, pause, etc.).
 */

import type { GraphExecutor } from './executor.js';

/** Result of handling an orchestrator command. */
export interface OrchestratorCommandResult {
  /** Whether the command succeeded. */
  success: boolean;
  /** Human-readable result message. */
  message: string;
  /** Optional data payload. */
  data?: unknown;
}

/**
 * Handles slash-commands for controlling a running workflow execution.
 *
 * Supported commands:
 * - `/stop` — stops the workflow
 * - `/status` — returns current execution state
 * - `/plan` — returns a summary of the workflow graph
 * - `/workers` — lists active workers
 * - `/pause` — pauses execution before the next layer
 * - `/resume` — resumes a paused execution
 */
export class OrchestratorCommands {
  private executor: GraphExecutor | null;

  constructor(executor: GraphExecutor | null = null) {
    this.executor = executor;
  }

  /**
   * Sets the active executor instance.
   *
   * @param executor - The graph executor to control.
   */
  setExecutor(executor: GraphExecutor): void {
    this.executor = executor;
  }

  /**
   * Handles a command string and returns the result.
   *
   * @param command - The command to handle (e.g. '/status', '/stop').
   * @returns The command result.
   */
  async handle(command: string): Promise<OrchestratorCommandResult> {
    const cmd = command.trim().toLowerCase();

    if (!this.executor) {
      return {
        success: false,
        message: 'No active workflow. Start a workflow first.',
      };
    }

    switch (cmd) {
      case '/stop':
        return this.handleStop();

      case '/status':
        return this.handleStatus();

      case '/plan':
        return this.handlePlan();

      case '/workers':
        return this.handleWorkers();

      case '/pause':
        return this.handlePause();

      case '/resume':
        return this.handleResume();

      default:
        return {
          success: false,
          message: `Unknown command: '${cmd}'. Available: /stop, /status, /plan, /workers, /pause, /resume`,
        };
    }
  }

  // ── Command implementations ──────────────────────────────────────

  private handleStop(): OrchestratorCommandResult {
    this.executor!.stop();
    return {
      success: true,
      message: 'Stop requested. Active workers will finish, then the workflow will return partial results.',
    };
  }

  private handleStatus(): OrchestratorCommandResult {
    const state = this.executor!.getState();
    const nodeStatuses = Object.values(state.nodes)
      .map((n) => `  ${n.label} [${n.type}]: ${n.status}${n.progress != null ? ` (${n.progress}%)` : ''}`)
      .join('\n');

    const message = [
      `Workflow: ${state.name}`,
      `Status: ${state.status}`,
      `Progress: ${state.completedLayers}/${state.totalLayers} layers`,
      `Elapsed: ${state.elapsed.toFixed(1)}s`,
      `Nodes:\n${nodeStatuses}`,
    ].join('\n');

    return { success: true, message, data: state };
  }

  private handlePlan(): OrchestratorCommandResult {
    const state = this.executor!.getState();
    const nodes = Object.values(state.nodes);
    const summary = [
      `Workflow: ${state.name}`,
      `Layers: ${state.totalLayers}`,
      `Nodes (${nodes.length}):`,
      ...nodes.map((n) => {
        const deps = n.dependsOn.length > 0 ? ` ← [${n.dependsOn.join(', ')}]` : '';
        return `  ${n.id}: ${n.label} [${n.type}]${deps}`;
      }),
    ].join('\n');

    return { success: true, message: summary };
  }

  private handleWorkers(): OrchestratorCommandResult {
    const workers = this.executor!.getActiveWorkers();
    if (workers.size === 0) {
      return { success: true, message: 'No active workers.' };
    }

    const lines: string[] = [];
    for (const [id, worker] of workers) {
      const status = worker.getStatus();
      lines.push(`  ${id}: ${status.status} (${status.progress}%)`);
    }

    return {
      success: true,
      message: `Active workers (${workers.size}):\n${lines.join('\n')}`,
      data: Object.fromEntries(
        [...workers.entries()].map(([id, w]) => [id, w.getStatus()]),
      ),
    };
  }

  private handlePause(): OrchestratorCommandResult {
    this.executor!.pause();
    return {
      success: true,
      message: 'Pause requested. Execution will pause before the next layer.',
    };
  }

  private handleResume(): OrchestratorCommandResult {
    this.executor!.resume();
    return {
      success: true,
      message: 'Resumed.',
    };
  }
}

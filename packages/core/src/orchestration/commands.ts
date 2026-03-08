/**
 * @module orchestration/commands
 * Command handler for runtime orchestration control (stop, status, pause, etc.).
 *
 * Supports concurrent workflows — commands that are ambiguous when multiple
 * workflows are running will prompt the user to qualify with a name or ID prefix.
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
 * Handles slash-commands for controlling running workflow executions.
 *
 * Maintains a Map of active workflows so multiple concurrent workflows can be
 * addressed individually or in aggregate.
 *
 * Supported commands:
 * - `/workflows`       — list all active workflows
 * - `/stop [hint|all]` — stop one or all workflows
 * - `/status [hint]`   — show execution state (all or one)
 * - `/plan [hint]`     — show the workflow graph summary
 * - `/workers [hint]`  — list active workers (all or one workflow)
 * - `/pause [hint]`    — pause before next layer
 * - `/resume [hint]`   — resume a paused workflow
 */
export class OrchestratorCommands {
  private readonly workflows: Map<string, { executor: GraphExecutor; name: string; startedAt: string }>;

  constructor() {
    this.workflows = new Map();
  }

  /**
   * Register a workflow executor.
   *
   * @param id - Workflow ID (from graph.id).
   * @param executor - The running executor instance.
   * @param name - Human-readable workflow name.
   */
  addWorkflow(id: string, executor: GraphExecutor, name: string): void {
    this.workflows.set(id, { executor, name, startedAt: new Date().toISOString() });
  }

  /**
   * Deregister a workflow when it completes or is stopped.
   *
   * @param id - Workflow ID to remove.
   */
  removeWorkflow(id: string): void {
    this.workflows.delete(id);
  }

  /**
   * Handles a command string and returns the result.
   *
   * @param command - The full command string (e.g. '/status', '/stop myworkflow').
   * @returns The command result.
   */
  async handle(command: string): Promise<OrchestratorCommandResult> {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim() || undefined;

    if (this.workflows.size === 0 && cmd !== '/workflows') {
      return { success: false, message: 'No active workflows.' };
    }

    switch (cmd) {
      case '/stop':     return this.handleStop(arg);
      case '/status':   return this.handleStatus(arg);
      case '/plan':     return this.handlePlan(arg);
      case '/workers':  return this.handleWorkers(arg);
      case '/pause':    return this.handlePause(arg);
      case '/resume':   return this.handleResume(arg);
      case '/workflows': return this.handleWorkflows();
      default:
        return {
          success: false,
          message: `Unknown command: '${cmd}'. Available: /workflows, /status, /stop, /pause, /resume, /plan, /workers`,
        };
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Resolve a workflow from an optional hint (ID prefix, fuzzy name, or nothing for single).
   * Returns null when the hint is ambiguous (multiple workflows, no qualifier).
   */
  private resolveWorkflow(hint?: string): { id: string; executor: GraphExecutor; name: string } | null {
    // No hint + exactly one workflow → unambiguous
    if (!hint && this.workflows.size === 1) {
      const [id, entry] = [...this.workflows.entries()][0];
      return { id, ...entry };
    }
    if (!hint) return null; // ambiguous

    // Try ID prefix match (full ID or first-8 hex chars)
    for (const [id, entry] of this.workflows) {
      if (id.startsWith(hint) || id.slice(0, 8) === hint) {
        return { id, ...entry };
      }
    }

    // Fuzzy name match (case-insensitive substring)
    const lower = hint.toLowerCase();
    for (const [id, entry] of this.workflows) {
      if (entry.name.toLowerCase().includes(lower)) {
        return { id, ...entry };
      }
    }

    return null;
  }

  /** /workflows — list all active workflows */
  private handleWorkflows(): OrchestratorCommandResult {
    if (this.workflows.size === 0) {
      return { success: true, message: 'No active workflows.' };
    }
    const lines = ['Active Workflows:', ''];
    for (const [id, entry] of this.workflows) {
      const state = entry.executor.getState();
      const shortId = id.slice(0, 8);
      lines.push(`  [${shortId}] ${entry.name}`);
      lines.push(`    Status: ${state.status} | Layer ${state.completedLayers}/${state.totalLayers} | ${state.elapsed.toFixed(1)}s`);
    }
    return { success: true, message: lines.join('\n') };
  }

  /** /status [hint] — show all or one workflow's status */
  private handleStatus(hint?: string): OrchestratorCommandResult {
    // No hint with multiple workflows → show all
    if (!hint && this.workflows.size > 1) {
      return this.handleWorkflows();
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };

    const state = wf.executor.getState();
    const nodeStatuses = Object.values(state.nodes)
      .map((n) => `  ${n.label} [${n.type}]: ${n.status}${n.progress != null ? ` (${n.progress}%)` : ''}`)
      .join('\n');

    const message = [
      `Workflow: ${state.name} [${wf.id.slice(0, 8)}]`,
      `Status: ${state.status}`,
      `Progress: ${state.completedLayers}/${state.totalLayers} layers`,
      `Elapsed: ${state.elapsed.toFixed(1)}s`,
      `Nodes:\n${nodeStatuses}`,
    ].join('\n');

    return { success: true, message, data: state };
  }

  /** /stop [hint|all] — stop one or all workflows */
  private handleStop(hint?: string): OrchestratorCommandResult {
    if (hint?.toLowerCase() === 'all') {
      for (const [, entry] of this.workflows) entry.executor.stop();
      return { success: true, message: `Stop requested for all ${this.workflows.size} workflow(s).` };
    }
    if (!hint && this.workflows.size > 1) {
      return {
        success: false,
        message: 'Multiple workflows running. Use /stop <name>, /stop <id>, or /stop all.\n' + this.listWorkflowHints(),
      };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };
    wf.executor.stop();
    return { success: true, message: `Stop requested for "${wf.name}".` };
  }

  /** /pause [hint] — pause one workflow */
  private handlePause(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      return {
        success: false,
        message: 'Multiple workflows running. Use /pause <name>.\n' + this.listWorkflowHints(),
      };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };
    wf.executor.pause();
    return { success: true, message: `Pause requested for "${wf.name}".` };
  }

  /** /resume [hint] — resume a paused workflow */
  private handleResume(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      return {
        success: false,
        message: 'Multiple workflows running. Use /resume <name>.\n' + this.listWorkflowHints(),
      };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };
    wf.executor.resume();
    return { success: true, message: `Resumed "${wf.name}".` };
  }

  /** /plan [hint] — show graph summary for a workflow */
  private handlePlan(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      return {
        success: false,
        message: 'Multiple workflows running. Use /plan <name>.\n' + this.listWorkflowHints(),
      };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };

    const state = wf.executor.getState();
    const nodes = Object.values(state.nodes);
    const summary = [
      `Workflow: ${state.name} [${wf.id.slice(0, 8)}]`,
      `Layers: ${state.totalLayers}`,
      `Nodes (${nodes.length}):`,
      ...nodes.map((n) => {
        const deps = n.dependsOn.length > 0 ? ` ← [${n.dependsOn.join(', ')}]` : '';
        return `  ${n.id}: ${n.label} [${n.type}]${deps}`;
      }),
    ].join('\n');

    return { success: true, message: summary };
  }

  /** /workers [hint] — list active workers across all or one workflow */
  private handleWorkers(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      // Show workers across ALL workflows
      const lines: string[] = [];
      for (const [id, entry] of this.workflows) {
        const workers = entry.executor.getActiveWorkers();
        lines.push(`${entry.name} [${id.slice(0, 8)}]:`);
        if (workers.size === 0) {
          lines.push('  No active workers.');
          continue;
        }
        for (const [wid, worker] of workers) {
          const st = worker.getStatus();
          lines.push(`  ${wid}: ${st.status} (${st.progress}%)`);
        }
      }
      return { success: true, message: lines.join('\n') || 'No active workers.' };
    }

    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };

    const workers = wf.executor.getActiveWorkers();
    if (workers.size === 0) {
      return { success: true, message: 'No active workers.' };
    }

    const lines = [...workers].map(([wid, w]) => {
      const st = w.getStatus();
      return `  ${wid}: ${st.status} (${st.progress}%)`;
    });

    return {
      success: true,
      message: `Workers (${workers.size}):\n${lines.join('\n')}`,
      data: Object.fromEntries([...workers.entries()].map(([id, w]) => [id, w.getStatus()])),
    };
  }

  private ambiguousMsg(hint?: string): string {
    if (!hint) return 'Multiple workflows running. Specify one:\n' + this.listWorkflowHints();
    return `No workflow matches "${hint}".\n` + this.listWorkflowHints();
  }

  private listWorkflowHints(): string {
    return [...this.workflows].map(([id, e]) => `  [${id.slice(0, 8)}] ${e.name}`).join('\n');
  }
}

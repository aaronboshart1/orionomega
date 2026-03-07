/**
 * @module orchestration/executor
 * Graph executor — walks topological layers, running nodes concurrently within each layer.
 */

import type {
  WorkflowGraph,
  WorkflowNode,
  GraphState,
  WorkflowStatus,
  ExecutionResult,
  WorkerEvent,
} from './types.js';
import type { EventBus } from './event-bus.js';
import { WorkflowState } from './state.js';
import { WorkerProcess, type WorkerResult } from './worker.js';
import { createLogger } from '../logging/logger.js';
import { readConfig } from '../config/loader.js';
import { HindsightClient } from '@orionomega/hindsight';

const log = createLogger('executor');

/** Configuration for the graph executor. */
export interface ExecutorConfig {
  /** Working directory for worker processes. */
  workspaceDir: string;
  /** Directory for state checkpoints. */
  checkpointDir: string;
  /** Default timeout per worker in seconds. */
  workerTimeout: number;
  /** Maximum retry attempts per node. */
  maxRetries: number;
  /** Checkpoint state every N layers. */
  checkpointInterval: number;
}

/**
 * Executes a WorkflowGraph layer-by-layer, running all nodes within a layer
 * concurrently. Supports pause/resume/stop, per-node retries and fallbacks,
 * router-based conditional routing, and periodic state checkpointing.
 */
export class GraphExecutor {
  private readonly graph: WorkflowGraph;
  private readonly eventBus: EventBus;
  private readonly config: ExecutorConfig;
  private readonly state: WorkflowState;

  private status: WorkflowStatus = 'planned';
  private readonly startedAt: string;
  private readonly activeWorkers = new Map<string, WorkerProcess>();
  private readonly nodeResults = new Map<string, WorkerResult>();
  private readonly nodeErrors = new Map<string, string>();
  private readonly skippedNodes = new Set<string>();
  private readonly decisions: string[] = [];
  private readonly findings: string[] = [];
  private readonly outputPaths: string[] = [];
  private readonly errors: { worker: string; message: string; resolution?: string }[] = [];
  private completedLayers = 0;

  // Control flags
  private pauseRequested = false;
  private stopRequested = false;
  private pauseResolve: (() => void) | null = null;
  private pausePromise: Promise<void> | null = null;

  constructor(
    graph: WorkflowGraph,
    eventBus: EventBus,
    config: ExecutorConfig,
  ) {
    this.graph = graph;
    this.eventBus = eventBus;
    this.config = config;
    this.startedAt = new Date().toISOString();
    this.state = new WorkflowState(graph.id, config.checkpointDir);
  }

  /**
   * Executes the full workflow graph.
   *
   * Iterates through topological layers sequentially. Within each layer,
   * all nodes are executed concurrently via `Promise.allSettled`.
   *
   * @returns The final execution result.
   */
  async execute(): Promise<ExecutionResult> {
    this.status = 'running';
    const startTime = Date.now();

    log.info(`Starting workflow: ${this.graph.name} (${this.graph.id})`);

    // Handle empty graph
    if (this.graph.layers.length === 0) {
      this.status = 'complete';
      return this.buildResult('complete', startTime);
    }

    try {
      for (let layerIdx = 0; layerIdx < this.graph.layers.length; layerIdx++) {
        // Check stop before each layer
        if (this.stopRequested) {
          this.status = 'stopped';
          log.info('Workflow stopped by user');
          return this.buildResult('stopped', startTime);
        }

        // Check pause before each layer
        if (this.pauseRequested) {
          this.status = 'paused';
          log.info('Workflow paused');
          this.emitOrchestrator('status', `Workflow paused before layer ${layerIdx + 1}`);
          await this.waitForResume();
          this.status = 'running';
          log.info('Workflow resumed');
        }

        const layer = this.graph.layers[layerIdx];
        const runnableNodes = layer.filter((id) => !this.skippedNodes.has(id));

        this.emitOrchestrator(
          'status',
          `Layer ${layerIdx + 1}/${this.graph.layers.length}: executing ${runnableNodes.length} node(s)`,
          { layer: layerIdx, nodes: runnableNodes },
        );

        // Execute all nodes in this layer concurrently
        const results = await Promise.allSettled(
          runnableNodes.map((nodeId) => this.executeNode(nodeId)),
        );

        // Process results
        for (let i = 0; i < runnableNodes.length; i++) {
          const nodeId = runnableNodes[i];
          const result = results[i];
          const node = this.graph.nodes.get(nodeId)!;

          if (result.status === 'fulfilled') {
            node.status = 'done';
            node.completedAt = new Date().toISOString();
            node.output = result.value.output;
            node.progress = 100;
            this.nodeResults.set(nodeId, result.value);
            this.state.setNodeOutput(nodeId, result.value.output);
            this.findings.push(...result.value.findings);
            if (result.value.outputPaths?.length) this.outputPaths.push(...result.value.outputPaths);
          } else {
            const errorMsg = result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
            node.status = 'error';
            node.error = errorMsg;
            this.nodeErrors.set(nodeId, errorMsg);
            this.errors.push({ worker: nodeId, message: errorMsg });
            log.warn(`Node '${nodeId}' failed: ${errorMsg}`);
          }
        }

        // Mark skipped nodes
        for (const nodeId of layer) {
          if (this.skippedNodes.has(nodeId)) {
            const node = this.graph.nodes.get(nodeId);
            if (node) node.status = 'skipped';
          }
        }

        // Evaluate router nodes to determine downstream skips
        this.evaluateRouters(layer);

        this.completedLayers = layerIdx + 1;
        this.state.completedLayers = this.completedLayers;

        // Periodic checkpointing
        if (
          this.config.checkpointInterval > 0 &&
          this.completedLayers % this.config.checkpointInterval === 0
        ) {
          await this.state.checkpoint();
          log.debug(`Checkpointed after layer ${this.completedLayers}`);
        }

        this.emitOrchestrator(
          'status',
          `Layer ${layerIdx + 1} complete`,
          { completedLayers: this.completedLayers },
        );
      }

      // Final checkpoint
      await this.state.checkpoint();

      const hasErrors = this.errors.length > 0;
      this.status = hasErrors ? 'error' : 'complete';
      return this.buildResult(hasErrors ? 'error' : 'complete', startTime);
    } catch (err) {
      this.status = 'error';
      log.error(`Workflow execution failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.buildResult('error', startTime);
    }
  }

  /**
   * Requests the executor to pause before the next layer.
   */
  pause(): void {
    this.pauseRequested = true;
    log.info('Pause requested');
  }

  /**
   * Resumes a paused executor.
   */
  resume(): void {
    this.pauseRequested = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
      this.pausePromise = null;
    }
    log.info('Resume requested');
  }

  /**
   * Requests the executor to stop. Active workers are allowed to finish,
   * then partial results are returned.
   */
  stop(): void {
    this.stopRequested = true;
    // Also resume if paused, so the loop can exit
    this.resume();
    log.info('Stop requested');
  }

  /**
   * Returns a snapshot of the current workflow execution state.
   */
  getState(): GraphState {
    const elapsed = (Date.now() - new Date(this.startedAt).getTime()) / 1000;
    const nodes: Record<string, WorkflowNode> = {};
    for (const [id, node] of this.graph.nodes) {
      nodes[id] = { ...node };
    }

    return {
      workflowId: this.graph.id,
      name: this.graph.name,
      status: this.status,
      createdAt: this.startedAt,
      elapsed,
      nodes,
      recentEvents: this.eventBus.getRecentEvents(20),
      completedLayers: this.completedLayers,
      totalLayers: this.graph.layers.length,
    };
  }

  /**
   * Returns the currently active worker processes.
   */
  getActiveWorkers(): Map<string, WorkerProcess> {
    return new Map(this.activeWorkers);
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Executes a single node, handling retries and fallbacks.
   */
  private async executeNode(nodeId: string): Promise<WorkerResult> {
    const node = this.graph.nodes.get(nodeId);
    if (!node) throw new Error(`Node '${nodeId}' not found in graph`);

    node.status = 'running';
    node.startedAt = new Date().toISOString();

    const maxRetries = node.retries ?? this.config.maxRetries;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.stopRequested) {
        return { nodeId, output: null, durationMs: 0, toolCallCount: 0, findings: [], outputPaths: [] };
      }

      try {
        if (attempt > 0) {
          log.info(`Retrying node '${nodeId}' (attempt ${attempt + 1}/${maxRetries + 1})`);
          this.emitOrchestrator('status', `Retrying '${node.label}' (attempt ${attempt + 1})`);
        }

        const result = await this.executeNodeByType(node);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(`Node '${nodeId}' attempt ${attempt + 1} failed: ${lastError.message}`);
      }
    }

    // Retries exhausted — try fallback
    if (node.fallbackNodeId) {
      const fallbackNode = this.graph.nodes.get(node.fallbackNodeId);
      if (fallbackNode) {
        log.info(`Executing fallback node '${node.fallbackNodeId}' for '${nodeId}'`);
        this.decisions.push(`Fallback: ${nodeId} → ${node.fallbackNodeId}`);
        this.emitOrchestrator(
          'status',
          `Fallback: '${node.label}' → '${fallbackNode.label}'`,
        );

        try {
          const result = await this.executeNodeByType(fallbackNode);
          fallbackNode.status = 'done';
          fallbackNode.completedAt = new Date().toISOString();
          return { ...result, nodeId };
        } catch (fallbackErr) {
          log.error(`Fallback node '${node.fallbackNodeId}' also failed`);
          this.errors.push({
            worker: node.fallbackNodeId,
            message: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            resolution: 'Fallback also failed',
          });
        }
      }
    }

    // All retries and fallback exhausted
    throw lastError ?? new Error(`Node '${nodeId}' failed with no retries or fallback`);
  }

  /**
   * Dispatches node execution based on its type.
   */
  private async executeNodeByType(node: WorkflowNode): Promise<WorkerResult> {
    switch (node.type) {
      case 'AGENT':
      case 'TOOL': {
        // For AGENT nodes, recall relevant memories from Hindsight and inject as context
        let injectedContext: string | undefined;
        if (node.type === 'AGENT' && node.agent?.task) {
          injectedContext = await this.recallContext(node.agent.task);
        }

        const worker = new WorkerProcess(node, this.eventBus, {
          workspaceDir: this.config.workspaceDir,
          timeout: node.timeout ?? this.config.workerTimeout,
          context: injectedContext,
        });
        this.activeWorkers.set(node.id, worker);

        try {
          const result = await worker.run();
          return result;
        } finally {
          this.activeWorkers.delete(node.id);
        }
      }

      case 'ROUTER':
        return this.executeRouter(node);

      case 'PARALLEL':
        // Structural pass-through
        return {
          nodeId: node.id,
          output: null,
          durationMs: 0,
          toolCallCount: 0,
          findings: [], outputPaths: [],
        };

      case 'JOIN':
        return this.executeJoin(node);

      default:
        throw new Error(`Unsupported node type: ${node.type}`);
    }
  }

  /**
   * Evaluates a ROUTER node's condition against the current state and
   * returns the route result.
   */
  private executeRouter(node: WorkflowNode): WorkerResult {
    const router = node.router;
    if (!router) {
      throw new Error(`ROUTER node '${node.id}' missing router configuration`);
    }

    // Evaluate condition against state
    // Simple evaluation: check if any state entry matches the condition string
    let selectedRoute = 'default';

    // Try to evaluate condition as a simple key lookup
    const stateEntry = this.state.get(router.condition);
    if (stateEntry) {
      const routeKey = String(stateEntry.value);
      if (router.routes[routeKey]) {
        selectedRoute = routeKey;
      }
    }

    const targetNodeId = router.routes[selectedRoute] ?? router.routes['default'];
    this.decisions.push(
      `Router '${node.label}': selected route '${selectedRoute}' → ${targetNodeId ?? 'none'}`,
    );

    return {
      nodeId: node.id,
      output: { route: selectedRoute, target: targetNodeId },
      durationMs: 0,
      toolCallCount: 0,
      findings: [], outputPaths: [],
    };
  }

  /**
   * Collects all upstream outputs for a JOIN node into an array.
   */
  private executeJoin(node: WorkflowNode): WorkerResult {
    const upstreamOutputs: unknown[] = [];
    for (const depId of node.dependsOn) {
      const output = this.state.getNodeOutput(depId);
      upstreamOutputs.push(output);
    }

    return {
      nodeId: node.id,
      output: upstreamOutputs,
      durationMs: 0,
      toolCallCount: 0,
      findings: [], outputPaths: [],
    };
  }

  /**
   * After a layer completes, evaluates any ROUTER nodes in that layer
   * and marks non-selected downstream paths as skipped.
   */
  private evaluateRouters(layer: string[]): void {
    for (const nodeId of layer) {
      const node = this.graph.nodes.get(nodeId);
      if (node?.type !== 'ROUTER' || node.status !== 'done') continue;

      const result = this.nodeResults.get(nodeId);
      if (!result?.output) continue;

      const routeOutput = result.output as { route: string; target?: string };
      const router = node.router;
      if (!router) continue;

      // Skip nodes that are targets of non-selected routes
      const selectedTarget = routeOutput.target;
      for (const [, targetId] of Object.entries(router.routes)) {
        if (targetId && targetId !== selectedTarget) {
          this.markSubtreeSkipped(targetId);
        }
      }
    }
  }

  /**
   * Recursively marks a node and all its exclusive dependents as skipped.
   */
  private markSubtreeSkipped(nodeId: string): void {
    if (this.skippedNodes.has(nodeId)) return;
    this.skippedNodes.add(nodeId);

    // Find nodes that depend exclusively on skipped nodes
    for (const [id, node] of this.graph.nodes) {
      if (
        node.dependsOn.includes(nodeId) &&
        node.dependsOn.every((dep) => this.skippedNodes.has(dep))
      ) {
        this.markSubtreeSkipped(id);
      }
    }
  }

  /** Waits until resume() is called. */
  private waitForResume(): Promise<void> {
    if (!this.pausePromise) {
      this.pausePromise = new Promise<void>((resolve) => {
        this.pauseResolve = resolve;
      });
    }
    return this.pausePromise;
  }

  /** Emits an event on the 'orchestrator' channel. */
  private emitOrchestrator(
    type: WorkerEvent['type'],
    message: string,
    data?: unknown,
  ): void {
    this.eventBus.emit({
      workerId: 'orchestrator',
      nodeId: 'orchestrator',
      timestamp: new Date().toISOString(),
      type,
      message,
      data,
    });
  }

  /**
   * Recalls relevant memories from Hindsight for a given task query.
   * Returns the recalled text, or undefined if Hindsight is unavailable or no memories found.
   */
  private async recallContext(task: string): Promise<string | undefined> {
    try {
      const config = readConfig();
      const hindsightUrl = config.hindsight?.url;
      const bankId = config.hindsight?.defaultBank ?? 'default';

      if (!hindsightUrl) {
        log.debug('Hindsight URL not configured; skipping memory injection');
        return undefined;
      }

      const client = new HindsightClient(hindsightUrl);
      const result = await client.recall(bankId, task, { maxTokens: 2048, budget: 'mid' });

      if (result?.memories && result.memories.length > 0) {
        const text = result.memories
          .map((m) => m.content)
          .join('\n\n');
        log.debug(`Injecting ${result.memories.length} memories (${text.length} chars) into worker`);
        return text.trim();
      }
    } catch (err) {
      // Non-fatal: workers proceed without context if Hindsight is unavailable
      log.warn(`Hindsight recall failed (proceeding without context): ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }

  /** Builds the final ExecutionResult. */
  private buildResult(
    terminalStatus: 'complete' | 'error' | 'stopped',
    startTime: number,
  ): ExecutionResult {
    // Collect text outputs from all completed nodes
    const nodeOutputs: Record<string, string> = {};
    for (const [nodeId, result] of this.nodeResults) {
      if (result.output && typeof result.output === "string") {
        nodeOutputs[nodeId] = result.output;
      }
    }

    return {
      workflowId: this.graph.id,
      status: terminalStatus,
      taskSummary: this.graph.name,
      outputPaths: [...new Set(this.outputPaths)],
      durationSec: (Date.now() - startTime) / 1000,
      workerCount: this.nodeResults.size,
      estimatedCost: 0,
      decisions: this.decisions,
      findings: this.findings,
      errors: this.errors,
      nodeOutputs,
    };
  }
}

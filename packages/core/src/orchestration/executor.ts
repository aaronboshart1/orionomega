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
  LoopNodeConfig,
  AutonomousConfig,
} from './types.js';
import type { EventBus } from './event-bus.js';
import { WorkflowState } from './state.js';
import { WorkerProcess, type WorkerResult } from './worker.js';
import { CheckpointManager } from './checkpoint.js';
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
  /** Autonomous mode configuration. */
  autonomous?: AutonomousConfig;
  /** Callback for re-planning on failure. */
  replanCallback?: (failedNode: WorkflowNode, error: string, originalTask: string) => Promise<WorkflowNode[] | null>;
  /** Callback for human gate approval. */
  humanGateCallback?: (action: string, description: string) => Promise<boolean>;
  /** Original task description (for re-planning context). */
  task?: string;
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
  private readonly activeCodingAborts = new Map<string, AbortController>();
  private readonly nodeResults = new Map<string, WorkerResult>();
  private readonly nodeErrors = new Map<string, string>();
  private readonly skippedNodes = new Set<string>();
  private readonly decisions: string[] = [];
  private readonly findings: string[] = [];
  private readonly outputPaths: string[] = [];
  private readonly errors: { worker: string; message: string; resolution?: string }[] = [];
  private completedLayers = 0;
  private readonly checkpointMgr: CheckpointManager;
  private readonly nodeOutputs = new Map<string, string>();
  private totalCostUsd = 0;
  private readonly autonomousStartTime = Date.now();

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
    this.checkpointMgr = new CheckpointManager(config.checkpointDir);
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
        if (this.stopRequested) {
          this.status = 'stopped';
          for (let futureIdx = layerIdx; futureIdx < this.graph.layers.length; futureIdx++) {
            for (const nid of this.graph.layers[futureIdx]) {
              const n = this.graph.nodes.get(nid);
              if (n && n.status === 'pending') n.status = 'cancelled';
            }
          }
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

          if (result.status === 'fulfilled' && result.value.cancelled) {
            node.status = 'cancelled';
            log.info(`Node '${nodeId}' cancelled by stop`);
          } else if (result.status === 'fulfilled') {
            node.status = 'done';
            node.completedAt = new Date().toISOString();
            node.output = result.value.output;
            node.progress = 100;
            this.nodeResults.set(nodeId, result.value);
            this.totalCostUsd += result.value.costUsd ?? 0;
            this.state.setNodeOutput(nodeId, result.value.output);
            if (result.value.output && typeof result.value.output === 'string') {
              this.nodeOutputs.set(nodeId, result.value.output);
            }
            this.findings.push(...result.value.findings);
            if (result.value.outputPaths?.length) this.outputPaths.push(...result.value.outputPaths);
          } else {
            const errorMsg = result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);

            const isAbort = this.stopRequested &&
              (result.reason?.name === 'AbortError' ||
               errorMsg.includes('aborted') ||
               errorMsg.includes('abort'));

            if (isAbort) {
              node.status = 'cancelled';
              log.info(`Node '${nodeId}' cancelled by stop`);
            } else {
              node.status = 'error';
              node.error = errorMsg;
              this.nodeErrors.set(nodeId, errorMsg);
              this.errors.push({ worker: nodeId, message: errorMsg });
              log.warn(`Node '${nodeId}' failed: ${errorMsg}`);
            }
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

        // Persistent checkpointing — write after every layer
        this.saveCheckpoint();

        this.emitOrchestrator(
          'status',
          `Layer ${layerIdx + 1} complete`,
          { completedLayers: this.completedLayers },
        );
      }

      const hasErrors = this.errors.length > 0;
      this.status = hasErrors ? 'error' : 'complete';
      const result = this.buildResult(hasErrors ? 'error' : 'complete', startTime);

      // Clean up checkpoint on successful completion
      if (this.status === 'complete') {
        this.checkpointMgr.remove(this.graph.id);
      } else {
        this.saveCheckpoint(); // Preserve for resume
      }

      return result;
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
   * Requests the executor to stop. All active workers are cancelled immediately
   * via AbortController to terminate in-flight API calls and prevent further costs.
   */
  stop(): void {
    this.stopRequested = true;

    for (const [id, worker] of this.activeWorkers) {
      log.info(`Cancelling active worker '${id}'`);
      worker.cancel();
    }

    for (const [id, controller] of this.activeCodingAborts) {
      log.info(`Aborting coding agent '${id}'`);
      controller.abort();
    }

    this.resume();
    log.info('Stop requested — all active workers cancelled');
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
      estimatedCost: this.totalCostUsd,
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
        return { nodeId, output: null, durationMs: 0, toolCallCount: 0, findings: [], outputPaths: [], cancelled: true };
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

    // All retries and fallback exhausted — attempt re-planning
    if (this.config.replanCallback) {
      try {
        log.info(`Attempting re-plan for failed node '${nodeId}'`);
        this.emitOrchestrator('replan',
          `Re-planning for failed node '${node.label}': ${lastError?.message ?? 'unknown error'}`,
        );

        const fixNodes = await this.config.replanCallback(
          node,
          lastError?.message ?? 'unknown error',
          this.config.task ?? this.graph.name,
        );

        if (fixNodes && fixNodes.length > 0) {
          this.decisions.push(`Re-planned: ${nodeId} → ${fixNodes.length} fix node(s)`);

          // Execute fix nodes sequentially
          let fixOutput: WorkerResult | null = null;
          for (const fixNode of fixNodes) {
            fixOutput = await this.executeNodeByType(fixNode);
          }

          if (fixOutput) {
            this.errors.push({
              worker: nodeId,
              message: lastError?.message ?? 'unknown error',
              resolution: `Re-planned with ${fixNodes.length} fix node(s)`,
            });
            return { ...fixOutput, nodeId };
          }
        }
      } catch (replanErr) {
        log.warn(`Re-planning also failed: ${replanErr instanceof Error ? replanErr.message : String(replanErr)}`);
      }
    }

    // Everything exhausted
    throw lastError ?? new Error(`Node '${nodeId}' failed with no retries, fallback, or re-plan`);
  }

  /**
   * Dispatches node execution based on its type.
   */
  private async executeNodeByType(node: WorkflowNode): Promise<WorkerResult> {
    switch (node.type) {
      case 'AGENT':
      case 'TOOL': {
        // Build rich context from multiple sources
        let injectedContext: string | undefined;
        if (node.type === 'AGENT' && node.agent?.task) {
          const contextParts: string[] = [];

          // 1. Upstream worker outputs (from dependencies) — compressed if large
          if (node.dependsOn.length > 0) {
            const upstreamOutputs: string[] = [];
            for (const depId of node.dependsOn) {
              const depOutput = this.state.getNodeOutput(depId);
              const depNode = this.graph.nodes.get(depId);
              if (depOutput && typeof depOutput === 'string') {
                const label = depNode?.label ?? depId;
                const estimatedTokens = Math.ceil(depOutput.length / 4);
                if (estimatedTokens > 2000) {
                  const compressed = await this.compressOutput(label, depOutput);
                  upstreamOutputs.push(`### ${label} (compressed)\n${compressed}`);
                } else {
                  upstreamOutputs.push(`### ${label}\n${depOutput}`);
                }
              }
            }
            if (upstreamOutputs.length > 0) {
              contextParts.push(`## Upstream Results\nOutput from previous workers:\n\n${upstreamOutputs.join('\n\n')}`);
            }
          }

          // 2. Hindsight memory recall (multi-bank)
          const recalled = await this.recallContext(node.agent.task);
          if (recalled) {
            contextParts.push(`## Relevant Memories\n${recalled}`);
          }

          // 3. Known infrastructure from config
          const config = readConfig();
          if (config.hindsight?.url) {
            contextParts.push(`## Known Infrastructure\n- Hindsight API: ${config.hindsight.url}\n- Default bank: ${config.hindsight.defaultBank ?? 'default'}`);
          }

          if (contextParts.length > 0) {
            injectedContext = contextParts.join('\n\n');
          }
        }

        // Each worker gets its own output directory to prevent file pollution
        const workerOutputDir = `${this.config.workspaceDir}/output/${this.graph.id}/${node.id}`;
        const { mkdirSync } = await import('node:fs');
        try { mkdirSync(workerOutputDir, { recursive: true }); } catch { /* may exist */ }

        const worker = new WorkerProcess(node, this.eventBus, {
          workspaceDir: workerOutputDir,
          timeout: node.timeout ?? this.config.workerTimeout,
          context: injectedContext,
          workflowId: this.graph.id,
        });
        this.activeWorkers.set(node.id, worker);

        try {
          const result = await worker.run();
          return result;
        } finally {
          this.activeWorkers.delete(node.id);
        }
      }

      case 'CODING_AGENT': {
        // Route to Claude Agent SDK — full coding toolset
        const { executeCodingAgent } = await import('./agent-sdk-bridge.js');

        // Build upstream context for the coding agent
        const codingContext: string[] = [];
        if (node.dependsOn.length > 0) {
          for (const depId of node.dependsOn) {
            const depOutput = this.state.getNodeOutput(depId);
            const depNode = this.graph.nodes.get(depId);
            if (depOutput && typeof depOutput === 'string') {
              codingContext.push(`### ${depNode?.label ?? depId}\n${depOutput}`);
            }
          }
        }

        // Inject upstream context into the task description
        const codingTask = codingContext.length > 0
          ? `${node.codingAgent?.task ?? node.agent?.task ?? ''}\n\n## Context from previous steps:\n${codingContext.join('\n\n')}`
          : node.codingAgent?.task ?? node.agent?.task ?? '';

        // Create output directory for the coding agent
        const codingOutputDir = `${this.config.workspaceDir}/output/${this.graph.id}/${node.id}`;
        const { mkdirSync: mkdirCoding } = await import('node:fs');
        try { mkdirCoding(codingOutputDir, { recursive: true }); } catch { /* may exist */ }

        // Override the task with context-enriched version
        const codingNode: WorkflowNode = {
          ...node,
          codingAgent: {
            ...node.codingAgent,
            task: codingTask,
            cwd: node.codingAgent?.cwd ?? codingOutputDir,
          },
        };

        const codingAbort = new AbortController();
        this.activeCodingAborts.set(node.id, codingAbort);

        const startMs = Date.now();
        try {
          const codingResult = await executeCodingAgent(
            codingNode,
            codingOutputDir,
            (event) => {
              const typeMap: Record<string, string> = {
                'status': 'status', 'tool': 'tool_call', 'thinking': 'thinking', 'done': 'done', 'error': 'error',
              };
              const eventType = (typeMap[event.type] ?? 'status') as WorkerEvent['type'];

              let tool: WorkerEvent['tool'];
              if (eventType === 'tool_call' && event.message) {
                const toolName = event.message.split(':')[0].trim();
                const afterColon = event.message.includes(':')
                  ? event.message.split(':').slice(1).join(':').trim()
                  : '';
                const fileMatch = afterColon.match(/((?:\.?\/?)?[\w.\-/@]+\.[\w]+)/);
                tool = {
                  name: toolName,
                  action: toolName,
                  file: fileMatch?.[1],
                  summary: event.message,
                };
              }

              this.eventBus.emit({
                workflowId: this.graph.id,
                workerId: node.id,
                nodeId: node.id,
                timestamp: new Date().toISOString(),
                type: eventType,
                message: event.message,
                thinking: event.thinking,
                progress: event.progress ?? 0,
                tool,
              });
            },
            codingAbort.signal,
          );

          if (this.stopRequested) {
            return {
              nodeId: node.id, output: null, durationMs: Date.now() - startMs,
              toolCallCount: 0, findings: [], outputPaths: [], cancelled: true,
            };
          }

          return {
            nodeId: node.id,
            output: codingResult.output,
            durationMs: Date.now() - startMs,
            toolCallCount: codingResult.toolCalls,
            findings: [],
            outputPaths: codingResult.outputPaths ?? [],
          };
        } catch (err) {
          if (this.stopRequested) {
            return {
              nodeId: node.id, output: null, durationMs: Date.now() - startMs,
              toolCallCount: 0, findings: [], outputPaths: [], cancelled: true,
            };
          }
          throw err;
        } finally {
          this.activeCodingAborts.delete(node.id);
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

      case 'LOOP':
        return this.executeLoop(node);

      default:
        throw new Error(`Unsupported node type: ${node.type}`);
    }
  }

  /**
   * Executes a LOOP node — runs the body sub-graph repeatedly
   * until the exit condition is met or maxIterations is reached.
   */
  private async executeLoop(node: WorkflowNode): Promise<WorkerResult> {
    const loopConfig = node.loop;
    if (!loopConfig) throw new Error(`LOOP node '${node.id}' missing loop configuration`);

    const maxIter = loopConfig.maxIterations ?? 10;
    const carryForward = loopConfig.carryForward !== false; // default true
    let iteration = 0;
    let lastOutput = '';
    const allFindings: string[] = [];
    let totalToolCalls = 0;
    const startMs = Date.now();

    this.emitOrchestrator('loop_iteration', `Loop '${node.label}' starting (max ${maxIter} iterations)`);

    while (iteration < maxIter) {
      iteration++;
      if (this.stopRequested) break;

      this.emitOrchestrator('loop_iteration',
        `Loop '${node.label}' — iteration ${iteration}/${maxIter}`,
        { iteration, maxIterations: maxIter },
      );

      // Reset body nodes to pending for this iteration
      const bodyNodes = this.cloneBodyNodes(loopConfig, iteration);

      // Inject carry-forward context from previous iteration
      if (carryForward && lastOutput && iteration > 1) {
        for (const bodyNode of bodyNodes) {
          if (bodyNode.type === 'AGENT' && bodyNode.agent) {
            bodyNode.agent.task = `${bodyNode.agent.task}\n\n## Previous iteration output:\n${lastOutput}`;
          } else if (bodyNode.type === 'CODING_AGENT' && bodyNode.codingAgent) {
            bodyNode.codingAgent.task = `${bodyNode.codingAgent.task}\n\n## Previous iteration output:\n${lastOutput}`;
          }
        }
      }

      // Execute body nodes sequentially (respecting their internal dependencies)
      let iterationOutput = '';
      let iterationFailed = false;

      for (const bodyNode of bodyNodes) {
        if (this.stopRequested) break;

        try {
          const result = await this.executeNodeByType(bodyNode);
          if (result.output && typeof result.output === 'string') {
            iterationOutput = result.output;
          }
          allFindings.push(...result.findings);
          totalToolCalls += result.toolCallCount;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(`Loop body node '${bodyNode.id}' failed in iteration ${iteration}: ${errMsg}`);
          iterationOutput = `ERROR: ${errMsg}`;
          iterationFailed = true;

          // Don't break — the error IS the output for exit condition evaluation
        }
      }

      lastOutput = iterationOutput;

      // Check exit condition
      const shouldExit = await this.checkLoopExit(
        loopConfig.exitCondition,
        iterationOutput,
        iterationFailed,
        iteration,
        node.label,
      );

      if (shouldExit) {
        this.emitOrchestrator('done',
          `Loop '${node.label}' exited after ${iteration} iteration(s)`,
        );
        break;
      }
    }

    if (iteration >= maxIter) {
      this.emitOrchestrator('status',
        `Loop '${node.label}' hit max iterations (${maxIter})`,
      );
      this.decisions.push(`Loop '${node.label}' forced exit at max iterations (${maxIter})`);
    }

    return {
      nodeId: node.id,
      output: lastOutput,
      durationMs: Date.now() - startMs,
      toolCallCount: totalToolCalls,
      findings: allFindings,
      outputPaths: [],
    };
  }

  /**
   * Clones the body nodes for a fresh loop iteration.
   * Each clone gets a unique ID suffix to avoid ID collisions.
   */
  private cloneBodyNodes(loopConfig: LoopNodeConfig, iteration: number): WorkflowNode[] {
    return loopConfig.body.map((n) => ({
      ...n,
      id: `${n.id}_iter${iteration}`,
      status: 'pending' as const,
      startedAt: undefined,
      completedAt: undefined,
      output: undefined,
      error: undefined,
      progress: undefined,
      // Deep-clone agent/codingAgent config
      agent: n.agent ? { ...n.agent } : undefined,
      codingAgent: n.codingAgent ? { ...n.codingAgent } : undefined,
    }));
  }

  /**
   * Evaluates the loop exit condition.
   */
  private async checkLoopExit(
    condition: LoopNodeConfig['exitCondition'],
    output: string,
    failed: boolean,
    iteration: number,
    loopLabel: string,
  ): Promise<boolean> {
    switch (condition.type) {
      case 'all_pass':
        return !failed;

      case 'output_match':
        if (!condition.pattern) return !failed;
        return new RegExp(condition.pattern, 'i').test(output);

      case 'llm_judge': {
        if (!condition.judgePrompt) return !failed;

        try {
          const config = readConfig();
          const apiKey = config.models?.apiKey;
          if (!apiKey) return !failed;

          const cheapModel = config.models?.cheap || 'claude-haiku-4-5-20251001';
          const { AnthropicClient } = await import('../anthropic/client.js');
          const client = new AnthropicClient(apiKey);
          const response = await client.createMessage({
            model: cheapModel,
            messages: [{
              role: 'user',
              content: `${condition.judgePrompt}\n\n## Loop Output (iteration ${iteration}):\n${output}\n\nRespond with ONLY "CONTINUE" or "EXIT".`,
            }],
            maxTokens: 8,
            temperature: 0,
          });

          const text = response.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('')
            .trim()
            .toUpperCase();

          const shouldExit = text.includes('EXIT');
          log.info(`Loop '${loopLabel}' LLM judge: ${text} → ${shouldExit ? 'exit' : 'continue'}`);
          return shouldExit;
        } catch (err) {
          log.warn(`Loop exit judge failed, defaulting to continue: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      }

      default:
        return !failed;
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

  /** Emits an event on the 'orchestrator' channel, tagged with this workflow's ID. */
  private emitOrchestrator(
    type: WorkerEvent['type'],
    message: string,
    data?: unknown,
  ): void {
    this.eventBus.emit({
      workflowId: this.graph.id,
      workerId: 'orchestrator',
      nodeId: 'orchestrator',
      timestamp: new Date().toISOString(),
      type,
      message,
      data,
    });
  }

  /**
   * Recalls relevant memories from Hindsight across multiple banks.
   * Returns combined text, or undefined if unavailable or no matches.
   *
   * Queries the infra bank (always), default bank, and any project-* bank
   * that seems relevant to the task keywords.
   */
  private async compressOutput(label: string, output: string): Promise<string> {
    try {
      const config = readConfig();
      const apiKey = config.models?.apiKey;
      if (!apiKey) return output.slice(0, 4000) + '\n... [truncated — no API key for compression]';

      const cheapModel = config.models?.cheap || 'claude-haiku-4-5-20251001';
      const { AnthropicClient } = await import('../anthropic/client.js');
      const client = new AnthropicClient(apiKey);
      const response = await client.createMessage({
        model: cheapModel,
        system: 'You are a concise summarizer. Compress the following worker output into key findings, decisions, and data points. Preserve all actionable information, file paths, URLs, code snippets, and specific values. Remove verbose logging, repeated information, and filler text. Output ONLY the compressed summary.',
        messages: [{ role: 'user', content: `Worker "${label}" produced the following output:\n\n${output}` }],
        maxTokens: 2048,
        temperature: 0,
      });

      const summary = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();

      log.info(`Compressed upstream output "${label}": ${output.length} chars → ${summary.length} chars`);
      return summary || output.slice(0, 4000);
    } catch (err) {
      log.warn(`Failed to compress output "${label}", truncating`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return output.slice(0, 4000) + '\n... [truncated]';
    }
  }

  private async recallContext(task: string): Promise<string | undefined> {
    try {
      const config = readConfig();
      const hindsightUrl = config.hindsight?.url;

      if (!hindsightUrl) {
        log.debug('Hindsight URL not configured; skipping memory injection');
        return undefined;
      }

      const client = new HindsightClient(hindsightUrl);
      const defaultBank = config.hindsight?.defaultBank ?? 'default';

      // Determine which banks to query
      const banks = new Set<string>([defaultBank, 'infra']);

      // Discover project banks that might be relevant
      try {
        const res = await fetch(`${hindsightUrl}/v1/default/banks`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json() as { banks?: { id: string }[] };
          const taskLower = task.toLowerCase();
          for (const bank of data.banks ?? []) {
            if (bank.id.startsWith('project-')) {
              // Check if project name appears in the task
              const projectName = bank.id.replace('project-', '');
              if (taskLower.includes(projectName)) {
                banks.add(bank.id);
              }
            }
          }
        }
      } catch {
        // Non-fatal: proceed with default banks
      }

      // Recall from all banks concurrently
      const recallPromises = [...banks].map(async (bankId) => {
        try {
          const result = await client.recall(bankId, task, { maxTokens: 1024, budget: 'low' });
          const memories = result?.results ?? [];
          if (memories.length > 0) {
            const text = memories.map((m: { content: string }) => m.content).join('\n');
            return `### Bank: ${bankId}\n${text}`;
          }
        } catch {
          // Individual bank failures are non-fatal
        }
        return null;
      });

      const results = (await Promise.all(recallPromises)).filter(Boolean);

      if (results.length > 0) {
        const combined = results.join('\n\n');
        log.debug(`Injected context from ${results.length} bank(s) (${combined.length} chars)`);
        return combined;
      }
    } catch (err) {
      log.warn(`Hindsight recall failed (proceeding without context): ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }

  /** Saves a checkpoint of current workflow state. */
  private saveCheckpoint(): void {
    try {
      const outputsRecord: Record<string, string> = {};
      for (const [k, v] of this.nodeOutputs) outputsRecord[k] = v;

      const checkpoint = CheckpointManager.buildCheckpoint(
        this.graph,
        this.config.task ?? this.graph.name,
        outputsRecord,
        this.completedLayers,
        this.status,
        this.outputPaths,
        this.decisions,
        this.findings,
        this.errors,
      );
      this.checkpointMgr.save(checkpoint);
    } catch (err) {
      log.warn('Failed to save checkpoint', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Checks autonomous mode budget and duration limits.
   * Returns true if the workflow should stop.
   */
  checkAutonomousLimits(): { shouldStop: boolean; reason?: string } {
    const auto = this.config.autonomous;
    if (!auto?.enabled) return { shouldStop: false };

    // Budget check
    if (auto.maxBudgetUsd > 0 && this.totalCostUsd >= auto.maxBudgetUsd) {
      return { shouldStop: true, reason: `Budget limit reached: $${this.totalCostUsd.toFixed(2)} >= $${auto.maxBudgetUsd}` };
    }

    // Duration check
    const elapsedMin = (Date.now() - this.autonomousStartTime) / 60_000;
    if (auto.maxDurationMinutes > 0 && elapsedMin >= auto.maxDurationMinutes) {
      return { shouldStop: true, reason: `Duration limit reached: ${Math.round(elapsedMin)}min >= ${auto.maxDurationMinutes}min` };
    }

    return { shouldStop: false };
  }

  /**
   * Checks if an action requires human gate approval.
   * Returns true if the action is approved (or no gate required).
   */
  async checkHumanGate(action: string, description: string): Promise<boolean> {
    const auto = this.config.autonomous;
    if (!auto?.enabled) return true;
    if (!auto.humanGates.includes(action)) return true;

    if (this.config.humanGateCallback) {
      this.emitOrchestrator('status', `🚧 Human gate: "${action}" — awaiting approval`, { action, description, workflowId: this.graph.id });
      return this.config.humanGateCallback(action, description);
    }

    // No callback configured — deny gated actions by default
    log.warn(`Human gate '${action}' triggered but no callback configured — denying`);
    return false;
  }

  /** Builds the final ExecutionResult. */
  private buildResult(
    terminalStatus: 'complete' | 'error' | 'stopped',
    startTime: number,
  ): ExecutionResult {
    const nodeOutputs: Record<string, string> = {};
    const nodeFinalResults: Record<string, string> = {};
    const nodeOutputPaths: Record<string, string[]> = {};
    for (const [nodeId, result] of this.nodeResults) {
      if (result.output && typeof result.output === "string") {
        nodeOutputs[nodeId] = result.output;
      }
      if (result.finalResult && typeof result.finalResult === "string") {
        nodeFinalResults[nodeId] = result.finalResult;
      }
      if (result.outputPaths && result.outputPaths.length > 0) {
        const node = this.graph.nodes.get(nodeId);
        const label = node?.label ?? nodeId;
        const existing = nodeOutputPaths[label] ?? [];
        nodeOutputPaths[label] = [...new Set([...existing, ...result.outputPaths])];
      }
    }

    // Aggregate per-model token usage
    const modelMap = new Map<string, {
      inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheCreationTokens: number;
      workerCount: number;
    }>();

    for (const result of this.nodeResults.values()) {
      const hasModel = !!result.model;
      const hasTokens = (result.inputTokens ?? 0) > 0 || (result.outputTokens ?? 0) > 0
        || (result.cacheReadTokens ?? 0) > 0 || (result.cacheCreationTokens ?? 0) > 0;
      if (!hasModel && !hasTokens) continue;
      const model = result.model ?? 'unknown';
      const existing = modelMap.get(model) ?? {
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        workerCount: 0,
      };
      existing.inputTokens += result.inputTokens ?? 0;
      existing.outputTokens += result.outputTokens ?? 0;
      existing.cacheReadTokens += result.cacheReadTokens ?? 0;
      existing.cacheCreationTokens += result.cacheCreationTokens ?? 0;
      existing.workerCount += 1;
      modelMap.set(model, existing);
    }

    // Calculate cost per model using Anthropic pricing
    const modelUsage: import('./types.js').ModelUsage[] = [];
    let totalCostUsd = 0;
    for (const [model, usage] of modelMap) {
      const cost = this.estimateCost(model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens);
      totalCostUsd += cost;
      modelUsage.push({ model, ...usage, costUsd: cost });
    }

    return {
      workflowId: this.graph.id,
      status: terminalStatus,
      taskSummary: this.graph.name,
      outputPaths: [...new Set(this.outputPaths)],
      nodeOutputPaths: Object.keys(nodeOutputPaths).length > 0 ? nodeOutputPaths : undefined,
      durationSec: (Date.now() - startTime) / 1000,
      workerCount: this.nodeResults.size,
      estimatedCost: totalCostUsd,
      decisions: this.decisions,
      findings: this.findings,
      errors: this.errors,
      nodeOutputs,
      nodeFinalResults: Object.keys(nodeFinalResults).length > 0 ? nodeFinalResults : undefined,
      modelUsage,
      totalCostUsd,
      toolCallCount: Array.from(this.nodeResults.values()).reduce((sum, r) => sum + r.toolCallCount, 0),
    };
  }

  /** Estimate cost in USD based on Anthropic pricing (June 2025). */
  private estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
  ): number {
    // Pricing per million tokens (USD)
    let inputPricePerM: number;
    let outputPricePerM: number;
    let cacheReadPricePerM: number;
    let cacheWritePricePerM: number;

    if (model.includes('opus')) {
      inputPricePerM = 15; outputPricePerM = 75;
      cacheReadPricePerM = 1.5; cacheWritePricePerM = 18.75;
    } else if (model.includes('haiku')) {
      inputPricePerM = 0.8; outputPricePerM = 4;
      cacheReadPricePerM = 0.08; cacheWritePricePerM = 1;
    } else {
      // Sonnet default
      inputPricePerM = 3; outputPricePerM = 15;
      cacheReadPricePerM = 0.3; cacheWritePricePerM = 3.75;
    }

    // Uncached input = total input - cache reads
    const uncachedInput = Math.max(0, inputTokens - cacheReadTokens);
    return (
      (uncachedInput / 1_000_000) * inputPricePerM +
      (outputTokens / 1_000_000) * outputPricePerM +
      (cacheReadTokens / 1_000_000) * cacheReadPricePerM +
      (cacheCreationTokens / 1_000_000) * cacheWritePricePerM
    );
  }
}

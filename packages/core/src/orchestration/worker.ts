/**
 * @module orchestration/worker
 * Worker process wrapper that executes a single workflow node.
 *
 * For AGENT nodes, delegates to the Claude Agent SDK via executeAgent()
 * instead of the hand-rolled agent loop. This gains adaptive thinking,
 * a richer toolset (Bash, Glob, Grep, WebSearch, WebFetch), and non-blocking
 * async tool execution.
 */

import { execFile, exec } from 'node:child_process';
import { writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { WorkflowNode, WorkerEvent } from './types.js';
import type { EventBus } from './event-bus.js';
import { executeAgent } from './agent-sdk-bridge.js';
import { TaggedRetryError } from './retry-error.js';
import type { OrionOmegaAbortReason } from './abort-reason.js';
import { readConfig } from '../config/loader.js';
import { SkillLoader } from '@orionomega/skills-sdk';
import { createLogger } from '../logging/logger.js';
import { getPortAvoidanceInstructions } from '../utils/port-restrictions.js';

const log = createLogger('worker');

function saveTextOutputIfEmpty(outputDir: string, text: string, filename: string = 'output.md'): string | null {
  try {
    if (!existsSync(outputDir)) return null;
    const files = readdirSync(outputDir);
    if (files.length > 0) return null;
    if (!text || !text.trim()) return null;
    const filePath = join(outputDir, filename);
    writeFileSync(filePath, text.trim(), 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}

function scanForUntrackedFiles(outputDir: string, knownPaths: string[]): string[] {
  try {
    if (!existsSync(outputDir)) return [];
    const knownSet = new Set(knownPaths.map(p => {
      try { return resolvePath(p); } catch { return p; }
    }));
    const newPaths: string[] = [];
    const walk = (dir: string) => {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            walk(fullPath);
          } else {
            const resolved = resolvePath(fullPath);
            if (!knownSet.has(resolved) && !knownSet.has(fullPath)) {
              newPaths.push(fullPath);
            }
          }
        } catch { /* skip inaccessible entries */ }
      }
    };
    walk(outputDir);
    return newPaths;
  } catch {
    return [];
  }
}

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
  /** Model used (for cost tracking). */
  model?: string;
  /** Input tokens consumed. */
  inputTokens?: number;
  /** Output tokens consumed. */
  outputTokens?: number;
  /** Cache read tokens. */
  cacheReadTokens?: number;
  /** Cache creation tokens. */
  cacheCreationTokens?: number;
  /** Cost in USD. */
  costUsd?: number;
  /**
   * Concise final summary from the SDK result message.
   * Prefer this over output for display; output contains all intermediate text.
   */
  finalResult?: string;
  cancelled?: boolean;
}

/**
 * Wraps the execution of a single workflow node, emitting structured events
 * through the EventBus as work progresses.
 *
 * For AGENT nodes, delegates to the Claude Agent SDK.
 * For TOOL nodes, the configured command is executed via child_process.
 */
export class WorkerProcess {
  private readonly node: WorkflowNode;
  private readonly eventBus: EventBus;
  private readonly workspaceDir: string;
  private readonly timeout: number;

  private cancelled = false;
  private abortController?: AbortController;
  private currentStatus: string = 'pending';
  private currentProgress = 0;
  private lastEvent: WorkerEvent | undefined;
  private readonly events: WorkerEvent[] = [];
  private readonly context: string | undefined;
  private readonly workflowId: string | undefined;
  /** The run-level output directory (e.g. ~/.orionomega/runs/{workflowId}). */
  private readonly runDir: string | undefined;
  /**
   * Distinguishes between user-driven cancellation (cancel()) and
   * wall-clock-timeout-driven aborts. Surfaced so the executor can produce
   * accurate "timed out" vs "aborted by user" error messages.
   */
  private abortReason: 'user' | 'timeout' | undefined;
  /** Most recently observed tool name — included in timeout diagnostics. */
  private lastToolName?: string;
  /** Optional callback invoked when this worker self-aborts on its own timeout. */
  private readonly onTimeout?: (lastTool?: string) => void;

  constructor(
    node: WorkflowNode,
    eventBus: EventBus,
    options: {
      workspaceDir: string;
      timeout: number;
      context?: string;
      workflowId?: string;
      runDir?: string;
      onTimeout?: (lastTool?: string) => void;
    },
  ) {
    this.node = node;
    this.eventBus = eventBus;
    this.workspaceDir = options.workspaceDir;
    this.timeout = options.timeout;
    this.context = options.context;
    this.workflowId = options.workflowId;
    this.runDir = options.runDir;
    this.onTimeout = options.onTimeout;
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

      if (this.cancelled) {
        this.currentStatus = 'done';
        return this.cancelledResult();
      }

      result.durationMs = Date.now() - start;
      this.currentStatus = 'done';
      this.currentProgress = 100;
      return result;
    } catch (err) {
      // Distinguish user-driven cancel from a wall-clock-timeout-driven abort.
      // Only the former should be reported as a cancelled (benign) result;
      // the latter must propagate as an error so the executor's retry/replan
      // logic engages instead of silently swallowing the timeout.
      if (this.cancelled && this.abortReason === 'user') {
        this.currentStatus = 'done';
        return this.cancelledResult();
      }
      this.currentStatus = 'error';
      const original = err instanceof Error ? err.message : String(err);
      const errorMessage = this.abortReason === 'timeout'
        ? `Worker '${this.node.label}' timed out after ${this.timeout}s`
          + (this.lastToolName ? ` (last tool: ${this.lastToolName})` : '')
          + ` — original SDK error: ${original}`
        : original;
      this.emitEvent({
        type: 'error',
        error: errorMessage,
        message: `Failed: ${this.node.label}`,
      });
      // Preserve the bridge's retry verdict. If runAgent threw a TaggedRetryError
      // (auth/permanent vs transient), forward that classification so the
      // executor's classifyError honors it. Wall-clock timeouts are inherently
      // transient — re-tag those explicitly. Otherwise rethrow as plain Error.
      if (this.abortReason === 'timeout') {
        throw new TaggedRetryError(errorMessage, { retryable: true });
      }
      if (err instanceof TaggedRetryError) {
        // Preserve original retry decision and subtype; surface the same message.
        throw new TaggedRetryError(errorMessage, {
          retryable: err.retryable,
          errorSubtype: err.errorSubtype,
        });
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Cancels the worker. Aborts the Agent SDK invocation immediately
   * and marks the worker as cancelled. Defaults to a `user`-driven reason
   * when called externally (the executor's stop()).
   */
  cancel(): void {
    this.cancelled = true;
    if (!this.abortReason) this.abortReason = 'user';
    // Pass a typed reason so the SDK bridge can disambiguate user-cancel
    // from a wall-clock timeout when it catches the AbortError.
    const reason: OrionOmegaAbortReason = { kind: 'user' };
    this.abortController?.abort(reason);
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
      workflowId: this.workflowId,
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
   * Executes an AGENT node via the Claude Agent SDK.
   *
   * Replaces the hand-rolled runAgentLoop() + AnthropicClient path, gaining:
   * - Full Claude Code toolset (Bash, Glob, Grep, WebSearch, WebFetch, Read, Write, Edit)
   * - Adaptive thinking (opus/sonnet)
   * - Non-blocking async tool execution
   * - Cooperative cancellation via AbortController
   */
  private async runAgent(): Promise<WorkerResult> {
    if (this.cancelled) return this.cancelledResult();

    const model = this.resolveWorkerModel();
    const agentConfig = this.node.agent!;
    const systemPrompt = await this.buildWorkerSystemPrompt(agentConfig);

    // Create abort controller — wired to cancel()
    this.abortController = new AbortController();

    // Fix 1: Enforce wall-clock timeout so AGENT nodes can't run forever.
    // The SDK's maxTurns/maxBudgetUsd limits are soft — a stalled API call
    // or infinite streaming response can still block indefinitely.
    const workerTimeoutMs = this.timeout * 1000;
    const timeoutHandle = setTimeout(() => {
      const lastTool = this.lastToolName;
      log.warn(
        `Worker '${this.node.id}' exceeded timeout of ${this.timeout}s — aborting` +
        (lastTool ? ` (last tool: ${lastTool})` : ''),
      );
      this.emitEvent({
        type: 'error',
        error: `Worker timed out after ${this.timeout}s` + (lastTool ? ` (last tool: ${lastTool})` : ''),
        message: `Timeout: ${this.node.label}`,
      });
      // Record reason BEFORE abort so downstream reporting classifies this
      // correctly as a timeout rather than as user-driven cancellation.
      this.abortReason = 'timeout';
      this.onTimeout?.(lastTool);
      // Typed abort reason → bridge can render the right error message
      // ("Agent timed out after Xs") instead of the SDK's stock
      // "process aborted by user" string.
      const reason: OrionOmegaAbortReason = {
        kind: 'timeout',
        timeoutSec: this.timeout,
        lastTool,
        nodeLabel: this.node.label,
      };
      this.abortController?.abort(reason);
    }, workerTimeoutMs);

    this.emitEvent({
      type: 'status',
      message: `Starting: ${this.node.label} (${model})`,
      progress: 0,
    });

    log.info(
      `Worker ${this.node.id} starting with model ${model}: "${agentConfig.task.slice(0, 80)}"`,
    );

    // Heartbeat: show the worker is alive during long operations
    const agentStart = Date.now();
    let heartbeatToolCalls = 0;
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - agentStart) / 1000);
      this.emitEvent({
        type: 'status',
        message: `Still working... (${elapsed}s, ${heartbeatToolCalls} tool calls)`,
        progress: Math.min(this.currentProgress, 90),
      });
    }, 30_000);

    const tokenBudget = agentConfig.tokenBudget ?? this.defaultTokenBudget(model);

    const result = await executeAgent({
      task: agentConfig.task,
      model,
      systemPrompt,
      cwd: this.workspaceDir,
      skillIds: agentConfig.skillIds,
      tokenBudget,
      abortSignal: this.abortController.signal,
      onProgress: (event) => {
        if (event.type === 'tool_call') {
          heartbeatToolCalls++;
          // Extract tool name (before the first colon if present). Validate
          // the result looks like a real SDK tool identifier (alphanumeric +
          // underscore/hyphen/dot, length 1-64) before recording it as the
          // "last tool" diagnostic — otherwise diagnostic-only strings like
          // "Tool running" or empty messages would pollute timeout reports.
          const rawName = event.message.split(':')[0].trim();
          const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
          const looksLikeToolName =
            TOOL_NAME_RE.test(rawName) &&
            rawName.toLowerCase() !== 'tool' &&
            rawName.toLowerCase() !== 'tool running';
          const toolName = looksLikeToolName ? rawName : (this.lastToolName ?? rawName);
          if (looksLikeToolName) this.lastToolName = toolName;
          // Extract file path from the message (after "ToolName: ")
          const afterColon = event.message.includes(':')
            ? event.message.split(':').slice(1).join(':').trim()
            : '';
          const fileMatch = afterColon.match(/((?:\.?\/?)?[\w.\-/@]+\.[\w]+)/);
          this.emitEvent({
            type: 'tool_call',
            tool: {
              name: toolName,
              action: toolName,
              file: fileMatch?.[1],
              summary: event.message,
            },
            message: event.message,
            progress: event.progress ?? this.currentProgress,
          });
        } else if (event.type === 'status') {
          this.emitEvent({
            type: 'status',
            message: event.message,
            progress: event.progress ?? this.currentProgress,
          });
        } else if (event.type === 'error') {
          this.emitEvent({
            type: 'error',
            error: event.message,
            message: event.message,
          });
        }
        // 'done' is handled below with full data
      },
    }).finally(() => {
      clearInterval(heartbeat);
      // Fix 1: Cancel the timeout so it doesn't fire after the agent completes.
      clearTimeout(timeoutHandle);
    });

    // Fix 2: Propagate SDK-level failures (success:false) as thrown errors so
    // the executor's retry/fallback logic is triggered and the node is marked
    // as 'error' rather than silently treated as a successful completion. We
    // forward the bridge's `retryable` decision via TaggedRetryError so the
    // executor doesn't have to guess whether to back off and try again.
    if (!result.success && result.error) {
      throw new TaggedRetryError(`Agent failed: ${result.error}`, {
        retryable: result.retryable ?? true,
        errorSubtype: result.errorSubtype,
      });
    }

    log.info(
      `Worker ${this.node.id} completed: ${result.toolCalls} tool calls, ${result.durationSec.toFixed(1)}s` +
      (result.costUsd ? ` (cost: $${result.costUsd.toFixed(4)})` : ''),
    );

    const allOutputPaths = [...result.outputPaths];

    if (typeof result.output === 'string' && result.output.trim()) {
      const saved = saveTextOutputIfEmpty(this.workspaceDir, result.output, 'output.md');
      if (saved) allOutputPaths.push(saved);
    }

    const untracked = scanForUntrackedFiles(this.workspaceDir, allOutputPaths);
    allOutputPaths.push(...untracked);

    const finalOutputPaths = [...new Set(allOutputPaths)];

    this.emitEvent({
      type: 'done',
      message: `Completed: ${this.node.label}`,
      progress: 100,
      data: {
        toolCalls: result.toolCalls,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cacheHitRate: 0,
        stoppedByBudget: false,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        nodeLabel: this.node.label,
        output: typeof result.output === 'string' ? result.output : undefined,
        finalResult: result.finalResult,
        outputPaths: finalOutputPaths,
      },
    });

    return {
      nodeId: this.node.id,
      output: result.output,
      durationMs: result.durationSec * 1000,
      toolCallCount: result.toolCalls,
      findings: [],
      outputPaths: finalOutputPaths,
      model,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      cacheReadTokens: result.cacheReadTokens ?? 0,
      cacheCreationTokens: result.cacheCreationTokens ?? 0,
      costUsd: result.costUsd,
      finalResult: result.finalResult,
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
    // If there's an explicit system prompt override, use it — but still
    // prepend any recalled hindsight context so the recall isn't discarded.
    if (agentConfig.systemPrompt) {
      const contextSection = this.context
        ? `## Relevant Context\n${this.context}\n\n`
        : '';
      return `${contextSection}${agentConfig.systemPrompt}`;
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
2. Use the available tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch) as needed.
3. Be efficient — avoid unnecessary tool calls.
4. If you encounter an error, try to recover or work around it.
5. When done, provide a clear summary of what you accomplished and any notable findings.

${getPortAvoidanceInstructions()}

## Working Directory & File Outputs
Your current working directory has been set by the orchestrator to a private
per-node workspace. The system automatically captures your final stdout as
\`output.md\` in that directory and surfaces every file you write under it as
a run artifact in the UI.

File-write rules (STRICT):
1. ALL files you create MUST be written using **relative paths** (e.g.
   \`spec.md\`, \`./report.json\`, \`subdir/notes.txt\`). Never use absolute
   paths like \`/home/user/...\`, \`/home/kali/...\`, \`/tmp/...\`, or \`~\`
   for writes — those produce orphan files outside the run's artifact
   directory and the user will not see them.
2. Reading absolute paths is fine (project files, configs, etc.). Writing is
   not. Even if your task description mentions an absolute output path,
   ignore that path and write to a relative filename instead — the system
   will route it to the correct artifact location.
3. Do not duplicate outputs. Pick one filename and write to it once.${skillDocs}`;
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

    let output = '';
    let stderr = '';
    let toolError: Error | null = null;

    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const params = toolConfig.params;
        const paramValues = Object.values(params).map(String);
        const hasShellSyntax = paramValues.some(v => /[|;&$`]/.test(v));

        if (hasShellSyntax || Object.keys(params).length === 1 && Object.keys(params)[0] === 'command') {
          const cmd = params.command
            ? String(params.command)
            : `${toolConfig.name} ${paramValues.join(' ')}`;

          const child = exec(
            cmd,
            {
              cwd: this.workspaceDir,
              timeout: this.timeout * 1000,
              maxBuffer: 10 * 1024 * 1024,
              env: { ...process.env, HOME: process.env.HOME || '/root' },
            },
            (error: Error | null, stdout: string, stderrOut: string) => {
              if (error) {
                reject({ error, stdout, stderr: stderrOut });
              } else {
                resolve({ stdout, stderr: stderrOut });
              }
            },
          );

          const checkCancel = setInterval(() => {
            if (this.cancelled) { child.kill('SIGTERM'); clearInterval(checkCancel); }
          }, 500);
          child.on('close', () => clearInterval(checkCancel));
        } else {
          const args = Object.entries(params).map(([k, v]) => `--${k}=${String(v)}`);

          const child = execFile(
            toolConfig.name,
            args,
            {
              cwd: this.workspaceDir,
              timeout: this.timeout * 1000,
              maxBuffer: 10 * 1024 * 1024,
              env: { ...process.env, HOME: process.env.HOME || '/root' },
            },
            (error, stdout, stderrOut) => {
              if (error) {
                reject({ error, stdout, stderr: stderrOut });
              } else {
                resolve({ stdout, stderr: stderrOut });
              }
            },
          );

          const checkCancel = setInterval(() => {
            if (this.cancelled) { child.kill('SIGTERM'); clearInterval(checkCancel); }
          }, 500);
          child.on('close', () => clearInterval(checkCancel));
        }
      });
      output = result.stdout;
      stderr = result.stderr;
    } catch (rejection: unknown) {
      const rej = rejection as { error?: Error; stdout?: string; stderr?: string };
      output = rej.stdout ?? '';
      stderr = rej.stderr ?? '';
      toolError = rej.error ?? new Error(`Tool '${toolConfig.name}' failed`);
    }

    const toolOutputPaths: string[] = [];
    try {
      const stdoutPath = join(this.workspaceDir, 'stdout.txt');
      writeFileSync(stdoutPath, output || '', 'utf-8');
      toolOutputPaths.push(stdoutPath);
      if (stderr && stderr.trim()) {
        const stderrPath = join(this.workspaceDir, 'stderr.txt');
        writeFileSync(stderrPath, stderr, 'utf-8');
        toolOutputPaths.push(stderrPath);
      }
    } catch (err) {
      log.warn(`Failed to save tool output files: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (toolError) {
      throw new Error(`Tool '${toolConfig.name}' failed: ${toolError.message}\n${stderr}`);
    }

    this.emitEvent({
      type: 'done',
      message: `Tool '${toolConfig.name}' completed`,
      progress: 100,
      data: {
        nodeLabel: this.node.label,
        output: typeof output === 'string' ? output : undefined,
        outputPaths: toolOutputPaths,
      },
    });

    return {
      nodeId: this.node.id,
      output,
      durationMs: 0,
      toolCallCount: 1,
      findings: [],
      outputPaths: toolOutputPaths,
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
      cancelled: true,
    };
  }
}

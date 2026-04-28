/**
 * @module orchestration/agent-sdk-bridge
 * Bridge between OrionOmega's orchestration engine and the Claude Agent SDK.
 *
 * When the planner assigns a CODING_AGENT node, the executor routes to this bridge
 * instead of the generic agent loop. The Agent SDK provides Claude Code's full
 * coding toolset: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch,
 * plus subagent capabilities — all managed by Anthropic's battle-tested agent loop.
 *
 * This keeps OrionOmega's core small: we don't reimplement coding tools,
 * we delegate to the SDK that powers Claude Code itself.
 */

import { query, createSdkMcpServer, tool, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKToolProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { readConfig } from '../config/loader.js';
import type { WorkflowNode } from './types.js';
import { createLogger } from '../logging/logger.js';
import {
  isOrionOmegaAbortReason,
  describeAbortReason,
  type OrionOmegaAbortReason,
} from './abort-reason.js';
import { getPortAvoidanceInstructions } from '../utils/port-restrictions.js';
import { auditToolInvocation } from '../logging/audit.js';
import { SkillLoader, SkillExecutor, readSkillConfig } from '@orionomega/skills-sdk';
import type { SkillTool } from '@orionomega/skills-sdk';
import path from 'node:path';

const log = createLogger('agent-sdk-bridge');

/**
 * Classify whether an error returned from the SDK is worth retrying.
 *
 * - AbortError surfaces both for *user-driven* cancellation and for
 *   *AbortController-driven timeouts*. The bridge cannot distinguish those
 *   from inside the SDK; the caller knows which one it triggered. We mark
 *   AbortError as non-retryable here and rely on the executor's wall-clock
 *   timeout reasoning to retry timeouts at the outer layer.
 * - Authentication / API-key / 4xx errors are permanent.
 * - Anything else (network blips, rate limits, 5xx, unknown) is retryable.
 */
function isRetryableSdkError(err: unknown): boolean {
  if (err instanceof AbortError) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes('invalid api key') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('authentication failed') ||
    msg.includes('401') ||
    msg.includes('403')
  ) {
    return false;
  }
  return true;
}

/**
 * Build a human-readable error message from a non-success SDKResultError.
 * The SDK distinguishes several failure subtypes; surface them so operators
 * can act differently on, say, max-budget exhaustion vs an outright crash.
 */
function describeResultError(errorMsg: SDKResultError): string {
  const subtype = errorMsg.subtype;
  const summary = errorMsg.errors?.join('; ') ?? '';
  switch (subtype) {
    case 'error_max_turns':
      return `max turns reached${summary ? `: ${summary}` : ''}`;
    case 'error_max_budget_usd':
      return `max budget (USD) reached${summary ? `: ${summary}` : ''}`;
    case 'error_max_structured_output_retries':
      return `max structured-output retries reached${summary ? `: ${summary}` : ''}`;
    case 'error_during_execution':
      return `error during execution${summary ? `: ${summary}` : ''}`;
    default:
      return summary || String(subtype);
  }
}

/** Result of a coding agent invocation via the Agent SDK. */
export interface CodingAgentResult {
  /** Final text output from the agent. */
  output: string;
  /** Tool calls made during execution. */
  toolCalls: number;
  /** Whether the agent completed successfully. */
  success: boolean;
  /** Error message if the agent failed. */
  error?: string;
  /** Cost in USD (if reported by the SDK). */
  costUsd?: number;
  /** Duration in seconds. */
  durationSec: number;
  /** Paths of files written or edited during execution. */
  outputPaths: string[];
  // Token usage fields — needed so executor.ts can aggregate costs for CODING_AGENT nodes.
  /** Model used (for cost tracking). */
  model?: string;
  /** Input tokens consumed across all turns. */
  inputTokens?: number;
  /** Output tokens consumed across all turns. */
  outputTokens?: number;
  /** Cache read tokens across all turns. */
  cacheReadTokens?: number;
  /** Cache creation tokens across all turns. */
  cacheCreationTokens?: number;
  /**
   * If false, the failure is permanent (auth error, bad config) and the
   * caller should not retry. Undefined on success.
   */
  retryable?: boolean;
  /** SDK result subtype when the SDK reported a non-success result. */
  errorSubtype?: SDKResultError['subtype'];
}

/** Configuration for a coding agent node. */
export interface CodingAgentConfig {
  /** The task description for the coding agent. */
  task: string;
  /** Model to use (overrides default). */
  model?: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Additional directories the agent can access. */
  additionalDirectories?: string[];
  /** System prompt override or append. */
  systemPrompt?: string;
  /** Specific tools to allow (defaults to full coding toolset). */
  allowedTools?: string[];
  /** Maximum turns for this invocation. */
  maxTurns?: number;
  /** Maximum budget in USD for this invocation. */
  maxBudgetUsd?: number;
  /** Subagent definitions. */
  agents?: Record<string, { description: string; prompt: string; tools?: string[] }>;
}

/**
 * Default coding tools — the full Claude Code toolset.
 * These are auto-approved when permissionMode is 'acceptEdits'.
 */
const DEFAULT_CODING_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task',
];

/**
 * Default tools for AGENT nodes — the Claude Code toolset without subagent spawning.
 * Workers run autonomously but don't need to spawn their own sub-agents.
 */
const DEFAULT_AGENT_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
];

/** Configuration for a general AGENT node execution via the Agent SDK. */
export interface AgentExecutionConfig {
  /** The task description. */
  task: string;
  /** Resolved model ID. */
  model: string;
  /** Worker system prompt (plain string, built by buildWorkerSystemPrompt). */
  systemPrompt: string;
  /** Working directory for the agent. */
  cwd: string;
  /** Skill IDs — docs are injected via systemPrompt; reserved for future MCP integration. */
  skillIds?: string[];
  /**
   * Token budget from agent config. Converted to maxBudgetUsd unless
   * maxBudgetUsd is explicitly provided.
   */
  tokenBudget?: number;
  /** Explicit USD budget override (takes precedence over tokenBudget). */
  maxBudgetUsd?: number;
  /** Maximum agentic turns. Defaults to SDK config then 50. */
  maxTurns?: number;
  /** Abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
  /** Progress callback for WorkerEvent emission. */
  onProgress?: (event: { type: string; message: string; progress?: number }) => void;
  /** Optional structured output format. When provided, the SDK will return parsed JSON. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** Run output directory for this workflow. Injected as ORIONOMEGA_RUN_DIR env var. */
  runDir?: string;
}

/** Result of an AGENT node execution via the Agent SDK. */
export interface AgentExecutionResult {
  /** Final text output from the agent. */
  output: string;
  /** Total tool calls made. */
  toolCalls: number;
  /** Whether execution completed successfully. */
  success: boolean;
  /** Error message if the agent failed. */
  error?: string;
  /** Cost in USD (if reported by the SDK). */
  costUsd?: number;
  /** Duration in seconds. */
  durationSec: number;
  /** Paths to files written by the agent (tracked from Write tool calls). */
  outputPaths: string[];
  /** Parsed structured output when outputFormat was provided. */
  structuredOutput?: unknown;
  /**
   * The SDK result text (concise final summary), separate from the full
   * accumulated output. Prefer this for display; fall back to output if empty.
   */
  finalResult?: string;
  /** Total input tokens consumed across all turns. */
  inputTokens?: number;
  /** Total output tokens consumed across all turns. */
  outputTokens?: number;
  /** Total cache read tokens across all turns. */
  cacheReadTokens?: number;
  /** Total cache creation tokens across all turns. */
  cacheCreationTokens?: number;
  /**
   * If false, the failure is permanent (auth error, bad config) and the
   * caller should not retry. Undefined on success.
   */
  retryable?: boolean;
  /** SDK result subtype when the SDK reported a non-success result. */
  errorSubtype?: SDKResultError['subtype'];
}

/**
 * Converts a token budget to a rough USD estimate for the given model.
 * Uses input-token cost rates with a 4x multiplier to account for output tokens.
 */
function tokenBudgetToUsd(tokenBudget: number, model: string): number {
  const lower = model.toLowerCase();
  // Cost per million input tokens (approximate current rates)
  let costPerMillion: number;
  if (lower.includes('haiku')) costPerMillion = 1.0;
  else if (lower.includes('opus')) costPerMillion = 5.0;
  else costPerMillion = 3.0; // sonnet default

  // Multiply by 4 to account for output tokens and safety margin
  const estimated = (tokenBudget / 1_000_000) * costPerMillion * 4;
  return Math.max(1.0, Math.min(estimated, 50.0)); // Cap: $1 min, $50 max
}

// ── P5: Skill MCP server ─────────────────────────────────────────────

/**
 * Convert a JSON Schema property descriptor to a Zod type.
 * Handles the most common types; falls back to z.unknown() for complex schemas.
 */
function jsonSchemaPropertyToZod(
  prop: Record<string, unknown>,
  required: boolean,
): z.ZodType {
  const type = prop.type as string | undefined;

  let base: z.ZodType;

  if (prop.enum && Array.isArray(prop.enum)) {
    // Enum — use z.enum for string enums, z.unknown otherwise
    const values = prop.enum as unknown[];
    if (values.length >= 1 && values.every((v) => typeof v === 'string')) {
      base = z.enum(values as [string, ...string[]]);
    } else {
      // Mixed or non-string enum — accept any value
      base = z.unknown();
    }
  } else if (type === 'string') {
    base = z.string();
  } else if (type === 'number' || type === 'integer') {
    base = z.number();
  } else if (type === 'boolean') {
    base = z.boolean();
  } else if (type === 'array') {
    const items = prop.items as Record<string, unknown> | undefined;
    if (items?.type === 'string') {
      base = z.array(z.string());
    } else if (items?.type === 'number' || items?.type === 'integer') {
      base = z.array(z.number());
    } else {
      base = z.array(z.unknown());
    }
  } else if (type === 'object') {
    base = z.record(z.string(), z.unknown());
  } else {
    base = z.unknown();
  }

  return required ? base : base.optional();
}

/**
 * Convert a JSON Schema object descriptor (with `properties` and `required`)
 * into a Zod raw shape (plain object of zod types) for use with tool().
 */
function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodType> {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const requiredFields = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  const shape: Record<string, z.ZodType> = {};
  for (const [key, propDef] of Object.entries(properties)) {
    shape[key] = jsonSchemaPropertyToZod(propDef, requiredFields.has(key));
  }
  return shape;
}

/**
 * Build an in-process MCP server exposing all tools from the given skill IDs.
 *
 * Each skill's tools are registered as SDK MCP tool definitions. The handler
 * reads the skill's config.json to obtain API keys and other env vars, then
 * delegates to SkillExecutor.executeHandler() (JSON-in / JSON-out child process).
 *
 * @param skillIds - Skill identifiers to expose (e.g. ["linear"]).
 * @param skillsDir - Absolute path to the skills directory.
 * @returns McpSdkServerConfigWithInstance ready to pass to query() mcpServers.
 */
async function buildSkillMcpServer(
  skillIds: string[],
  skillsDir: string,
): Promise<McpSdkServerConfigWithInstance> {
  const loader = new SkillLoader(skillsDir);
  const executor = new SkillExecutor();
  const toolDefs: ReturnType<typeof tool>[] = [];

  for (const skillId of skillIds) {
    let loadedSkill;
    try {
      loadedSkill = await loader.load(skillId);
    } catch (err) {
      log.warn(
        `buildSkillMcpServer: skipping skill "${skillId}" — failed to load: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const skillConfig = readSkillConfig(skillsDir, skillId);
    if (!skillConfig.enabled) {
      log.warn(`buildSkillMcpServer: skipping skill "${skillId}" — disabled`);
      continue;
    }

    // Build env vars from skill config fields
    const skillEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(skillConfig.fields)) {
      skillEnv[key] = String(value);
    }

    const skillDir = loadedSkill.skillDir;
    const skillTools: SkillTool[] = loadedSkill.manifest.tools ?? [];

    for (const toolDef of skillTools) {
      const zodShape = jsonSchemaToZodShape(
        toolDef.inputSchema as Record<string, unknown>,
      );

      // Capture loop variables for the async handler closure
      const capturedHandlerPath = path.resolve(skillDir, toolDef.handler);
      const capturedTimeout = toolDef.timeout ?? 30_000;
      const capturedSkillDir = skillDir;
      const capturedEnv = skillEnv;

      const mcpTool = tool(
        toolDef.name,
        toolDef.description,
        zodShape,
        async (args: Record<string, unknown>) => {
          try {
            const result = await executor.executeHandler(
              capturedHandlerPath,
              args,
              {
                cwd: capturedSkillDir,
                timeout: capturedTimeout,
                env: capturedEnv,
              },
            );
            const text =
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2);
            return { content: [{ type: 'text' as const, text }] };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.warn(`Skill tool "${toolDef.name}" failed: ${errMsg}`);
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg}` }],
              isError: true,
            };
          }
        },
      );

      toolDefs.push(mcpTool);
      log.info(`Registered MCP skill tool: ${toolDef.name} (from ${skillId})`);
    }
  }

  return createSdkMcpServer({ name: 'orionomega-skills', tools: toolDefs });
}

/**
 * Execute a general AGENT node using the Claude Agent SDK.
 *
 * This replaces the hand-rolled runAgentLoop() for AGENT nodes, gaining the
 * full Claude Code toolset (Bash, Glob, Grep, WebSearch, WebFetch, etc.),
 * adaptive thinking, and non-blocking async tool execution.
 *
 * @param options - Agent execution configuration.
 * @returns AgentExecutionResult with output, metrics, and output file paths.
 */
export async function executeAgent(
  options: AgentExecutionConfig,
): Promise<AgentExecutionResult> {
  const config = readConfig();
  const sdkConfig = config.agentSdk;
  const apiKey = config.models.apiKey;

  if (!apiKey) {
    return {
      output: '',
      toolCalls: 0,
      success: false,
      error: 'No API key configured',
      durationSec: 0,
      outputPaths: [],
      // Permanent: no retry will conjure an API key into existence.
      retryable: false,
    };
  }

  const {
    task, model, systemPrompt, cwd,
    abortSignal, onProgress, outputFormat,
  } = options;

  const maxTurns = options.maxTurns ?? sdkConfig.maxTurns ?? 50;
  const maxBudgetUsd = options.maxBudgetUsd
    ?? sdkConfig.maxBudgetUsd
    ?? (options.tokenBudget ? tokenBudgetToUsd(options.tokenBudget, model) : undefined);

  log.info(`Starting agent: "${task.slice(0, 80)}..."`, { model, cwd, maxTurns });
  onProgress?.({ type: 'status', message: `Agent starting: ${task.slice(0, 60)}...`, progress: 0 });

  const abortController = new AbortController();
  // `queryResult` is created later but the abort signal can fire at any point.
  // Holding it in a ref lets the abort listener attempt a graceful interrupt
  // (`Query.interrupt()`) before we hard-abort the SDK process.
  const queryRef: { current: { interrupt?: () => Promise<void> | void } | null } = { current: null };
  let interruptAttempted = false;
  const tryGracefulInterrupt = (): void => {
    if (interruptAttempted) return;
    interruptAttempted = true;
    const q = queryRef.current;
    if (!q || typeof q.interrupt !== 'function') return;
    try {
      // Fire-and-forget; SDK rejects to abort path on failure.
      void Promise.resolve(q.interrupt()).catch(() => { /* swallow — abort path will fire */ });
    } catch { /* swallow — abort path will fire */ }
  };
  /**
   * Two-phase shutdown: try `Query.interrupt()` first to let the SDK end its
   * current turn gracefully, then escalate to `AbortController.abort(reason)`
   * after `INTERRUPT_GRACE_MS` if the iterator hasn't finished. This avoids
   * leaving the SDK with a half-streamed message AND guarantees we don't hang
   * forever on a wedged interrupt.
   */
  const INTERRUPT_GRACE_MS = 5_000;
  const escalateToHardAbort = (reason: unknown): void => {
    tryGracefulInterrupt();
    setTimeout(() => abortController.abort(reason), INTERRUPT_GRACE_MS).unref?.();
  };
  if (abortSignal) {
    // Forward the *reason* too — without this the inner controller would
    // throw a plain "AbortError" with no kind, and the catch site couldn't
    // distinguish a user cancel from a wall-clock timeout.
    if (abortSignal.aborted) {
      escalateToHardAbort(abortSignal.reason);
    } else {
      abortSignal.addEventListener('abort', () => escalateToHardAbort(abortSignal.reason));
    }
  }

  const startTime = Date.now();
  let output = '';
  let finalResult = '';
  let toolCalls = 0;
  let costUsd: number | undefined;
  let structuredOutput: unknown;
  const outputPaths: string[] = [];
  let progressEstimate = 5;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  // P5: Build skill MCP server if skillIds are provided
  let mcpServers: Record<string, McpSdkServerConfigWithInstance> | undefined;
  if (options.skillIds?.length) {
    const skillsDir = readConfig().skills?.directory;
    if (skillsDir) {
      try {
        const mcpServer = await buildSkillMcpServer(options.skillIds, skillsDir);
        mcpServers = { 'orionomega-skills': mcpServer };
        log.info(`Skill MCP server built with ${options.skillIds.join(', ')} for worker`);
      } catch (err) {
        log.warn(
          `Failed to build skill MCP server: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  try {
    // Use the same permission mode as coding agents — bypassPermissions crashes
    // if claude hasn't been explicitly opted in, so respect the config setting
    const permissionMode = sdkConfig.permissionMode === 'bypassPermissions'
      ? 'bypassPermissions'
      : sdkConfig.permissionMode === 'acceptEdits'
        ? 'acceptEdits'
        : 'default';

    if (permissionMode === 'bypassPermissions') {
      log.warn(
        '[security] bypassPermissions mode is active — all tool permission prompts will be ' +
        'skipped for this agent. Ensure this is intentional. Review humanGates config if ' +
        'running in autonomous mode.',
      );
    }

    const queryResult = query({
      prompt: task,
      options: {
        model,
        cwd,
        allowedTools: DEFAULT_AGENT_TOOLS,
        permissionMode,
        // (queryRef wired below — needs queryResult to exist first)
        ...(permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        effort: sdkConfig.effort ?? 'high',
        // Adaptive thinking — Claude decides when/how much to think
        thinking: { type: 'adaptive' },
        maxTurns,
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
        systemPrompt,
        abortController,
        env: {
          ...process.env,
          HOME: process.env.HOME || '/root',
          PATH: process.env.PATH || '',
          TERM: process.env.TERM || 'xterm-256color',
          SHELL: process.env.SHELL || '/bin/sh',
          USER: process.env.USER || '',
          LANG: process.env.LANG || 'en_US.UTF-8',
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'orionomega-worker',
        },
        additionalDirectories: sdkConfig.additionalDirectories,
        // Omit settingSources — default is no CLAUDE.md loading; the worker
        // system prompt is self-contained.
        persistSession: false,
        // P5: Skill MCP server (if any skills are configured)
        ...(mcpServers ? { mcpServers } : {}),
        // P6: Structured output format (optional)
        ...(outputFormat ? { outputFormat } : {}),
        // Capture stderr for diagnostics when the CLI process crashes
        stderr: (data: string) => log.debug(`[agent-stderr] ${data.trimEnd()}`),
      },
    });
    // Wire the queryRef *before* the abort handler can fire mid-iteration —
    // otherwise abort would skip straight to the hard-abort path.
    queryRef.current = queryResult as unknown as { interrupt?: () => Promise<void> | void };
    if (abortController.signal.aborted) {
      // The abort fired between controller creation and queryResult assignment;
      // attempt the graceful interrupt now.
      tryGracefulInterrupt();
    }

    for await (const message of queryResult) {
      // Assistant message — collect text and tool use
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        const usage = (assistantMsg.message as Record<string, unknown>)?.usage as
          { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        if (usage) {
          totalInputTokens += usage.input_tokens ?? 0;
          totalOutputTokens += usage.output_tokens ?? 0;
          totalCacheReadTokens += usage.cache_read_input_tokens ?? 0;
          totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        }
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              output += block.text + '\n';
              onProgress?.({
                type: 'status',
                message: block.text.trim().slice(0, 100),
                progress: Math.min(progressEstimate, 90),
              });
            }

            if (block.type === 'tool_use') {
              toolCalls++;
              progressEstimate = Math.min(progressEstimate + 5, 90);
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown> | undefined ?? {};
              auditToolInvocation(toolName, toolInput);

              // Build a concise summary
              let summary = toolName;
              if (toolInput.file_path) summary = `${toolName}: ${String(toolInput.file_path)}`;
              else if (toolInput.command) summary = `${toolName}: ${String(toolInput.command).slice(0, 80)}`;
              else if (toolInput.pattern) summary = `${toolName}: ${String(toolInput.pattern)}`;
              else if (toolInput.url) summary = `${toolName}: ${String(toolInput.url).slice(0, 80)}`;

              // Track write/edit paths for output reporting
              if ((toolName === 'Write' || toolName === 'Edit') && toolInput.file_path) {
                outputPaths.push(String(toolInput.file_path));
              }

              onProgress?.({
                type: 'tool_call',
                message: summary,
                progress: progressEstimate,
              });
            }
          }
        }
      }

      // Result message — final output
      if (message.type === 'result') {
        costUsd = (message as SDKResultSuccess | SDKResultError).total_cost_usd;

        if ((message as SDKResultSuccess).subtype === 'success') {
          const successMsg = message as SDKResultSuccess;
          // P6: Prefer structured output over raw text when available
          if (successMsg.structured_output !== undefined) {
            structuredOutput = successMsg.structured_output;
            finalResult = JSON.stringify(successMsg.structured_output, null, 2);
            output += '\n' + finalResult;
          } else if (successMsg.result) {
            finalResult = successMsg.result;
            output += '\n' + successMsg.result;
          }
        } else {
          // SDK reported a structured error result — surface the subtype so the
          // caller can decide whether the failure is worth retrying.
          const errorMsg = message as SDKResultError;
          const description = describeResultError(errorMsg);
          log.warn(`Agent result error (${errorMsg.subtype}): ${description}`);
          // max_budget / max_turns are *not* retryable — the same call would
          // hit the same cap. error_during_execution typically is.
          const retryable =
            errorMsg.subtype === 'error_during_execution';
          const durationSec = (Date.now() - startTime) / 1000;
          return {
            output: output.trim(),
            toolCalls,
            success: false,
            error: `SDK ${errorMsg.subtype}: ${description}`,
            durationSec,
            costUsd,
            outputPaths,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadTokens: totalCacheReadTokens,
            cacheCreationTokens: totalCacheCreationTokens,
            retryable,
            errorSubtype: errorMsg.subtype,
          };
        }

        onProgress?.({
          type: 'done',
          message: `Agent complete: ${toolCalls} tool calls`,
          progress: 100,
        });
      }
    }

    const durationSec = (Date.now() - startTime) / 1000;
    log.info(`Agent completed: ${toolCalls} tool calls, ${durationSec.toFixed(1)}s${costUsd ? ` ($${costUsd.toFixed(4)})` : ''}`);

    return {
      output: output.trim(),
      toolCalls,
      success: true,
      durationSec,
      costUsd,
      outputPaths,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(finalResult ? { finalResult } : {}),
    };
  } catch (err) {
    const durationSec = (Date.now() - startTime) / 1000;
    const aborted = err instanceof AbortError;

    // Disambiguate aborts: if the executor cancelled us with a typed reason,
    // surface that instead of the SDK's stock "process aborted by user"
    // message. This is the core of the timeout-vs-user fix — without it,
    // every wall-clock-driven cancel reads as a user cancel.
    let displayMessage: string;
    let retryable: boolean;
    if (aborted) {
      const reason = options.abortSignal?.reason;
      if (isOrionOmegaAbortReason(reason)) {
        displayMessage = `Agent ${describeAbortReason(reason)}`;
        // Timeout aborts are transient; user cancels are terminal.
        retryable = reason.kind === 'timeout';
      } else {
        displayMessage = err instanceof Error ? err.message : String(err);
        retryable = false;
      }
    } else {
      displayMessage = err instanceof Error ? err.message : String(err);
      retryable = isRetryableSdkError(err);
    }

    log.error(`Agent failed${aborted ? ' (aborted)' : ''}: ${displayMessage}`);
    onProgress?.({ type: 'error', message: `Agent error: ${displayMessage}` });

    return {
      output: output.trim(),
      toolCalls,
      success: false,
      error: displayMessage,
      durationSec,
      outputPaths,
      retryable,
    };
  }
}

/**
 * Execute a coding task using the Claude Agent SDK.
 *
 * This is the main entry point called by the executor for CODING_AGENT nodes.
 * It wraps the SDK's `query()` function, collecting streaming output and
 * returning a structured result.
 *
 * @param node - The workflow node with coding agent configuration.
 * @param workspaceDir - Default working directory.
 * @param onProgress - Callback for progress updates during execution.
 * @returns CodingAgentResult with the agent's output and metrics.
 */
export async function executeCodingAgent(
  node: WorkflowNode,
  workspaceDir: string,
  onProgress?: (event: { type: string; message: string; progress?: number; thinking?: string }) => void,
  abortSignal?: AbortSignal,
  runDir?: string,
): Promise<CodingAgentResult> {
  const config = readConfig();
  const sdkConfig = config.agentSdk;
  const apiKey = config.models.apiKey;
  const codingConfig = node.codingAgent ?? { task: node.agent?.task ?? '' };

  if (!apiKey) {
    return {
      output: '',
      toolCalls: 0,
      success: false,
      error: 'No API key configured',
      durationSec: 0,
      outputPaths: [],
      // Permanent: no retry will conjure an API key into existence.
      retryable: false,
    };
  }

  const task = codingConfig.task;
  const cwd = codingConfig.cwd ?? workspaceDir;
  const model = codingConfig.model ?? node.agent?.model ?? config.models.default;
  const allowedTools = codingConfig.allowedTools ?? DEFAULT_CODING_TOOLS;
  const maxTurns = codingConfig.maxTurns ?? sdkConfig.maxTurns ?? 50;
  const maxBudgetUsd = codingConfig.maxBudgetUsd ?? sdkConfig.maxBudgetUsd;

  log.info(`Starting coding agent: "${task.slice(0, 80)}..."`, {
    model, cwd, tools: allowedTools.length, maxTurns,
  });

  onProgress?.({ type: 'status', message: `Coding agent starting: ${task.slice(0, 60)}...`, progress: 0 });

  // P2: AbortController for SDK cancellation. Forward the abort *reason*
  // so the catch site can distinguish a user cancel from a wall-clock
  // timeout — see executeAgent for the same pattern + rationale. Also
  // attempt a graceful `Query.interrupt()` before the hard abort so the
  // SDK can flush its current turn instead of leaving a half-streamed
  // message behind. The two-phase shutdown gives the SDK 5s to drain
  // before we hard-abort.
  const abortController = new AbortController();
  const queryRef: { current: { interrupt?: () => Promise<void> | void } | null } = { current: null };
  let interruptAttempted = false;
  const tryGracefulInterrupt = (): void => {
    if (interruptAttempted) return;
    interruptAttempted = true;
    const q = queryRef.current;
    if (!q || typeof q.interrupt !== 'function') return;
    try {
      void Promise.resolve(q.interrupt()).catch(() => { /* swallow — abort path will fire */ });
    } catch { /* swallow — abort path will fire */ }
  };
  const INTERRUPT_GRACE_MS = 5_000;
  const escalateToHardAbort = (reason: unknown): void => {
    tryGracefulInterrupt();
    setTimeout(() => abortController.abort(reason), INTERRUPT_GRACE_MS).unref?.();
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      escalateToHardAbort(abortSignal.reason);
    } else {
      abortSignal.addEventListener('abort', () => escalateToHardAbort(abortSignal.reason));
    }
  }

  const startTime = Date.now();
  let output = '';
  let toolCalls = 0;
  let costUsd: number | undefined;
  const outputPaths: string[] = [];
  // Fix: accumulate token counts across all turns so they can be reported upstream.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  try {
    // Build the system prompt
    const portInstructions = getPortAvoidanceInstructions(config);
    const runDirInstruction = runDir
      ? `\n\n## Output Directory\nAll deliverable files (reports, artifacts, generated code, data) should be written to the run output directory: \`${runDir}\`\nThis directory is the canonical location for this workflow run's artifacts. Use it instead of /tmp/ for any output files.\nThe run directory is also available via the ORIONOMEGA_RUN_DIR environment variable.`
      : '';
    let systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append?: string };
    if (codingConfig.systemPrompt) {
      // Use Claude Code's system prompt with appended instructions
      systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: `${codingConfig.systemPrompt}\n\n${portInstructions}${runDirInstruction}`,
      };
    } else {
      // Use Claude Code's default system prompt with port restrictions
      systemPrompt = { type: 'preset', preset: 'claude_code', append: `${portInstructions}${runDirInstruction}` };
    }

    // Build agents map if provided
    const agents = codingConfig.agents
      ? Object.fromEntries(
          Object.entries(codingConfig.agents).map(([name, def]) => [
            name,
            {
              description: def.description,
              prompt: def.prompt,
              tools: def.tools ?? ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
            },
          ]),
        )
      : undefined;

    const codingPermissionMode = sdkConfig.permissionMode === 'bypassPermissions'
      ? 'bypassPermissions'
      : sdkConfig.permissionMode === 'acceptEdits'
        ? 'acceptEdits'
        : 'default';

    if (codingPermissionMode === 'bypassPermissions') {
      log.warn(
        '[security] bypassPermissions mode is active — all tool permission prompts will be ' +
        'skipped for this coding agent. Ensure this is intentional. Review humanGates config ' +
        'if running in autonomous mode.',
      );
    }

    const queryResult = query({
      prompt: task,
      options: {
        model,
        cwd,
        allowedTools,
        permissionMode: codingPermissionMode,
        ...(codingPermissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        effort: sdkConfig.effort ?? 'high',
        maxTurns,
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
        systemPrompt,
        // P4: Adaptive thinking — Claude decides when and how much to think
        thinking: { type: 'adaptive' },
        // P2: AbortController for cooperative cancellation
        abortController,
        env: {
          ...process.env,
          HOME: process.env.HOME || '/root',
          PATH: process.env.PATH || '',
          TERM: process.env.TERM || 'xterm-256color',
          SHELL: process.env.SHELL || '/bin/sh',
          USER: process.env.USER || '',
          LANG: process.env.LANG || 'en_US.UTF-8',
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'orionomega-orchestrator',
          ...(runDir ? { ORIONOMEGA_RUN_DIR: runDir } : {}),
        },
        additionalDirectories: codingConfig.additionalDirectories ?? sdkConfig.additionalDirectories,
        ...(agents ? { agents } : {}),
        settingSources: ['project'], // Load CLAUDE.md files from the project
        persistSession: false, // Don't persist — orchestration manages state
        // Capture stderr for diagnostics when the CLI process crashes
        stderr: (data: string) => log.debug(`[coding-agent-stderr] ${data.trimEnd()}`),
      },
    });
    // Wire queryRef so a mid-stream abort can call Query.interrupt() first
    // (graceful turn-end) before the hard SDK abort fires. See executeAgent
    // for the same pattern.
    queryRef.current = queryResult as unknown as { interrupt?: () => Promise<void> | void };
    if (abortController.signal.aborted) {
      tryGracefulInterrupt();
    }

    for await (const message of queryResult) {
      // P3: Use message.type discriminator for proper typed handling

      // Assistant message — collect text, thinking, and tool use
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        // Fix: extract per-turn token usage so we can report total costs for CODING_AGENT nodes.
        const usage = (assistantMsg.message as Record<string, unknown>)?.usage as
          { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        if (usage) {
          totalInputTokens += usage.input_tokens ?? 0;
          totalOutputTokens += usage.output_tokens ?? 0;
          totalCacheReadTokens += usage.cache_read_input_tokens ?? 0;
          totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        }
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if (block.type === 'thinking' && 'thinking' in block) {
              const thinkingText = (block as { thinking: string }).thinking;
              onProgress?.({
                type: 'thinking',
                message: thinkingText.slice(0, 100),
                thinking: thinkingText,
              });
            }
            if (block.type === 'text') {
              output += block.text + '\n';
            }
            if (block.type === 'tool_use') {
              toolCalls++;
              const pct = Math.min(90, Math.round((toolCalls / maxTurns) * 100));
              const toolInput = block.input as Record<string, unknown> | undefined;
              const toolName = block.name;
              auditToolInvocation(toolName, toolInput ?? {});
              const filePath = toolInput && typeof toolInput === 'object' && 'file_path' in toolInput
                ? ` → ${toolInput.file_path}`
                : '';
              onProgress?.({
                type: 'tool',
                message: `Tool: ${toolName}${filePath}`,
                progress: pct,
              });
              if ((toolName === 'Write' || toolName === 'Edit') && toolInput?.file_path) {
                outputPaths.push(String(toolInput.file_path));
              }
            }
          }
        }
      }

      // Tool progress — richer subagent/tool progress reporting
      if (message.type === 'tool_progress') {
        const tpMsg = message as SDKToolProgressMessage;
        onProgress?.({
          type: 'tool',
          message: `Tool running: ${tpMsg.tool_name} (${tpMsg.elapsed_time_seconds.toFixed(1)}s)`,
        });
      }

      // System messages — subagent task lifecycle
      if (message.type === 'system') {
        const sysMsg = message as SDKTaskStartedMessage | SDKTaskProgressMessage;
        if (sysMsg.subtype === 'task_started') {
          onProgress?.({
            type: 'status',
            message: `Subagent started: ${(sysMsg as SDKTaskStartedMessage).description}`,
          });
        } else if (sysMsg.subtype === 'task_progress') {
          const tp = sysMsg as SDKTaskProgressMessage;
          onProgress?.({
            type: 'status',
            message: `Subagent progress: ${tp.description}${tp.last_tool_name ? ` (${tp.last_tool_name})` : ''}`,
          });
        }
      }

      // Result message — final output (success or error)
      if (message.type === 'result') {
        costUsd = (message as SDKResultSuccess | SDKResultError).total_cost_usd;

        if ((message as SDKResultSuccess).subtype === 'success') {
          const successMsg = message as SDKResultSuccess;
          if (successMsg.result) {
            output += '\n' + successMsg.result;
          }
        } else {
          // SDK reported a structured error result (subtype !== 'success').
          // Surface the subtype so callers can react: max_budget / max_turns
          // are not retryable; error_during_execution typically is.
          const errorMsg = message as SDKResultError;
          const description = describeResultError(errorMsg);
          log.warn(`Coding agent result error (${errorMsg.subtype}): ${description}`);
          const retryable = errorMsg.subtype === 'error_during_execution';
          const durationSec = (Date.now() - startTime) / 1000;
          return {
            output: output.trim(),
            toolCalls,
            success: false,
            error: `SDK ${errorMsg.subtype}: ${description}`,
            durationSec,
            costUsd,
            outputPaths: [...new Set(outputPaths)],
            model,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadTokens: totalCacheReadTokens,
            cacheCreationTokens: totalCacheCreationTokens,
            retryable,
            errorSubtype: errorMsg.subtype,
          };
        }

        onProgress?.({
          type: 'done',
          message: `Coding agent complete: ${toolCalls} tool calls`,
          progress: 100,
        });
      }
    }

    const durationSec = (Date.now() - startTime) / 1000;

    log.info(`Coding agent completed: ${toolCalls} tool calls, ${durationSec.toFixed(1)}s`);

    return {
      output: output.trim(),
      toolCalls,
      success: true,
      durationSec,
      costUsd,
      outputPaths: [...new Set(outputPaths)],
      // Fix: include token counts and model so executor.ts can aggregate cost for CODING_AGENT nodes.
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
    };
  } catch (err) {
    const durationSec = (Date.now() - startTime) / 1000;
    const aborted = err instanceof AbortError;

    // Disambiguate aborts using the typed reason on the abort signal — see
    // executeAgent above for the rationale. Without this, every cancel
    // surfaces as the SDK's "Claude Code process aborted by user" message
    // even when the *real* cause was the executor's wall-clock timeout.
    let displayMessage: string;
    let retryable: boolean;
    if (aborted) {
      const reason = abortSignal?.reason;
      if (isOrionOmegaAbortReason(reason)) {
        displayMessage = `Coding agent ${describeAbortReason(reason)}`;
        retryable = reason.kind === 'timeout';
      } else {
        displayMessage = err instanceof Error ? err.message : String(err);
        retryable = false;
      }
    } else {
      displayMessage = err instanceof Error ? err.message : String(err);
      retryable = isRetryableSdkError(err);
    }

    log.error(`Coding agent failed${aborted ? ' (aborted)' : ''}: ${displayMessage}`);

    onProgress?.({
      type: 'error',
      message: `Coding agent error: ${displayMessage}`,
    });

    return {
      output: output.trim(),
      toolCalls,
      success: false,
      error: displayMessage,
      durationSec,
      outputPaths: [...new Set(outputPaths)],
      // Fix: include partial token counts even on failure so partial usage is accounted for.
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      retryable,
    };
  }
}

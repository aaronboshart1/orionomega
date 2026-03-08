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

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKToolProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { OrionOmegaConfig } from '../config/types.js';
import { readConfig } from '../config/loader.js';
import type { WorkflowNode } from './types.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('agent-sdk-bridge');

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
  onProgress?: (event: { type: string; message: string; progress?: number }) => void,
  abortSignal?: AbortSignal,
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

  // P2: AbortController for SDK cancellation
  const abortController = new AbortController();
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => abortController.abort());
  }

  const startTime = Date.now();
  let output = '';
  let toolCalls = 0;
  let costUsd: number | undefined;

  try {
    // Build the system prompt
    let systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append?: string };
    if (codingConfig.systemPrompt) {
      // Use Claude Code's system prompt with appended instructions
      systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: codingConfig.systemPrompt,
      };
    } else {
      // Use Claude Code's default system prompt
      systemPrompt = { type: 'preset', preset: 'claude_code' };
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

    const queryResult = query({
      prompt: task,
      options: {
        model,
        cwd,
        allowedTools,
        permissionMode: sdkConfig.permissionMode === 'bypassPermissions'
          ? 'bypassPermissions'
          : sdkConfig.permissionMode === 'acceptEdits'
            ? 'acceptEdits'
            : 'default',
        ...(sdkConfig.permissionMode === 'bypassPermissions'
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
          ANTHROPIC_API_KEY: apiKey,
          // P3: Identify this client to the SDK
          CLAUDE_AGENT_SDK_CLIENT_APP: 'orionomega-orchestrator',
        },
        additionalDirectories: codingConfig.additionalDirectories ?? sdkConfig.additionalDirectories,
        ...(agents ? { agents } : {}),
        settingSources: ['project'], // Load CLAUDE.md files from the project
        persistSession: false, // Don't persist — orchestration manages state
      },
    });

    for await (const message of queryResult) {
      // P3: Use message.type discriminator for proper typed handling

      // Assistant message — collect text and tool use
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              output += block.text + '\n';
            }
            if (block.type === 'tool_use') {
              toolCalls++;
              const pct = Math.min(90, Math.round((toolCalls / maxTurns) * 100));
              const filePath = block.input && typeof block.input === 'object' && 'file_path' in block.input
                ? ` → ${(block.input as Record<string, unknown>).file_path}`
                : '';
              onProgress?.({
                type: 'tool',
                message: `Tool: ${block.name}${filePath}`,
                progress: pct,
              });
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
          // Error result — log the errors
          const errorMsg = message as SDKResultError;
          const errSummary = errorMsg.errors?.join('; ') ?? errorMsg.subtype;
          log.warn(`Coding agent result error: ${errSummary}`);
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
    };
  } catch (err) {
    const durationSec = (Date.now() - startTime) / 1000;
    const errorMsg = err instanceof Error ? err.message : String(err);

    log.error(`Coding agent failed: ${errorMsg}`);

    onProgress?.({
      type: 'error',
      message: `Coding agent error: ${errorMsg}`,
    });

    return {
      output: output.trim(),
      toolCalls,
      success: false,
      error: errorMsg,
      durationSec,
    };
  }
}

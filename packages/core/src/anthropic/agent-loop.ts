/**
 * @module anthropic/agent-loop
 * Core agent conversation loop with tool use, streaming, and automatic retries.
 *
 * @deprecated AGENT nodes now use the Claude Agent SDK via executeAgent() in
 * agent-sdk-bridge.ts, which provides adaptive thinking, richer tooling, and
 * non-blocking async execution. This module is retained as a fallback and may
 * still be used by other non-worker consumers. Do NOT delete without auditing
 * all import sites.
 *
 * This is the heart of the worker execution system. It sends messages to the
 * Anthropic API, streams responses, handles tool_use blocks by executing tools
 * and feeding results back, and loops until the model signals end_turn.
 */

import type {
  AnthropicClient,
  AnthropicMessage,
  ContentBlock,
  ToolDefinition,
} from './client.js';
import { maxOutputTokensForModel } from './client.js';
import type { BuiltInTool, ToolContext } from './tools.js';
import { auditToolInvocation } from '../logging/audit.js';

/** Options for running the agent loop. */
export interface AgentLoopOptions {
  /** The Anthropic client instance. */
  client: AnthropicClient;
  /** Model identifier (e.g. 'claude-sonnet-4-20250514'). */
  model: string;
  /** System prompt for the agent. */
  systemPrompt: string;
  /** Available tools. */
  tools: BuiltInTool[];
  /** Initial conversation messages. */
  messages: AnthropicMessage[];
  /** Maximum conversation turns before stopping. Defaults to 50. */
  maxTurns?: number;
  /** Maximum tokens per response. Defaults to 8192. */
  maxTokens?: number;
  /** Working directory for tool execution. */
  workingDir: string;

  /** Called when the model emits thinking text. */
  onThinking?: (text: string) => void;
  /** Called when the model emits response text. */
  onText?: (text: string) => void;
  /** Called when the model requests a tool call. */
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  /** Called when a tool returns a result. */
  onToolResult?: (name: string, result: string) => void;
  /** Called to check if the loop should be cancelled. */
  isCancelled?: () => boolean;
  /**
   * Maximum cumulative input tokens before the loop is stopped.
   * At 80% of budget, a warning is injected. At 100%, the loop halts.
   */
  maxInputTokens?: number;
}

/** Result of a completed agent loop. */
export interface AgentLoopResult {
  /** Full conversation history including all tool interactions. */
  messages: AnthropicMessage[];
  /** The last text content from the assistant. */
  finalText: string;
  /** Total number of tool calls made. */
  toolCalls: number;
  /** Total input tokens consumed across all turns. */
  inputTokens: number;
  /** Total output tokens consumed across all turns. */
  outputTokens: number;
  /** Total tokens used to create cache entries. */
  cacheCreationTokens: number;
  /** Total tokens read from cache (90% cost reduction). */
  cacheReadTokens: number;
  /** Whether the loop was stopped due to token budget. */
  stoppedByBudget: boolean;
}

/**
 * Runs the agent loop: send messages → stream response → execute tools → repeat.
 *
 * The loop continues until the model returns stop_reason 'end_turn',
 * the maximum number of turns is reached, or cancellation is requested.
 *
 * @param options - Agent loop configuration and callbacks.
 * @returns The final result with conversation history and usage stats.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    client,
    model,
    systemPrompt,
    tools,
    messages,
    maxTurns = 50,
    maxTokens = maxOutputTokensForModel(model),
    workingDir,
    onThinking,
    onText,
    onToolCall,
    onToolResult,
    isCancelled,
    maxInputTokens,
  } = options;

  const toolContext: ToolContext = {
    workingDir,
    timeout: 120,
  };

  // Build tool definitions for the API
  const toolDefs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  // Build a lookup map for tool execution
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Clone messages so we don't mutate the caller's array
  const conversation: AnthropicMessage[] = [...messages];

  let totalToolCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let finalText = '';
  let budgetWarningInjected = false;
  let stoppedByBudget = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Check cancellation
    if (isCancelled?.()) break;

    // Token budget enforcement — hard stop at 100%
    if (maxInputTokens && totalInputTokens >= maxInputTokens) {
      stoppedByBudget = true;
      // Inject a final "wrap up" message and do one last turn
      conversation.push({
        role: 'user',
        content: 'TOKEN BUDGET REACHED. Provide your final summary now. Do not make any more tool calls.',
      });

      const wrapUp = await streamAssistantTurn(
        client, model, systemPrompt, conversation, toolDefs, maxTokens, onThinking, onText,
      );
      totalInputTokens += wrapUp.usage.inputTokens;
      totalOutputTokens += wrapUp.usage.outputTokens;
      totalCacheCreationTokens += wrapUp.usage.cacheCreationTokens;
      totalCacheReadTokens += wrapUp.usage.cacheReadTokens;

      conversation.push({ role: 'assistant', content: wrapUp.contentBlocks });
      for (const block of wrapUp.contentBlocks) {
        if (block.type === 'text' && block.text) finalText = block.text;
      }
      break;
    }

    // Token budget warning at 80%
    if (maxInputTokens && !budgetWarningInjected && totalInputTokens >= maxInputTokens * 0.8) {
      budgetWarningInjected = true;
      conversation.push({
        role: 'user',
        content: `[SYSTEM] You have used ${totalInputTokens.toLocaleString()} of your ${maxInputTokens.toLocaleString()} token budget (${Math.round((totalInputTokens / maxInputTokens) * 100)}%). Wrap up your current task efficiently and produce final output soon.`,
      });
    }

    // Collect the full assistant response from the stream
    const { contentBlocks, stopReason, usage } = await streamAssistantTurn(
      client,
      model,
      systemPrompt,
      conversation,
      toolDefs,
      maxTokens,
      onThinking,
      onText,
    );

    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalCacheCreationTokens += usage.cacheCreationTokens;
    totalCacheReadTokens += usage.cacheReadTokens;

    // Append assistant message
    conversation.push({
      role: 'assistant',
      content: contentBlocks,
    });

    // Extract the last text block as the final text
    for (const block of contentBlocks) {
      if (block.type === 'text' && block.text) {
        finalText = block.text;
      }
    }

    // If the model hit the output token limit without requesting tool use,
    // ask it to continue rather than silently truncating.
    if (stopReason === 'max_tokens') {
      const textBlocks = contentBlocks.filter((b) => b.type === 'text');
      const hasToolUse = contentBlocks.some((b) => b.type === 'tool_use');
      if (!hasToolUse && textBlocks.length > 0) {
        conversation.push({
          role: 'user',
          content: 'Continue where you left off.',
        });
        continue;
      }
    }

    // If no tool use, we're done
    if (stopReason !== 'tool_use') break;

    // Extract tool_use blocks and execute them
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    const toolResults: ContentBlock[] = [];

    for (const block of toolUseBlocks) {
      if (isCancelled?.()) break;

      const toolName = block.name ?? 'unknown';
      const toolInput = (block.input ?? {}) as Record<string, unknown>;
      const toolUseId = block.id ?? '';

      totalToolCalls++;
      onToolCall?.(toolName, toolInput);
      auditToolInvocation(toolName, toolInput);

      const tool = toolMap.get(toolName);
      let result: string;

      if (!tool) {
        result = `Error: Unknown tool '${toolName}'. Available tools: ${[...toolMap.keys()].join(', ')}`;
      } else {
        try {
          result = await tool.execute(toolInput, toolContext);
        } catch (err) {
          result = `Error executing tool '${toolName}': ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      onToolResult?.(toolName, result);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: result,
      });
    }

    // Append tool results as a user message
    conversation.push({
      role: 'user',
      content: toolResults,
    });
  }

  return {
    messages: conversation,
    finalText,
    toolCalls: totalToolCalls,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    cacheReadTokens: totalCacheReadTokens,
    stoppedByBudget,
  };
}

// ── Internal helpers ──────────────────────────────────────────────

interface TurnResult {
  contentBlocks: ContentBlock[];
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

/**
 * Streams a single assistant turn and reassembles content blocks.
 */
async function streamAssistantTurn(
  client: AnthropicClient,
  model: string,
  systemPrompt: string,
  messages: AnthropicMessage[],
  tools: ToolDefinition[],
  maxTokens: number,
  onThinking?: (text: string) => void,
  onText?: (text: string) => void,
): Promise<TurnResult> {
  const contentBlocks: ContentBlock[] = [];
  let _currentBlockIndex = -1;
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  // Accumulate partial data for the current block
  const blockAccumulators = new Map<
    number,
    { type: string; text: string; id?: string; name?: string; partialJson: string }
  >();

  const stream = client.streamMessage({
    model,
    messages,
    system: systemPrompt,
    tools: tools.length > 0 ? tools : undefined,
    maxTokens,
    stream: true,
  });

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start': {
        const msg = event.message as Record<string, unknown> | undefined;
        const usage_ = msg?.usage as Record<string, number> | undefined;
        if (usage_) {
          if (usage_.input_tokens) inputTokens += usage_.input_tokens;
          if (usage_.cache_creation_input_tokens) cacheCreationTokens += usage_.cache_creation_input_tokens;
          if (usage_.cache_read_input_tokens) cacheReadTokens += usage_.cache_read_input_tokens;
        }
        break;
      }

      case 'content_block_start': {
        const index = event.index as number;
        const block = event.content_block as Record<string, unknown>;
        _currentBlockIndex = index;
        blockAccumulators.set(index, {
          type: String(block?.type ?? 'text'),
          text: String(block?.text ?? ''),
          id: block?.id ? String(block.id) : undefined,
          name: block?.name ? String(block.name) : undefined,
          partialJson: '',
        });
        break;
      }

      case 'content_block_delta': {
        const index = event.index as number;
        const delta = event.delta as Record<string, unknown>;
        const acc = blockAccumulators.get(index);
        if (!acc) break;

        if (delta?.type === 'text_delta' && delta.text) {
          const text = String(delta.text);
          acc.text += text;
          onText?.(text);
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          const thinking = String(delta.thinking);
          acc.text += thinking;
          onThinking?.(thinking);
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          acc.partialJson += String(delta.partial_json);
        }
        break;
      }

      case 'content_block_stop': {
        const index = event.index as number;
        const acc = blockAccumulators.get(index);
        if (!acc) break;

        const block: ContentBlock = { type: acc.type as ContentBlock['type'] };

        if (acc.type === 'text') {
          block.text = acc.text;
        } else if (acc.type === 'thinking') {
          block.thinking = acc.text;
        } else if (acc.type === 'tool_use') {
          block.id = acc.id;
          block.name = acc.name;
          try {
            block.input = JSON.parse(
              acc.partialJson || '{}',
            ) as Record<string, unknown>;
          } catch {
            block.input = {};
          }
        }

        contentBlocks.push(block);
        blockAccumulators.delete(index);
        break;
      }

      case 'message_delta': {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) {
          stopReason = String(delta.stop_reason);
        }
        const usage_ = event.usage as Record<string, number> | undefined;
        if (usage_) {
          if (usage_.output_tokens) outputTokens += usage_.output_tokens;
          if (usage_.cache_creation_input_tokens) cacheCreationTokens += usage_.cache_creation_input_tokens;
          if (usage_.cache_read_input_tokens) cacheReadTokens += usage_.cache_read_input_tokens;
        }
        break;
      }

      case 'message_stop':
        break;

      // Ignore ping and other unknown event types
      default:
        break;
    }
  }

  return {
    contentBlocks,
    stopReason,
    usage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens },
  };
}

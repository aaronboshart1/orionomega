/**
 * @module agent/conversation
 * Conversational response handling — intent classification, tool use, and LLM interaction.
 *
 * Extracted from main-agent.ts for readability. This module handles everything
 * the main agent does when it's having a conversation (not orchestrating a workflow).
 */

import type { AnthropicClient, AnthropicMessage, AnthropicStreamEvent } from '../anthropic/client.js';
import { maxOutputTokensForModel } from '../anthropic/client.js';
import { createLogger } from '../logging/logger.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);
const log = createLogger('conversation');

// ── Intent Detection ────────────────────────────────────────────────────

/** Phrases that signal the user wants immediate execution (no planning step). */
/**
 * Patterns for immediate execution approval (e.g. "do it", "go ahead").
 * These must be SHORT confirmations, not task descriptions.
 * "build it" = approval, "build a CLI tool" = task description.
 */
export const IMMEDIATE_PATTERNS = [
  /^\s*(run\s*it|do\s*it|go\s*ahead|build\s*it|just\s*do\s*it|execute\s*it|ship\s*it|yes|yep|yeah|approved?|lgtm)\s*[.!]?\s*$/i,
];

const CONVERSATIONAL_FAST = [
  /^(hi|hello|hey|yo|sup|howdy|greetings)\b/i,
  /^(thanks|thank\s*you|cheers|ta)\b/i,
  /^(good\s*(morning|afternoon|evening|night))\b/i,
  /^who\s+are\s+you/i,
  /^how\s+are\s+you/i,
  /^help\b/i,
  /^(ok|okay|sure|alright|got\s*it|understood)\b/i,
  /^(yes|no|yep|nope|yeah|nah)\b/i,
  /^what\s+(is|are|does|do|was|were|can|could|would|should)\b/i,
  /^(why|when|where|how)\s+(is|are|does|do|did|was|were|can|could|would|should)\b/i,
  /^(tell\s+me|explain|describe|define|summarize|summarise)\b/i,
  /^(can|could|would)\s+you\s+(explain|tell|describe|help|clarify)\b/i,
  /^(what'?s|whats)\s/i,
  /^(nice|great|awesome|cool|perfect|wonderful|excellent|good\s*job)\b/i,
  /^(bye|goodbye|see\s+you|later|gotta\s+go|ttyl)\b/i,
  /^(sorry|my\s+bad|oops|whoops)\b/i,
  /^(never\s*mind|nvm|forget\s*it|cancel)\b/i,
];

/** Quick-match patterns that almost certainly need orchestration (multi-step). */
const ORCHESTRATE_FAST = [
  /\b(research|investigate|analyze|compare)\b.*\b(and|then|also|plus)\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bmulti[- ]?step\b/i,
  /\b(build|create|write|generate|implement|develop)\s+(a|an|the)\s+/i,
  /\b(refactor|rewrite|redesign|migrate|upgrade)\b/i,
  /\b(deploy|provision|set\s*up|configure|install)\b.*\b(on|to|for|in)\b/i,
  /\b(research|find|gather)\b.*\b(write|create|save|output|report)\b/i,
  /\b(fix|update|change|modify|patch|add|remove)\b.*\b(the|this|our|all|every|each)\b/i,
  /\b(implement|execute|run|do)\b.*\b(plan|tasks?|items?|steps?|list|checklist)\b/i,
  /\bwe\s+need\s+to\b.*\b(fix|change|update|implement|add|create|build)\b/i,
  /\b(fix|implement|add|create)\b.*\b(now|immediately|asap|today)\b/i,
  /\b(make|ensure)\b.*\b(work|function|run|pass|compile|build)\b/i,
];

/** Patterns for guarded (destructive/expensive) operations that require confirmation. */
const GUARDED_PATTERNS = [
  /\b(delete|remove|destroy|drop|purge|wipe)\b/i,
  /\b(deploy|publish|release|push\s+to\s+(prod|production|main|master))\b/i,
  /\b(merge|force[- ]push)\b/i,
  /\b(send\s+(email|message|notification))\b/i,
];

/** The LLM-based intent classification prompt (2-tier). */
const CLASSIFY_PROMPT = `You are an intent classifier for an AI orchestration system.
Given a user message, classify it as one of:
- CHAT: Conversational, simple questions, greetings, opinions, or answers the assistant can give directly without using tools. Examples: "what is 2+2?", "explain quantum computing", "tell me a joke", "what do you think about X?"
- CHAT_ASYNC: Single-step tasks that require tool use — file reads, command execution, quick lookups. Examples: "read config.yaml", "run npm test", "search for X in the codebase"
- ORCHESTRATE: Multi-step tasks requiring planning, multiple file changes, research-then-action, building features, fixing bugs across files, implementing plans, or any request that involves more than 2-3 tool calls in sequence. Examples: "fix the orchestration system", "implement the readiness plan", "build a landing page", "refactor the auth module", "we need to fix X and Y"

Bias: Prefer ORCHESTRATE for anything involving code changes across multiple files, bug fixes, feature implementation, or multi-step plans. Prefer CHAT_ASYNC for single-tool tasks. Only use CHAT when no tools are needed.

Respond with ONLY the word CHAT, CHAT_ASYNC, or ORCHESTRATE.`;
/** Tool definitions available to the main agent for conversational responses. */
export const MAIN_AGENT_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'exec',
    description: 'Execute a shell command and return stdout/stderr.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to write to' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
];

// ── Public Functions ─────────────────────────────────────────────────────

/** Check if a message signals immediate execution ("do it", "run it"). */
export function isImmediateExecution(content: string): boolean {
  return IMMEDIATE_PATTERNS.some((p) => p.test(content));
}

const TASKY_VERBS = /^(fix|add|build|create|refactor|deploy|implement|update|change|remove|delete|install|configure|set\s*up|write|generate|migrate|upgrade)\b/i;

export function isFastConversational(content: string): boolean {
  const trimmed = content.trim();
  const wordCount = trimmed.split(/\s+/).length;
  if (TASKY_VERBS.test(trimmed)) return false;
  if (ORCHESTRATE_FAST.some((p) => p.test(trimmed))) return false;
  if (wordCount <= 2 && CONVERSATIONAL_FAST.some((p) => p.test(trimmed))) return true;
  if (wordCount <= 12 && CONVERSATIONAL_FAST.some((p) => p.test(trimmed))) return true;
  if (wordCount <= 15 && !TASKY_VERBS.test(trimmed) && !ORCHESTRATE_FAST.some((p) => p.test(trimmed))) return true;
  return false;
}

/** Fast-path multi-step ORCHESTRATE check (no LLM needed). */
export function isOrchestrateRequest(content: string): boolean {
  return ORCHESTRATE_FAST.some((p) => p.test(content.trim()));
}

/** Check if a message involves guarded (destructive/expensive) operations. */
export function isGuardedRequest(content: string): boolean {
  return GUARDED_PATTERNS.some((p) => p.test(content.trim()));
}

/** @deprecated Use isOrchestrateRequest instead. */
export function isFastTask(content: string): boolean {
  return isOrchestrateRequest(content);
}

/** Intent type returned by the 2-tier classifier. */
export type IntentType = 'CHAT' | 'CHAT_ASYNC' | 'ORCHESTRATE';

export async function classifyIntent(
  client: AnthropicClient,
  model: string,
  message: string,
  cheapModel?: string,
): Promise<IntentType> {
  try {
    const response = await client.createMessage({
      model: cheapModel || model,
      system: CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: message }],
      maxTokens: 8,
      temperature: 0,
    });

    const text = response.content?.[0]?.text?.trim().toUpperCase() ?? 'CHAT';
    log.info('Intent classified', { message: message.slice(0, 80), intent: text });

    if (text.includes('ORCHESTRATE')) return 'ORCHESTRATE';
    if (text.includes('CHAT_ASYNC') || text.includes('ACTION') || text.includes('TASK')) return 'CHAT_ASYNC';
    return 'CHAT';
  } catch (err) {
    log.warn('Intent classification failed, defaulting to CHAT', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'CHAT';
  }
}

/** Execute a main-agent tool call. */
export async function executeMainTool(
  name: string,
  input: Record<string, unknown>,
  workspaceDir: string,
): Promise<string> {
  switch (name) {
    case 'read_file': {
      const filePath = String(input.path ?? '');
      const resolved = filePath.startsWith('/') ? filePath : `${workspaceDir}/${filePath}`;
      if (!existsSync(resolved)) return `Error: File not found: ${resolved}`;
      const data = await readFile(resolved, 'utf-8');
      if (data.length > 30_000) return data.slice(0, 30_000) + '\n... [truncated at 30KB]';
      return data;
    }
    case 'exec': {
      const command = String(input.command ?? '');
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workspaceDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            HOME: process.env.HOME || '/root',
            PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          },
        });
        let result = stdout || '';
        if (stderr) result += (result ? '\n' : '') + stderr;
        if (result.length > 30_000) return result.slice(0, 30_000) + '\n... [truncated]';
        return result || '(no output)';
      } catch (err: unknown) {
        const e = err as { message?: string; stdout?: string; stderr?: string };
        return `Error: ${e.message ?? String(err)}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
      }
    }
    case 'write_file': {
      const filePath = String(input.path ?? '');
      const fileContent = String(input.content ?? '');
      const resolved = filePath.startsWith('/') ? filePath : `${workspaceDir}/${filePath}`;
      const { mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(resolved), { recursive: true });
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(resolved, fileContent, 'utf-8');
      return `File written: ${resolved}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/** Extracts text delta from an Anthropic stream event. */
export function extractTextDelta(event: AnthropicStreamEvent): string | null {
  if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text;
    }
  }
  return null;
}

// ── Tool Failure Circuit Breaker ────────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Generate a normalised signature for a tool call to detect repeated failures.
 * For exec: uses the first 200 chars of the command (strips variable whitespace).
 * For read_file/write_file: uses the path.
 * Catches the pattern of retrying the same failing command with minor variations.
 */
function toolSignature(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'exec': {
      // Normalise: collapse whitespace, trim, take first 200 chars
      const cmd = String(input.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return `exec:${cmd}`;
    }
    case 'read_file':
      return `read:${String(input.path ?? '')}`;
    case 'write_file':
      return `write:${String(input.path ?? '')}`;
    default:
      return `${name}:${JSON.stringify(input).slice(0, 200)}`;
  }
}

/**
 * Broader similarity check — groups tool calls that share a common pattern.
 * For exec: extracts the "core command" (first recognisable binary or keyword).
 * This catches the case where the agent retries with slightly different flags/args.
 */
function toolCategory(name: string, input: Record<string, unknown>): string {
  if (name === 'exec') {
    const cmd = String(input.command ?? '').trim();
    // Extract the first meaningful command (skip env vars, sudo, etc.)
    const match = cmd.match(/(?:sudo\s+)?(?:sshpass\s+\S+\s+)?(\w[\w.-]*)/);
    return `exec:${match?.[1] ?? 'unknown'}`;
  }
  return name;
}

/**
 * Streams a conversational response, supporting multi-round tool use.
 *
 * This is the core conversation loop: stream response → if tool_use, execute tools →
 * feed results back → stream next response → repeat until end_turn.
 */
export async function streamConversation(opts: {
  client: AnthropicClient;
  model: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  workspaceDir: string;
  onText: (text: string, streaming: boolean, done: boolean) => void;
  onThinking?: (text: string, streaming: boolean, done: boolean) => void;
  maxToolRounds?: number;
  maxInputTokens?: number;
}): Promise<{ text: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }> {
  const { client, model, systemPrompt, workspaceDir, onText, onThinking } = opts;
  let messages = [...opts.messages];

  if (opts.maxInputTokens && messages.length > 2) {
    let totalEstimate = Math.ceil(systemPrompt.length / 4);
    for (const m of messages) {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      totalEstimate += Math.ceil(text.length / 4);
    }
    while (totalEstimate > opts.maxInputTokens && messages.length > 2) {
      if (messages[0].role === 'user' && messages.length > 2 && messages[1].role === 'assistant') {
        const r1 = messages.shift()!;
        const r2 = messages.shift()!;
        const t1 = typeof r1.content === 'string' ? r1.content : JSON.stringify(r1.content);
        const t2 = typeof r2.content === 'string' ? r2.content : JSON.stringify(r2.content);
        totalEstimate -= Math.ceil(t1.length / 4) + Math.ceil(t2.length / 4);
        log.info('Token budget: trimmed user+assistant pair', { remaining: messages.length, estimatedTokens: totalEstimate });
      } else {
        const removed = messages.shift()!;
        const removedText = typeof removed.content === 'string' ? removed.content : JSON.stringify(removed.content);
        totalEstimate -= Math.ceil(removedText.length / 4);
        log.info('Token budget: trimmed oldest message', { remaining: messages.length, estimatedTokens: totalEstimate });
      }
    }
  }
  let fullText = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  // Model-aware output token limit (prevents unnecessary truncation)
  const maxTokens = maxOutputTokensForModel(model);
  // Maximum auto-continuation rounds when the model hits the token limit
  const MAX_CONTINUATIONS = 3;
  let continuationCount = 0;

  // Circuit breaker: track consecutive failures by signature and category
  const failuresBySignature = new Map<string, number>();
  const failuresByCategory = new Map<string, number>();
  const trippedCategories = new Set<string>();

  log.verbose('Starting conversation stream', {
    model,
    messageCount: messages.length,
    systemPromptLength: systemPrompt.length,
    maxTokens,
  });

  for (let round = 0; ; round++) {
    const roundStart = Date.now();
    if (round > 0) {
      onThinking?.(`Thinking… (round ${round + 1})`, true, false);
    }
    log.verbose(`Conversation round ${round + 1}`, {
      messageCount: messages.length,
    });

    const stream = client.streamMessage({
      model,
      system: systemPrompt,
      messages,
      maxTokens,
      temperature: 0.7,
      tools: MAIN_AGENT_TOOLS,
    });

    let roundText = '';
    let stopReason = '';
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';

    for await (const event of stream) {
      const text = extractTextDelta(event);
      if (text) {
        roundText += text;
        fullText += text;
        onText(text, true, false);
      }

      if (event.type === 'content_block_start') {
        const block = (event as Record<string, unknown>).content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          currentToolId = String(block.id ?? '');
          currentToolName = String(block.name ?? '');
          currentToolInput = '';
        }
      }

      if (event.type === 'content_block_delta') {
        const delta = (event as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          currentToolInput += delta.partial_json;
        }
      }

      if (event.type === 'content_block_stop' && currentToolId) {
        try {
          const input = JSON.parse(currentToolInput || '{}');
          toolCalls.push({ id: currentToolId, name: currentToolName, input });
        } catch {
          toolCalls.push({ id: currentToolId, name: currentToolName, input: {} });
        }
        currentToolId = '';
        currentToolName = '';
        currentToolInput = '';
      }

      if (event.type === "message_start") {
        const msg = (event as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, number> | undefined;
        if (usage) {
          if (usage.input_tokens) totalInputTokens += usage.input_tokens;
          if (usage.cache_creation_input_tokens) totalCacheCreationTokens += usage.cache_creation_input_tokens;
          if (usage.cache_read_input_tokens) totalCacheReadTokens += usage.cache_read_input_tokens;
        }
      }
      if (event.type === 'message_delta') {
        const delta = (event as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) stopReason = String(delta.stop_reason);
        const usage = delta?.usage as Record<string, number> | undefined;
        if (usage?.output_tokens) totalOutputTokens += usage.output_tokens;
      }
    }

    const roundDuration = Date.now() - roundStart;
    log.verbose(`Round ${round + 1} complete`, {
      durationMs: roundDuration,
      stopReason,
      textLength: roundText.length,
      toolCallCount: toolCalls.length,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    });

    // Auto-continuation: if the model hit the output token limit mid-response,
    // append what we have so far and ask it to continue (up to MAX_CONTINUATIONS).
    if (stopReason === 'max_tokens' && toolCalls.length === 0 && continuationCount < MAX_CONTINUATIONS) {
      continuationCount++;
      log.verbose(`Output hit max_tokens — auto-continuing (${continuationCount}/${MAX_CONTINUATIONS})`);

      // Append the partial assistant response and ask to continue
      messages = [
        ...messages,
        { role: 'assistant', content: roundText },
        { role: 'user', content: 'Continue where you left off.' },
      ];
      continue;
    }

    if (stopReason !== 'tool_use' || toolCalls.length === 0) {
      log.verbose('Conversation complete', {
        totalRounds: round + 1,
        totalInputTokens,
        totalOutputTokens,
        responseLength: fullText.length,
        continuations: continuationCount,
      });
      onThinking?.('', false, true);
      onText('', true, true);
      return { text: fullText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheCreationTokens: totalCacheCreationTokens, cacheReadTokens: totalCacheReadTokens };
    }

    // Execute tools and continue
    const assistantContent: unknown[] = [];
    if (roundText) assistantContent.push({ type: 'text', text: roundText });
    for (const tc of toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    messages = [...messages, { role: 'assistant', content: assistantContent as unknown as string }];

    const toolResults: unknown[] = [];
    for (const tc of toolCalls) {
      const sig = toolSignature(tc.name, tc.input);
      const cat = toolCategory(tc.name, tc.input);

      // Check if this tool category has been tripped
      if (trippedCategories.has(cat)) {
        const msg = `[CIRCUIT BREAKER] This type of ${tc.name} call has failed ${MAX_CONSECUTIVE_FAILURES} times consecutively. `
          + `Stop retrying and inform the user what went wrong. Do NOT attempt this operation again. `
          + `Explain the error and suggest the user try it manually or provide different instructions.`;
        log.warn('Circuit breaker: category tripped, blocking tool call', { name: tc.name, category: cat, signature: sig });
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: msg });
        continue;
      }

      // Emit thinking event so the TUI spinner shows activity
      const toolSummary = tc.name === 'exec'
        ? `Running: ${String(tc.input.command ?? '').slice(0, 80)}`
        : tc.name === 'read_file'
          ? `Reading: ${String(tc.input.path ?? '')}`
          : tc.name === 'write_file'
            ? `Writing: ${String(tc.input.path ?? '')}`
            : `Tool: ${tc.name}`;
      onThinking?.(toolSummary, true, false);

      const toolStart = Date.now();
      log.verbose(`Tool call: ${tc.name}`, { input: tc.input });
      const result = await executeMainTool(tc.name, tc.input, workspaceDir);
      const toolDuration = Date.now() - toolStart;
      log.verbose(`Tool result: ${tc.name}`, {
        durationMs: toolDuration,
        resultLength: result.length,
        resultPreview: result.slice(0, 300),
      });

      // Track failures
      const isError = result.startsWith('Error:');
      if (isError) {
        const sigCount = (failuresBySignature.get(sig) ?? 0) + 1;
        const catCount = (failuresByCategory.get(cat) ?? 0) + 1;
        failuresBySignature.set(sig, sigCount);
        failuresByCategory.set(cat, catCount);

        if (sigCount >= MAX_CONSECUTIVE_FAILURES || catCount >= MAX_CONSECUTIVE_FAILURES) {
          trippedCategories.add(cat);
          const breakerMsg = `${result}\n\n[CIRCUIT BREAKER] This operation has failed ${Math.max(sigCount, catCount)} times. `
            + `Do NOT retry. Inform the user what went wrong and ask for guidance. `
            + `Repeated identical failures waste context and tokens.`;
          log.warn('Circuit breaker tripped', {
            name: tc.name,
            category: cat,
            signature: sig,
            sigFailures: sigCount,
            catFailures: catCount,
          });
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: breakerMsg });
          continue;
        }
      } else {
        // Success — reset counters for this signature and category
        failuresBySignature.delete(sig);
        if (failuresByCategory.has(cat)) {
          failuresByCategory.set(cat, Math.max(0, (failuresByCategory.get(cat) ?? 0) - 1));
        }
      }

      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
    }
    messages = [...messages, { role: 'user', content: toolResults as unknown as string }];
  }

  onText('', true, true);
  return { text: fullText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheCreationTokens: totalCacheCreationTokens, cacheReadTokens: totalCacheReadTokens };
}

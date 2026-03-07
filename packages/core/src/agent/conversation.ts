/**
 * @module agent/conversation
 * Conversational response handling — intent classification, tool use, and LLM interaction.
 *
 * Extracted from main-agent.ts for readability. This module handles everything
 * the main agent does when it's having a conversation (not orchestrating a workflow).
 */

import type { AnthropicClient, AnthropicMessage, AnthropicStreamEvent } from '../anthropic/client.js';
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

/** Quick-match conversational patterns (no LLM call needed). */
const CONVERSATIONAL_FAST = [
  /^(hi|hello|hey|yo|sup|howdy|greetings)\b/i,
  /^(thanks|thank\s*you|cheers|ta)\b/i,
  /^(good\s*(morning|afternoon|evening|night))\b/i,
  /^who\s+are\s+you/i,
  /^how\s+are\s+you/i,
  /^help\b/i,
  /^(ok|okay|sure|alright|got\s*it|understood)\b/i,
  /^(yes|no|yep|nope|yeah|nah)\b/i,
];

/** Quick-match patterns that almost certainly need orchestration. */
const TASK_FAST = [
  /\b(research|investigate|analyze|compare|build|create|write|generate|deploy|set\s*up|install|configure)\b.*\b(and|then|also|plus|save|output|file)\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bmulti[- ]?step\b/i,
];

/** The LLM-based intent classification prompt. */
const CLASSIFY_PROMPT = `You are an intent classifier for an AI orchestration system.
Given a user message, classify it as one of:
- CHAT: Conversational, simple questions, greetings, opinions, single-step answers the assistant can give directly. Examples: "what is 2+2?", "explain quantum computing", "what's the weather?", "tell me a joke", "what do you think about X?"
- TASK: Multi-step work requiring research, file operations, code generation, comparisons, or coordinated effort. Examples: "research X and write a report", "build a landing page", "compare A, B, and C with benchmarks", "deploy X to production"

Bias: When in doubt, prefer CHAT. Only classify as TASK when the request clearly needs multiple coordinated steps, external research, file creation, or multi-agent work.

Respond with ONLY the word CHAT or TASK.`;

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

/** Fast-path conversational check (no LLM needed). */
export function isFastConversational(content: string): boolean {
  const trimmed = content.trim();
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 3 && CONVERSATIONAL_FAST.some((p) => p.test(trimmed))) return true;
  if (wordCount <= 8 && CONVERSATIONAL_FAST.some((p) => p.test(trimmed))) return true;
  return false;
}

/** Fast-path task check (no LLM needed). */
export function isFastTask(content: string): boolean {
  return TASK_FAST.some((p) => p.test(content.trim()));
}

/** LLM-based intent classification for ambiguous messages. */
export async function classifyIntent(
  client: AnthropicClient,
  model: string,
  message: string,
): Promise<'CHAT' | 'TASK'> {
  try {
    const response = await client.createMessage({
      model,
      system: CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: message }],
      maxTokens: 8,
      temperature: 0,
    });

    const text = response.content?.[0]?.text?.trim().toUpperCase() ?? 'CHAT';
    log.info('Intent classified', { message: message.slice(0, 80), intent: text });

    if (text.includes('TASK')) return 'TASK';
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
  maxToolRounds?: number;
}): Promise<string> {
  const { client, model, systemPrompt, workspaceDir, onText, maxToolRounds = 10 } = opts;
  let messages = [...opts.messages];
  let fullText = '';

  for (let round = 0; round <= maxToolRounds; round++) {
    const stream = client.streamMessage({
      model,
      system: systemPrompt,
      messages,
      maxTokens: 4096,
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

      if (event.type === 'message_delta') {
        const delta = (event as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) stopReason = String(delta.stop_reason);
      }
    }

    if (stopReason !== 'tool_use' || toolCalls.length === 0) {
      onText('', true, true);
      return fullText;
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
      log.info('Main agent tool call', { tool: tc.name, input: tc.input });
      const result = await executeMainTool(tc.name, tc.input, workspaceDir);
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
    }
    messages = [...messages, { role: 'user', content: toolResults as unknown as string }];
  }

  onText('', true, true);
  return fullText;
}

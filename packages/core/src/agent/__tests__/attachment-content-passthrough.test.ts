/**
 * @module agent/__tests__/attachment-content-passthrough
 *
 * Task #182: Web UI sends image/PDF attachments as base64 DataURLs in the
 * `data` field. Pre-fix, MainAgent.handleMessage discarded `data` and only
 * appended a "[Attached image: …]" filename to the text prompt — so the
 * model never saw the bytes. Post-fix, image / document attachments are
 * converted into Anthropic multimodal content blocks (text + image +
 * document with base64 source), threaded through HistoryEntry as
 * `string | ContentBlock[]`, and survive all the way to the Anthropic
 * streamMessage call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MainAgent, type MainAgentCallbacks, type MainAgentConfig } from '../main-agent.js';
import type { ContentBlock } from '../../anthropic/client.js';

let workspaceDir: string;
let agent: MainAgent;
let textCalls: string[];

const collectingCallbacks = (): MainAgentCallbacks => {
  textCalls = [];
  return {
    onText: (msg) => { textCalls.push(msg); },
    onThinking: () => {},
    onPlan: () => {},
    onEvent: () => {},
    onGraphState: () => {},
    onCommandResult: () => {},
  };
};

function buildAgent(): MainAgent {
  const config: MainAgentConfig = {
    model: 'claude-test',
    apiKey: 'test-key',
    systemPrompt: 'TEST_BASE_PROMPT',
    workspaceDir,
    checkpointDir: path.join(workspaceDir, 'checkpoints'),
    workerTimeout: 1000,
    maxRetries: 0,
  };
  return new MainAgent(config, collectingCallbacks());
}

interface CapturedCall {
  messages: { role: string; content: unknown }[];
}

function stubAnthropicAndCaptureMessages(a: MainAgent): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fake = {
    async *streamMessage(opts: { messages: { role: string; content: unknown }[] }) {
      calls.push({ messages: JSON.parse(JSON.stringify(opts.messages)) });
      yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 1 } } };
      yield { type: 'message_stop' };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).anthropic = fake;
  return { calls };
}

function stubOrchestration(a: MainAgent): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).orchestration = {
    hasPendingGates: false,
    hasPendingConfirmations: false,
    hasPendingPlans: false,
    latestPendingPlanId: null,
    isWorkflowActive: () => false,
    listPendingGates: () => [],
    stopAll: () => {},
  };
}

/**
 * The user-message Anthropic call is the FIRST entry whose role is 'user'
 * and whose content is an array (i.e. the multimodal turn). The hot
 * window may emit synthetic prior-context user/assistant pairs first
 * (string content), so we filter those out.
 */
function findMultimodalUserMessage(call: CapturedCall): { role: string; content: ContentBlock[] } | null {
  for (const m of call.messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      return m as { role: string; content: ContentBlock[] };
    }
  }
  return null;
}

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TINY_PDF_B64 = 'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoK';

let prevConfigPath: string | undefined;
beforeEach(() => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'oo-attach-'));
  // Pin CONFIG_PATH inside the per-test workspaceDir so the hot-window
  // persistence file (`<configDir>/sessions/hot-window-<sid>.json`) is
  // isolated per test. Otherwise tests for the same sessionId ('s1')
  // would share `~/.orionomega/sessions/hot-window-s1.json` and one
  // test's pushed messages would leak into the next test's hot window.
  prevConfigPath = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = path.join(workspaceDir, 'config.yaml');
  agent = buildAgent();
});
afterEach(() => {
  if (prevConfigPath === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = prevConfigPath;
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe('attachment content passthrough (Task #182)', () => {
  it('passes a PNG image attachment through as an Anthropic image content block', async () => {
    const { calls } = stubAnthropicAndCaptureMessages(agent);
    stubOrchestration(agent);

    await agent.handleMessage(
      's1',
      'what is in this picture?',
      undefined,
      [{ name: 'pic.png', size: 100, type: 'image/png', data: `data:image/png;base64,${TINY_PNG_B64}` }],
      'direct',
    );

    expect(calls).toHaveLength(1);
    const userMsg = findMultimodalUserMessage(calls[0]!);
    expect(userMsg).not.toBeNull();
    const blocks = userMsg!.content;

    const text = blocks.find((b) => b.type === 'text');
    const image = blocks.find((b) => b.type === 'image');
    expect(text?.text).toContain('what is in this picture?');
    expect(text?.text).toContain('[Attached image: pic.png');
    expect(image).toBeDefined();
    expect(image!.source).toEqual({ type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 });
  });

  it('passes a PDF attachment through as an Anthropic document content block', async () => {
    const { calls } = stubAnthropicAndCaptureMessages(agent);
    stubOrchestration(agent);

    await agent.handleMessage(
      's1',
      'summarise this PDF',
      undefined,
      [{ name: 'doc.pdf', size: 200, type: 'application/pdf', data: `data:application/pdf;base64,${TINY_PDF_B64}` }],
      'direct',
    );

    const userMsg = findMultimodalUserMessage(calls[0]!);
    expect(userMsg).not.toBeNull();
    const doc = userMsg!.content.find((b) => b.type === 'document');
    expect(doc).toBeDefined();
    expect(doc!.source).toEqual({ type: 'base64', media_type: 'application/pdf', data: TINY_PDF_B64 });
  });

  it('inlines text attachments into the text prompt and emits no media blocks', async () => {
    const { calls } = stubAnthropicAndCaptureMessages(agent);
    stubOrchestration(agent);

    await agent.handleMessage(
      's1',
      'review this code',
      undefined,
      [{ name: 'snippet.ts', size: 17, type: 'text/x-typescript', textContent: 'const x = 1;\n' }],
      'direct',
    );

    // Pure-text turns keep the historical string-content shape, so there
    // is no multimodal user message in the call.
    const multimodal = findMultimodalUserMessage(calls[0]!);
    expect(multimodal).toBeNull();
    const stringUser = calls[0]!.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && (m.content as string).includes('review this code'),
    );
    expect(stringUser).toBeDefined();
    expect(stringUser!.content as string).toContain('--- Attached file: snippet.ts');
    expect(stringUser!.content as string).toContain('const x = 1;');
  });

  it('handles a mixed image + text attachment turn', async () => {
    const { calls } = stubAnthropicAndCaptureMessages(agent);
    stubOrchestration(agent);

    await agent.handleMessage(
      's1',
      'compare',
      undefined,
      [
        { name: 'pic.png', size: 50, type: 'image/png', data: `data:image/png;base64,${TINY_PNG_B64}` },
        { name: 'notes.txt', size: 10, type: 'text/plain', textContent: 'hello world' },
      ],
      'direct',
    );

    const userMsg = findMultimodalUserMessage(calls[0]!);
    expect(userMsg).not.toBeNull();
    const text = userMsg!.content.find((b) => b.type === 'text');
    const image = userMsg!.content.find((b) => b.type === 'image');
    expect(image).toBeDefined();
    expect(text?.text).toContain('compare');
    expect(text?.text).toContain('--- Attached file: notes.txt');
    expect(text?.text).toContain('hello world');
    expect(text?.text).toContain('[Attached image: pic.png');
  });

  it('fails loudly (warns the user, drops the file) when a binary attachment has no `data`', async () => {
    const { calls } = stubAnthropicAndCaptureMessages(agent);
    stubOrchestration(agent);

    await agent.handleMessage(
      's1',
      'broken upload',
      undefined,
      [{ name: 'pic.png', size: 100, type: 'image/png' /* no data, no textContent */ }],
      'direct',
    );

    // The user-facing warning was surfaced via onText.
    expect(textCalls.some((t) => t.includes('has no inline content'))).toBe(true);
    // No image block was synthesised — the turn went out as plain text.
    const multimodal = findMultimodalUserMessage(calls[0]!);
    expect(multimodal).toBeNull();
  });

  it('strips the `data:<mime>;base64,` DataURL prefix and accepts a bare base64 payload', async () => {
    const { calls } = stubAnthropicAndCaptureMessages(agent);
    stubOrchestration(agent);

    await agent.handleMessage(
      's1',
      'two images',
      undefined,
      [
        { name: 'a.png', size: 50, type: 'image/png', data: `data:image/png;base64,${TINY_PNG_B64}` },
        { name: 'b.png', size: 50, type: 'image/png', data: TINY_PNG_B64 },
      ],
      'direct',
    );

    const userMsg = findMultimodalUserMessage(calls[0]!);
    expect(userMsg).not.toBeNull();
    const images = userMsg!.content.filter((b) => b.type === 'image');
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.source?.data).toBe(TINY_PNG_B64);
      expect(img.source?.data.startsWith('data:')).toBe(false);
    }
  });
});

/**
 * Task #221: direct-mode "intent without action" stall recovery.
 *
 * Reproduces the bug where the model narrates "I'll write the spec now",
 * ends its turn with no tool call, and the promised file never appears.
 * `streamConversation` should detect this (end_turn + zero tool calls +
 * imminent-write intent + the user actually asked for a deliverable) and
 * inject a corrective user message, capped at MAX_STALL_RECOVERIES (2).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { streamConversation } from '../conversation.js';
import type { AnthropicMessage } from '../../anthropic/client.js';

/**
 * Fake client whose every round yields an intent line and ends with
 * end_turn and NO tool calls — i.e. it always stalls. Records the
 * `messages` array it received for each round so we can assert that the
 * corrective prompt was injected.
 */
function makeStallingClient() {
  const receivedMessages: AnthropicMessage[][] = [];
  const client = {
    streamMessage(opts: { messages: AnthropicMessage[] }) {
      receivedMessages.push(opts.messages.map((m) => ({ ...m })));
      return (async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: "I'll write the spec now." } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 1 } } };
        yield { type: 'message_stop' };
      })();
    },
  };
  return { client, receivedMessages };
}

function correctiveCount(messages: AnthropicMessage[]): number {
  return messages.filter(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('never called `write_file`'),
  ).length;
}

describe('Task #221: streamConversation stall recovery', () => {
  let workspaceDir: string;
  beforeAll(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), 'oo-stall-'));
  });
  afterAll(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('injects a corrective prompt up to the cap when the user asked for a deliverable', async () => {
    const { client, receivedMessages } = makeStallingClient();
    await streamConversation({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      model: 'claude-test',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Write the spec for the data room feature.' }],
      workspaceDir,
      onText: () => {},
    });
    // round0 stall → recover(1); round1 stall → recover(2); round2 cap hit → stop.
    expect(receivedMessages.length).toBe(3);
    // The final round's message list should contain exactly 2 corrective msgs.
    expect(correctiveCount(receivedMessages[receivedMessages.length - 1])).toBe(2);
  });

  it('does NOT recover when the user did not ask for a written deliverable', async () => {
    const { client, receivedMessages } = makeStallingClient();
    await streamConversation({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      model: 'claude-test',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Tell me a joke about cats.' }],
      workspaceDir,
      onText: () => {},
    });
    // No deliverable implied → single round, no corrective injection.
    expect(receivedMessages.length).toBe(1);
    expect(correctiveCount(receivedMessages[0])).toBe(0);
  });
});

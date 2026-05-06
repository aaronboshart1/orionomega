/**
 * @module agent/__tests__/conversation-skill-tools
 *
 * Direct-loop integration tests for `streamConversation` with the new
 * `skillTools` option:
 *
 *  (b) advertises `MAIN_AGENT_TOOLS + skillTools` to the model
 *  (c) routes a tool call whose name matches a `skillTools` entry through
 *      `SkillExecutor` (not `executeMainTool`) and returns the handler's
 *      stdout to the loop
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { streamConversation, MAIN_AGENT_TOOLS } from '../conversation.js';
import {
  buildSkillToolset,
  SKILL_TOOL_NAMESPACE_SEPARATOR,
} from '../skill-tools.js';
import type { AnthropicClient } from '../../anthropic/client.js';

let skillsDir: string;

function setupSkill(name: string, toolName: string, handlerBody: string): void {
  const dir = path.join(skillsDir, name);
  mkdirSync(path.join(dir, 'handlers'), { recursive: true });
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '0.1.0',
      description: `${name} test skill`,
      author: 'test',
      license: 'MIT',
      orionomega: '>=0.1.0',
      requires: { commands: [], skills: [], env: [] },
      triggers: { keywords: [], commands: [] },
      tools: [
        {
          name: toolName,
          description: `${toolName} tool`,
          handler: `handlers/${toolName}.mjs`,
          timeout: 5000,
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
          },
        },
      ],
    }),
  );
  const handlerPath = path.join(dir, 'handlers', `${toolName}.mjs`);
  writeFileSync(handlerPath, handlerBody);
  chmodSync(handlerPath, 0o755);
}

/** Build a fake AnthropicClient whose `streamMessage` yields scripted SSE events. */
function fakeClient(scripts: AnthropicStreamEvent[][]): {
  client: AnthropicClient;
  toolsSeen: unknown[];
  callCount: () => number;
} {
  const toolsSeen: unknown[] = [];
  let i = 0;
  const client = {
    async *streamMessage(opts: { tools?: unknown[] }) {
      toolsSeen.push(opts.tools);
      const script = scripts[i++] ?? [];
      for (const ev of script) yield ev;
    },
  } as unknown as AnthropicClient;
  return { client, toolsSeen, callCount: () => i };
}

type AnthropicStreamEvent = Record<string, unknown>;

function toolUseTurn(id: string, name: string, input: Record<string, unknown>): AnthropicStreamEvent[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', usage: { output_tokens: 5 } } },
    { type: 'message_stop' },
  ];
}

function endTurn(text: string): AnthropicStreamEvent[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 3 } } },
    { type: 'message_stop' },
  ];
}

beforeEach(() => {
  skillsDir = mkdtempSync(path.join(tmpdir(), 'oo-conv-skill-tools-'));
});
afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
});

describe('streamConversation with skillTools', () => {
  it('(b) advertises base + skill tools to the model', async () => {
    setupSkill(
      'mailer',
      'send',
      `#!/usr/bin/env node\nprocess.stdout.write('ok');\n`,
    );
    const { tools: skillTools } = await buildSkillToolset(['mailer'], skillsDir);
    expect(skillTools).toHaveLength(1);

    const { client, toolsSeen } = fakeClient([endTurn('hi')]);
    await streamConversation({
      client,
      model: 'claude-test',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      workspaceDir: skillsDir,
      skillTools,
      onText: () => {},
    });

    expect(toolsSeen).toHaveLength(1);
    const advertised = toolsSeen[0] as Array<{ name: string }>;
    const names = advertised.map((t) => t.name);
    for (const base of MAIN_AGENT_TOOLS) {
      expect(names).toContain(base.name);
    }
    expect(names).toContain(`mailer${SKILL_TOOL_NAMESPACE_SEPARATOR}send`);
  });

  it('(c) routes a namespaced tool call to SkillExecutor and returns handler output', async () => {
    setupSkill(
      'mailer',
      'send',
      `#!/usr/bin/env node
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  const args = JSON.parse(buf);
  process.stdout.write(JSON.stringify({ delivered: true, to: args.msg }));
});
`,
    );
    const { tools: skillTools } = await buildSkillToolset(['mailer'], skillsDir);
    const nsName = `mailer${SKILL_TOOL_NAMESPACE_SEPARATOR}send`;

    const { client } = fakeClient([
      toolUseTurn('toolu_1', nsName, { msg: 'inbox@example.com' }),
      endTurn('done'),
    ]);

    const toolEnds: Array<{ name: string; result: string; isError: boolean }> = [];
    const result = await streamConversation({
      client,
      model: 'claude-test',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'send mail' }],
      workspaceDir: skillsDir,
      skillTools,
      onText: () => {},
      onToolEnd: (info) => toolEnds.push({ name: info.name, result: info.result, isError: info.isError }),
    });

    expect(result.text).toBe('done');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]!.name).toBe(nsName);
    expect(toolEnds[0]!.isError).toBe(false);
    // Handler stdout was JSON — executeSkillToolEntry passes strings through
    // verbatim, so the model sees the raw delivered/to payload.
    expect(toolEnds[0]!.result).toMatch(/"delivered":\s*true/);
    expect(toolEnds[0]!.result).toContain('inbox@example.com');
  });
});

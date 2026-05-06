/**
 * @module agent/__tests__/skill-tools
 *
 * Unit tests for the shared skill-tool builder used by both the orchestration
 * worker MCP path and the direct-chat tool surface.
 *
 * Coverage:
 *  (a) builds entries for an enabled manifest skill, namespaced as
 *      `<skillId>__<toolName>`
 *  (b) skips disabled skills with a failure record
 *  (c) skips broken/missing skills without poisoning siblings
 *  (d) drops duplicate namespaced names rather than throwing
 *  (e) executeSkillToolEntry returns "Error: ..." when the handler throws
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSkillToolset,
  executeSkillToolEntry,
  SKILL_TOOL_NAMESPACE_SEPARATOR,
  type SkillToolEntry,
} from '../skill-tools.js';

let skillsDir: string;

function writeManifest(skillName: string, manifest: Record<string, unknown>): string {
  const dir = path.join(skillsDir, skillName);
  mkdirSync(path.join(dir, 'handlers'), { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function writeHandler(skillName: string, handlerRel: string, body: string): void {
  const full = path.join(skillsDir, skillName, handlerRel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function baseManifest(name: string, toolName = 'echo'): Record<string, unknown> {
  return {
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
  };
}

beforeEach(() => {
  skillsDir = mkdtempSync(path.join(tmpdir(), 'oo-skill-tools-'));
});

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
});

describe('buildSkillToolset', () => {
  it('(a) builds a namespaced entry for an enabled manifest skill', async () => {
    writeManifest('alpha', baseManifest('alpha', 'gmail'));
    writeHandler(
      'alpha',
      'handlers/gmail.mjs',
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true }));\n`,
    );

    const { tools, failures } = await buildSkillToolset(['alpha'], skillsDir);

    expect(failures).toEqual([]);
    expect(tools).toHaveLength(1);
    const entry = tools[0]!;
    expect(entry.name).toBe(`alpha${SKILL_TOOL_NAMESPACE_SEPARATOR}gmail`);
    expect(entry.rawName).toBe('gmail');
    expect(entry.skillId).toBe('alpha');
    expect(entry.handlerPath.endsWith('handlers/gmail.mjs')).toBe(true);
    expect(entry.cwd).toBe(path.join(skillsDir, 'alpha'));
    expect(entry.timeout).toBe(5000);
    expect(entry.inputSchema).toMatchObject({ type: 'object' });
  });

  it('(b) skips disabled skills with a failure record', async () => {
    writeManifest('beta', baseManifest('beta'));
    writeHandler('beta', 'handlers/echo.mjs', `process.stdout.write('{}');\n`);
    writeFileSync(
      path.join(skillsDir, 'beta', 'config.json'),
      JSON.stringify({ enabled: false, configured: true, fields: {} }),
    );

    const { tools, failures } = await buildSkillToolset(['beta'], skillsDir);

    expect(tools).toEqual([]);
    expect(failures).toEqual([{ skillId: 'beta', reason: 'disabled' }]);
  });

  it('(c) a broken skill does not poison sibling skills', async () => {
    // gamma is missing entirely → load() throws
    writeManifest('delta', baseManifest('delta', 'send'));
    writeHandler('delta', 'handlers/send.mjs', `process.stdout.write('{}');\n`);

    const { tools, failures } = await buildSkillToolset(
      ['gamma', 'delta'],
      skillsDir,
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe(`delta${SKILL_TOOL_NAMESPACE_SEPARATOR}send`);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.skillId).toBe('gamma');
    expect(failures[0]!.reason).toMatch(/Failed to load|ENOENT|not found/i);
  });

  it('(d2) two skills with the same raw tool name both survive via namespacing', async () => {
    writeManifest('alpha', baseManifest('alpha', 'send'));
    writeHandler('alpha', 'handlers/send.mjs', `process.stdout.write('a');\n`);
    writeManifest('beta', baseManifest('beta', 'send'));
    writeHandler('beta', 'handlers/send.mjs', `process.stdout.write('b');\n`);

    const { tools } = await buildSkillToolset(['alpha', 'beta'], skillsDir);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      `alpha${SKILL_TOOL_NAMESPACE_SEPARATOR}send`,
      `beta${SKILL_TOOL_NAMESPACE_SEPARATOR}send`,
    ]);
  });

  it('(d) drops duplicate namespaced tool names without throwing', async () => {
    // Two manifest tools with the same name within one skill — second
    // is dropped. Anthropic would otherwise reject the request.
    const m = baseManifest('eps', 'dup');
    (m.tools as Array<Record<string, unknown>>).push({
      name: 'dup',
      description: 'dup again',
      handler: 'handlers/dup.mjs',
      inputSchema: { type: 'object', properties: {} },
    });
    writeManifest('eps', m);
    writeHandler('eps', 'handlers/dup.mjs', `process.stdout.write('{}');\n`);

    const { tools } = await buildSkillToolset(['eps'], skillsDir);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe(`eps${SKILL_TOOL_NAMESPACE_SEPARATOR}dup`);
  });
});

describe('executeSkillToolEntry', () => {
  it('(e) returns "Error: ..." when the handler script is missing', async () => {
    const entry: SkillToolEntry = {
      name: 'phi__missing',
      rawName: 'missing',
      skillId: 'phi',
      description: 'missing',
      inputSchema: { type: 'object' },
      handlerPath: path.join(skillsDir, 'phi', 'handlers', 'nope.mjs'),
      cwd: skillsDir,
      env: {},
      timeout: 1000,
    };

    const out = await executeSkillToolEntry(entry, { msg: 'hi' });
    expect(out.startsWith('Error:')).toBe(true);
  });
});

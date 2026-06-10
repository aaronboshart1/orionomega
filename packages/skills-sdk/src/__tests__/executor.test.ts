/**
 * @module __tests__/executor
 * Unit tests for SkillExecutor — the security guards and the
 * JSON-over-stdin/stdout handler contract.
 *
 * Each test writes a tiny throwaway handler script into a temp "skill
 * directory" and invokes it via SkillExecutor, so the stdin/stdout
 * contract and the sandbox guards are exercised end-to-end without any
 * mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillExecutor } from '../executor.js';

let skillDir: string;
const executor = new SkillExecutor();

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'skill-exec-test-'));
});

afterEach(() => {
  try { rmSync(skillDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Write an executable Node handler that runs `body` (which has `params` in scope). */
function writeHandler(relPath: string, body: string): string {
  const full = join(skillDir, relPath);
  const script = `#!/usr/bin/env node
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const params = raw ? JSON.parse(raw) : {};
  ${body}
});
`;
  writeFileSync(full, script, 'utf-8');
  chmodSync(full, 0o755);
  return full;
}

describe('SkillExecutor — JSON-over-stdin contract', () => {
  it('passes params on stdin and parses the JSON written to stdout', async () => {
    writeHandler('echo.js', `process.stdout.write(JSON.stringify({ doubled: params.n * 2 }));`);
    const result = await executor.executeHandler('echo.js', { n: 21 }, { cwd: skillDir });
    expect(result).toEqual({ doubled: 42 });
  });

  it('rejects when the handler exits non-zero, including stderr in the message', async () => {
    writeHandler('boom.js', `process.stderr.write('kaboom'); process.exit(3);`);
    await expect(
      executor.executeHandler('boom.js', {}, { cwd: skillDir }),
    ).rejects.toThrow(/exited with code 3.*kaboom/s);
  });

  it('rejects when the handler emits invalid JSON', async () => {
    writeHandler('garbage.js', `process.stdout.write('not json at all');`);
    await expect(
      executor.executeHandler('garbage.js', {}, { cwd: skillDir }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it('enforces the timeout and rejects', async () => {
    writeHandler('hang.js', `setTimeout(() => process.stdout.write('{}'), 5000);`);
    await expect(
      executor.executeHandler('hang.js', {}, { cwd: skillDir, timeout: 200 }),
    ).rejects.toThrow(/timed out after 200ms/);
  });
});

describe('SkillExecutor — path-traversal guard', () => {
  it('rejects a relative handler path that escapes the skill directory', async () => {
    await expect(
      executor.executeHandler('../evil.js', {}, { cwd: skillDir }),
    ).rejects.toThrow(/resolves outside the skill directory/);
  });

  it('rejects an absolute handler path outside the skill directory', async () => {
    await expect(
      executor.executeHandler('/usr/bin/node', {}, { cwd: skillDir }),
    ).rejects.toThrow(/resolves outside the skill directory/);
  });
});

describe('SkillExecutor — extension allowlist', () => {
  it('rejects a handler with a disallowed extension', async () => {
    writeFileSync(join(skillDir, 'run.sh'), '#!/bin/sh\necho "{}"\n');
    chmodSync(join(skillDir, 'run.sh'), 0o755);
    await expect(
      executor.executeHandler('run.sh', {}, { cwd: skillDir }),
    ).rejects.toThrow(/disallowed extension "\.sh"/);
  });

  it('accepts a .mjs handler', async () => {
    writeHandler('handler.mjs', `process.stdout.write(JSON.stringify({ ok: true }));`);
    const result = await executor.executeHandler('handler.mjs', {}, { cwd: skillDir });
    expect(result).toEqual({ ok: true });
  });
});

describe('SkillExecutor — sensitive-env filtering', () => {
  it('strips secret-looking env vars before spawning the handler', async () => {
    process.env.MY_API_KEY = 'super-secret';
    process.env.SOME_PASSWORD = 'hunter2';
    process.env.ANTHROPIC_API_KEY = 'sk-live';
    process.env.SAFE_PUBLIC_VAR = 'visible';
    try {
      writeHandler(
        'env.js',
        `process.stdout.write(JSON.stringify({
          apiKey: process.env.MY_API_KEY ?? null,
          password: process.env.SOME_PASSWORD ?? null,
          anthropic: process.env.ANTHROPIC_API_KEY ?? null,
          safe: process.env.SAFE_PUBLIC_VAR ?? null,
        }));`,
      );
      const result = (await executor.executeHandler('env.js', {}, { cwd: skillDir })) as Record<string, unknown>;
      expect(result.apiKey).toBeNull();
      expect(result.password).toBeNull();
      expect(result.anthropic).toBeNull();
      expect(result.safe).toBe('visible');
    } finally {
      delete process.env.MY_API_KEY;
      delete process.env.SOME_PASSWORD;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.SAFE_PUBLIC_VAR;
    }
  });

  it('still forwards explicit options.env values to the handler', async () => {
    writeHandler('explicit.js', `process.stdout.write(JSON.stringify({ injected: process.env.INJECTED ?? null }));`);
    const result = (await executor.executeHandler(
      'explicit.js',
      {},
      { cwd: skillDir, env: { INJECTED: 'yes' } },
    )) as Record<string, unknown>;
    expect(result.injected).toBe('yes');
  });
});

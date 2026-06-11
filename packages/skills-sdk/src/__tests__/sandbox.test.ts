/**
 * @module __tests__/sandbox
 * Tests for hardened skill execution.
 *
 * Two layers are covered:
 *  1. `buildSandboxedSpawn` / backend detection — deterministic on any host
 *     (including the "refuse to downgrade when no backend" contract, exercised
 *     by faking a non-Linux platform).
 *  2. End-to-end hardened execution constraints (read-only skill dir, PID
 *     isolation, hidden host paths, network isolation) — run against a real
 *     namespace sandbox, skipped automatically when no backend is available.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillExecutor } from '../executor.js';
import {
  detectSandboxBackend,
  buildSandboxedSpawn,
  SandboxUnavailableError,
  resetSandboxBackendCache,
} from '../sandbox.js';

const hasSandbox = detectSandboxBackend() !== null;
const executor = new SkillExecutor();

let skillDir: string;

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'skill-sandbox-test-'));
});

afterEach(() => {
  try { rmSync(skillDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

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

describe('buildSandboxedSpawn — argv construction', () => {
  it('wraps the handler with unshare namespace flags by default', () => {
    if (!hasSandbox) return;
    const built = buildSandboxedSpawn('/skills/x/handler.js', '/skills/x');
    expect(built.command).toBe('unshare');
    expect(built.args).toContain('--user');
    expect(built.args).toContain('--map-root-user');
    expect(built.args).toContain('--mount');
    expect(built.args).toContain('--pid');
    expect(built.args).toContain('--net');
    expect(built.env.__OO_HANDLER).toBe('/skills/x/handler.js');
    expect(built.env.__OO_RO_DIR).toBe('/skills/x');
  });

  it('omits the network namespace when isolateNetwork is false', () => {
    if (!hasSandbox) return;
    const built = buildSandboxedSpawn('/skills/x/h.js', '/skills/x', { isolateNetwork: false });
    expect(built.args).not.toContain('--net');
  });

  it('does not mount the skill dir read-only when readonlySkillDir is false', () => {
    if (!hasSandbox) return;
    const built = buildSandboxedSpawn('/skills/x/h.js', '/skills/x', { readonlySkillDir: false });
    expect(built.env.__OO_RO_DIR).toBe('');
  });

  it('passes through only absolute hidePaths', () => {
    if (!hasSandbox) return;
    const built = buildSandboxedSpawn('/skills/x/h.js', '/skills/x', {
      hidePaths: ['/home/user/.ssh', 'relative/ignored'],
    });
    expect(built.env.__OO_HIDE).toBe('/home/user/.ssh');
  });
});

describe('hardened execution — refuses to downgrade without a backend', () => {
  it('buildSandboxedSpawn throws SandboxUnavailableError on a non-Linux host', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    resetSandboxBackendCache();
    try {
      expect(() => buildSandboxedSpawn('/x/h.js', '/x')).toThrow(SandboxUnavailableError);
    } finally {
      Object.defineProperty(process, 'platform', orig);
      resetSandboxBackendCache();
    }
  });

  it('executeHandler({ hardened: true }) rejects when no backend is available', async () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    resetSandboxBackendCache();
    try {
      writeHandler('h.js', `process.stdout.write('{}');`);
      await expect(
        executor.executeHandler('h.js', {}, { cwd: skillDir, hardened: true }),
      ).rejects.toThrow(/no namespace sandbox backend/);
    } finally {
      Object.defineProperty(process, 'platform', orig);
      resetSandboxBackendCache();
    }
  });
});

describe.skipIf(!hasSandbox)('hardened execution — runtime constraints', () => {
  it('still returns the handler result through the sandbox', async () => {
    writeHandler('echo.js', `process.stdout.write(JSON.stringify({ doubled: params.n * 2 }));`);
    const result = await executor.executeHandler('echo.js', { n: 21 }, { cwd: skillDir, hardened: true });
    expect(result).toEqual({ doubled: 42 });
  });

  it('runs the handler as PID 1 inside an isolated PID namespace', async () => {
    writeHandler('pid.js', `process.stdout.write(JSON.stringify({ pid: process.pid }));`);
    const result = (await executor.executeHandler('pid.js', {}, { cwd: skillDir, hardened: true })) as { pid: number };
    expect(result.pid).toBe(1);
  });

  it('mounts the skill directory read-only', async () => {
    writeHandler(
      'write.js',
      `const fs = require('fs');
      let wrote = false, err = null;
      try { fs.writeFileSync(require('path').join(process.cwd(), 'probe.txt'), 'x'); wrote = true; }
      catch (e) { err = e.code || e.message; }
      process.stdout.write(JSON.stringify({ wrote, err }));`,
    );
    const result = (await executor.executeHandler('write.js', {}, { cwd: skillDir, hardened: true })) as {
      wrote: boolean;
      err: string | null;
    };
    expect(result.wrote).toBe(false);
    expect(result.err).toMatch(/EROFS|read-only/i);
  });

  it('allows writes to the skill directory in advisory (non-hardened) mode', async () => {
    writeHandler(
      'write2.js',
      `const fs = require('fs');
      fs.writeFileSync(require('path').join(process.cwd(), 'probe.txt'), 'x');
      process.stdout.write(JSON.stringify({ wrote: true }));`,
    );
    const result = (await executor.executeHandler('write2.js', {}, { cwd: skillDir })) as { wrote: boolean };
    expect(result.wrote).toBe(true);
    expect(readFileSync(join(skillDir, 'probe.txt'), 'utf-8')).toBe('x');
  });

  it('hides configured host paths from the handler', async () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'skill-secret-'));
    writeFileSync(join(secretDir, 'token'), 'top-secret', 'utf-8');
    try {
      writeHandler(
        'peek.js',
        `const fs = require('fs');
        let contents = null;
        try { contents = fs.readFileSync(params.path, 'utf-8'); } catch { contents = null; }
        process.stdout.write(JSON.stringify({ contents }));`,
      );
      const result = (await executor.executeHandler(
        'peek.js',
        { path: join(secretDir, 'token') },
        { cwd: skillDir, hardened: true, sandbox: { hidePaths: [secretDir] } },
      )) as { contents: string | null };
      expect(result.contents).toBeNull();
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('isolates the network namespace (no external interfaces)', async () => {
    writeHandler(
      'net.js',
      `const os = require('os');
      const external = Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && !i.internal);
      process.stdout.write(JSON.stringify({ externalCount: external.length }));`,
    );
    const result = (await executor.executeHandler('net.js', {}, { cwd: skillDir, hardened: true })) as {
      externalCount: number;
    };
    expect(result.externalCount).toBe(0);
  });
});

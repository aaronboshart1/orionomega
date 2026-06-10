/**
 * @module __tests__/loader
 * Unit tests for skill discovery, manifest loading, instantiation (manifest
 * mode), trigger matching, and dependency checking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkills,
  loadSkillManifest,
  instantiateSkill,
  SkillLoader,
} from '../loader.js';
import type { SkillManifest, SkillConfig } from '../types.js';
import type { ISkill } from '../interfaces.js';

/** Manifest-mode skills expose executeTool, which is not on the base ISkill. */
type ManifestModeSkill = ISkill & {
  executeTool(name: string, params: Record<string, unknown>): Promise<unknown>;
};

let skillsDir: string;

beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'skills-loader-test-'));
});

afterEach(() => {
  try { rmSync(skillsDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'Demo skill',
    author: 'Tester',
    license: 'MIT',
    orionomega: '>=0.1.0',
    requires: {},
    triggers: { keywords: ['demo'] },
    ...overrides,
  } as SkillManifest;
}

/** Create a skill directory with a manifest.json (and optional extra files). */
function makeSkill(name: string, m: SkillManifest, files: Record<string, string> = {}): string {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m), 'utf-8');
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return dir;
}

describe('discoverSkills', () => {
  it('returns directories that contain a manifest.json', async () => {
    makeSkill('alpha', manifest({ name: 'alpha' }));
    makeSkill('beta', manifest({ name: 'beta' }));
    // A directory with no manifest is ignored.
    mkdirSync(join(skillsDir, 'not-a-skill'), { recursive: true });

    const found = await discoverSkills(skillsDir);
    expect(found.sort()).toEqual([join(skillsDir, 'alpha'), join(skillsDir, 'beta')].sort());
  });

  it('returns an empty array for a non-existent directory', async () => {
    const found = await discoverSkills(join(skillsDir, 'nope'));
    expect(found).toEqual([]);
  });
});

describe('loadSkillManifest', () => {
  it('reads and validates a good manifest', async () => {
    const dir = makeSkill('demo', manifest());
    const loaded = await loadSkillManifest(dir);
    expect(loaded.name).toBe('demo');
  });

  it('throws on invalid JSON', async () => {
    const dir = join(skillsDir, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{ not valid json', 'utf-8');
    await expect(loadSkillManifest(dir)).rejects.toThrow(/Invalid JSON in manifest/);
  });

  it('throws when the manifest fails validation', async () => {
    const dir = join(skillsDir, 'invalid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'x' }), 'utf-8');
    await expect(loadSkillManifest(dir)).rejects.toThrow(/failed validation/);
  });
});

describe('instantiateSkill — manifest mode', () => {
  it('builds a skill that executes its handlers via the JSON contract', async () => {
    const m = manifest({
      tools: [
        {
          name: 'add',
          description: 'adds two numbers',
          handler: 'handlers/add.js',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    const handler = `#!/usr/bin/env node
let raw=''; process.stdin.on('data',c=>raw+=c);
process.stdin.on('end',()=>{ const p=JSON.parse(raw||'{}'); process.stdout.write(JSON.stringify({ sum: p.a + p.b })); });
`;
    const dir = makeSkill('demo', m, { 'handlers/add.js': handler });
    chmodSync(join(dir, 'handlers/add.js'), 0o755);

    const config: SkillConfig = { name: 'demo', enabled: true, configured: true, fields: {} };
    const skill = (await instantiateSkill(m, config, dir)) as ManifestModeSkill;

    const tools = skill.getTools();
    expect(tools.map((t) => t.name)).toEqual(['add']);

    const result = (await skill.executeTool('add', { a: 2, b: 3 })) as { sum: number };
    expect(result.sum).toBe(5);
  });

  it('throws when executing an unknown tool', async () => {
    const m = manifest();
    const dir = makeSkill('demo', m);
    const config: SkillConfig = { name: 'demo', enabled: true, configured: true, fields: {} };
    const skill = (await instantiateSkill(m, config, dir)) as ManifestModeSkill;
    await expect(skill.executeTool('ghost', {})).rejects.toThrow(/not found in skill/);
  });
});

describe('SkillLoader — matching and dependencies', () => {
  it('matchSkills matches on keywords, commands, and patterns', async () => {
    makeSkill('weather', manifest({ name: 'weather', triggers: { keywords: ['forecast'] } }));
    makeSkill('deploy', manifest({ name: 'deploy', triggers: { commands: ['/deploy'] } }));
    makeSkill('ticket', manifest({ name: 'ticket', triggers: { patterns: ['JIRA-\\d+'] } }));

    const loader = new SkillLoader(skillsDir);
    await loader.discoverAll();

    expect(loader.matchSkills('what is the forecast today').map((m) => m.name)).toContain('weather');
    expect(loader.matchSkills('/deploy production').map((m) => m.name)).toContain('deploy');
    expect(loader.matchSkills('please look at JIRA-123').map((m) => m.name)).toContain('ticket');
    expect(loader.matchSkills('nothing relevant here')).toEqual([]);
  });

  it('checkDependencies reports a missing command and a missing env var', async () => {
    const loader = new SkillLoader(skillsDir);
    const m = manifest({
      requires: {
        commands: ['definitely-not-a-real-binary-xyz'],
        env: ['DEFINITELY_UNSET_ENV_XYZ'],
      },
    });
    const result = await loader.checkDependencies(m);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Required command not found/);
    expect(result.errors.join('\n')).toMatch(/Required environment variable not set/);
  });

  it('checkDependencies passes for a command that exists (node)', async () => {
    const loader = new SkillLoader(skillsDir);
    const result = await loader.checkDependencies(manifest({ requires: { commands: ['node'] } }));
    expect(result.valid).toBe(true);
  });
});

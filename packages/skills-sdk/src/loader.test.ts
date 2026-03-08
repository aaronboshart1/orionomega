/**
 * Unit tests for SkillLoader.matchSkills and discoverAll.
 * matchSkills is pure (no filesystem I/O) so it's tested directly.
 * discoverAll uses temp directories for filesystem-dependent tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillLoader } from './loader.js';
import type { SkillManifest } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    version: '1.0.0',
    description: 'Test skill',
    author: 'Test',
    license: 'MIT',
    orionomega: '>=0.1.0',
    requires: {},
    triggers: {},
    ...overrides,
  };
}

// ── matchSkills ──────────────────────────────────────────────────────────────

describe('SkillLoader.matchSkills', () => {
  let loader: SkillLoader;

  // We seed the loader's internal `discovered` map directly by running discoverAll
  // on a temp dir with valid manifests.
  let tmpDir: string;

  async function addSkill(name: string, m: SkillManifest) {
    const dir = path.join(tmpDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m));
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'orionomega-test-'));
    loader = new SkillLoader(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('matches a slash command (exact)', async () => {
    await addSkill('github', manifest({
      name: 'github',
      triggers: { commands: ['/gh'] },
    }));
    await loader.discoverAll();

    const matches = loader.matchSkills('/gh');
    expect(matches.map((m) => m.name)).toContain('github');
  });

  it('matches a slash command (prefix with args)', async () => {
    await addSkill('github', manifest({
      name: 'github',
      triggers: { commands: ['/gh'] },
    }));
    await loader.discoverAll();

    const matches = loader.matchSkills('/gh list issues');
    expect(matches.map((m) => m.name)).toContain('github');
  });

  it('does not match a slash command that is a prefix of a longer different command', async () => {
    await addSkill('github', manifest({
      name: 'github',
      triggers: { commands: ['/github'] },
    }));
    await loader.discoverAll();

    const matches = loader.matchSkills('/gh');
    expect(matches.map((m) => m.name)).not.toContain('github');
  });

  it('matches a keyword (case insensitive)', async () => {
    await addSkill('weather', manifest({
      name: 'weather',
      triggers: { keywords: ['weather'] },
    }));
    await loader.discoverAll();

    const matches = loader.matchSkills('What is the WEATHER today?');
    expect(matches.map((m) => m.name)).toContain('weather');
  });

  it('matches a regex pattern', async () => {
    await addSkill('calc', manifest({
      name: 'calc',
      triggers: { patterns: ['\\d+\\s*[+\\-*/]\\s*\\d+'] },
    }));
    await loader.discoverAll();

    expect(loader.matchSkills('2 + 2').map((m) => m.name)).toContain('calc');
  });

  it('ignores invalid regex patterns without throwing', async () => {
    await addSkill('broken', manifest({
      name: 'broken',
      triggers: { patterns: ['[invalid('] },
    }));
    await loader.discoverAll();

    // Should return empty — invalid regex is silently skipped
    expect(() => loader.matchSkills('anything')).not.toThrow();
  });

  it('returns empty array when no skills match', async () => {
    await addSkill('github', manifest({
      name: 'github',
      triggers: { commands: ['/gh'] },
    }));
    await loader.discoverAll();

    expect(loader.matchSkills('unrelated input')).toHaveLength(0);
  });

  it('prioritizes command match over keyword match for the same skill', async () => {
    await addSkill('github', manifest({
      name: 'github',
      triggers: { commands: ['/gh'], keywords: ['/gh'] },
    }));
    await loader.discoverAll();

    const matches = loader.matchSkills('/gh list');
    // Should appear exactly once even though both triggers match
    expect(matches.filter((m) => m.name === 'github')).toHaveLength(1);
  });

  it('returns multiple skills when multiple match', async () => {
    await addSkill('github', manifest({ name: 'github', triggers: { keywords: ['code'] } }));
    await addSkill('vscode', manifest({ name: 'vscode', triggers: { keywords: ['code'] } }));
    await loader.discoverAll();

    const matches = loader.matchSkills('open code editor');
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// ── discoverAll ──────────────────────────────────────────────────────────────

describe('SkillLoader.discoverAll', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'orionomega-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for an empty directory', async () => {
    const loader = new SkillLoader(tmpDir);
    expect(await loader.discoverAll()).toHaveLength(0);
  });

  it('returns empty array when directory does not exist', async () => {
    const loader = new SkillLoader('/nonexistent/path/to/skills');
    expect(await loader.discoverAll()).toHaveLength(0);
  });

  it('discovers a valid skill', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await mkdir(skillDir);
    await writeFile(
      path.join(skillDir, 'manifest.json'),
      JSON.stringify(
        manifest({ name: 'my-skill', triggers: { keywords: ['hello'] } }),
      ),
    );

    const loader = new SkillLoader(tmpDir);
    const found = await loader.discoverAll();
    expect(found.map((m) => m.name)).toContain('my-skill');
  });

  it('skips directories without manifest.json', async () => {
    await mkdir(path.join(tmpDir, 'empty-skill'));
    const loader = new SkillLoader(tmpDir);
    expect(await loader.discoverAll()).toHaveLength(0);
  });

  it('skips directories with invalid manifest JSON', async () => {
    const dir = path.join(tmpDir, 'bad-skill');
    await mkdir(dir);
    await writeFile(path.join(dir, 'manifest.json'), 'not valid json');
    const loader = new SkillLoader(tmpDir);
    expect(await loader.discoverAll()).toHaveLength(0);
  });

  it('skips manifests that fail validation', async () => {
    const dir = path.join(tmpDir, 'invalid-skill');
    await mkdir(dir);
    // Missing required fields
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'invalid-skill' }));
    const loader = new SkillLoader(tmpDir);
    expect(await loader.discoverAll()).toHaveLength(0);
  });

  it('skips non-directory entries', async () => {
    // Write a plain file at the skills root level — should be ignored
    await writeFile(path.join(tmpDir, 'not-a-skill.json'), '{}');
    const loader = new SkillLoader(tmpDir);
    expect(await loader.discoverAll()).toHaveLength(0);
  });
});

/**
 * @module __tests__/skill-config
 * Unit tests for persisted skill-config read/write/query helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSkillConfig,
  writeSkillConfig,
  isSkillReady,
  listSkillConfigs,
} from '../skill-config.js';
import type { SkillConfig, SkillManifest } from '../types.js';

let skillsDir: string;

beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'skill-config-test-'));
});

afterEach(() => {
  try { rmSync(skillsDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('readSkillConfig', () => {
  it('returns a sensible default when no config file exists', () => {
    const config = readSkillConfig(skillsDir, 'demo');
    expect(config).toEqual({ name: 'demo', enabled: true, configured: false, fields: {} });
  });

  it('falls back to default on corrupt JSON', () => {
    const dir = join(skillsDir, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), 'not json', 'utf-8');
    const config = readSkillConfig(skillsDir, 'demo');
    expect(config.configured).toBe(false);
    expect(config.enabled).toBe(true);
  });

  it('rejects an invalid skill name', () => {
    expect(() => readSkillConfig(skillsDir, '../escape')).toThrow(/Invalid skill name/);
  });
});

describe('writeSkillConfig / readSkillConfig round-trip', () => {
  it('persists and reads back a config (object form)', () => {
    const config: SkillConfig = {
      name: 'demo',
      enabled: true,
      configured: true,
      authMethod: 'apiKey',
      fields: { region: 'us' },
    };
    writeSkillConfig(skillsDir, config);
    const read = readSkillConfig(skillsDir, 'demo');
    expect(read).toMatchObject({
      name: 'demo',
      enabled: true,
      configured: true,
      authMethod: 'apiKey',
      fields: { region: 'us' },
    });
  });

  it('persists the per-install hardened override', () => {
    const config: SkillConfig = {
      name: 'demo',
      enabled: true,
      configured: true,
      hardened: true,
      fields: {},
    };
    writeSkillConfig(skillsDir, config);
    expect(readSkillConfig(skillsDir, 'demo').hardened).toBe(true);
  });

  it('persists via the (skillsDir, name, config) signature', () => {
    const config: SkillConfig = { name: 'demo', enabled: false, configured: false, fields: {} };
    writeSkillConfig(skillsDir, 'demo', config);
    expect(readSkillConfig(skillsDir, 'demo').enabled).toBe(false);
  });

  it('rejects an invalid skill name on write', () => {
    const config: SkillConfig = { name: 'ok', enabled: true, configured: true, fields: {} };
    expect(() => writeSkillConfig(skillsDir, '../bad', config)).toThrow(/Invalid skill name/);
  });
});

describe('isSkillReady', () => {
  const m = (setupRequired: boolean): SkillManifest =>
    ({ setup: { required: setupRequired } } as SkillManifest);

  it('is false when disabled', () => {
    const config: SkillConfig = { name: 'demo', enabled: false, configured: true, fields: {} };
    expect(isSkillReady(config, m(false))).toBe(false);
  });

  it('is false when setup is required but not configured', () => {
    const config: SkillConfig = { name: 'demo', enabled: true, configured: false, fields: {} };
    expect(isSkillReady(config, m(true))).toBe(false);
  });

  it('is true when enabled and (configured or no setup required)', () => {
    expect(isSkillReady({ name: 'demo', enabled: true, configured: false, fields: {} }, m(false))).toBe(true);
    expect(isSkillReady({ name: 'demo', enabled: true, configured: true, fields: {} }, m(true))).toBe(true);
  });
});

describe('listSkillConfigs', () => {
  it('returns only directories that have a config.json', () => {
    writeSkillConfig(skillsDir, { name: 'alpha', enabled: true, configured: true, fields: {} });
    writeSkillConfig(skillsDir, { name: 'beta', enabled: false, configured: false, fields: {} });
    mkdirSync(join(skillsDir, 'gamma'), { recursive: true }); // no config.json

    const configs = listSkillConfigs(skillsDir);
    expect(configs.map((c) => c.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('returns an empty array for a non-existent directory', () => {
    expect(listSkillConfigs(join(skillsDir, 'nope'))).toEqual([]);
  });
});

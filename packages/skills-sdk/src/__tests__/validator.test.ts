import { describe, it, expect } from 'vitest';
import { validateManifest } from '../validator.js';
import type { SkillManifest } from '../types.js';

const baseManifest: SkillManifest = {
  name: 'test-skill',
  version: '1.0.0',
  description: 'A test skill',
  author: 'Test Author',
  license: 'MIT',
  orionomega: '>=0.1.0',
  requires: {},
  triggers: { keywords: ['test'] },
};

describe('validateManifest', () => {
  it('passes a valid manifest', () => {
    const result = validateManifest(baseManifest, '0.1.0');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors on missing required fields', () => {
    const manifest = { ...baseManifest, name: '' };
    const result = validateManifest(manifest, '0.1.0');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"name"'))).toBe(true);
  });

  it('errors on invalid semver version', () => {
    const manifest = { ...baseManifest, version: 'not-semver' };
    const result = validateManifest(manifest, '0.1.0');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('semver'))).toBe(true);
  });

  it('errors when missing requires block', () => {
    const manifest = { ...baseManifest } as Partial<SkillManifest>;
    delete manifest.requires;
    const result = validateManifest(manifest as SkillManifest, '0.1.0');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"requires"'))).toBe(true);
  });

  it('errors when missing triggers block', () => {
    const manifest = { ...baseManifest } as Partial<SkillManifest>;
    delete manifest.triggers;
    const result = validateManifest(manifest as SkillManifest, '0.1.0');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"triggers"'))).toBe(true);
  });

  it('errors when version incompatible with current orionomega', () => {
    const manifest = { ...baseManifest, orionomega: '>=99.0.0' };
    const result = validateManifest(manifest, '0.1.0');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('requires orionomega'))).toBe(true);
  });

  it('errors on tool with missing name', () => {
    const manifest = {
      ...baseManifest,
      tools: [{ name: '', description: 'desc', handler: 'handler.js', inputSchema: {} }],
    };
    const result = validateManifest(manifest, '0.1.0');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('warns when tool is missing description', () => {
    const manifest = {
      ...baseManifest,
      tools: [{ name: 'my-tool', description: '', handler: 'handler.js', inputSchema: {} }],
    };
    const result = validateManifest(manifest, '0.1.0');
    expect(result.warnings.some((w) => w.includes('description'))).toBe(true);
  });

  it('returns valid=true with no currentVersion provided', () => {
    const result = validateManifest(baseManifest);
    expect(result.valid).toBe(true);
  });
});

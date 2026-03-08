/**
 * Unit tests for skills-sdk/validator.ts
 * Validates manifest structure, semver, compatibility ranges, and tool definitions.
 */

import { describe, it, expect } from 'vitest';
import { validateManifest } from './validator.js';
import type { SkillManifest } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A valid minimal manifest to use as a baseline. */
function baseManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    version: '1.0.0',
    description: 'A test skill',
    author: 'Test Author',
    license: 'MIT',
    orionomega: '>=0.1.0',
    requires: {},
    triggers: { keywords: ['test'] },
    ...overrides,
  };
}

// ── Required fields ──────────────────────────────────────────────────────────

describe('validateManifest — required fields', () => {
  it('passes a valid minimal manifest', () => {
    const result = validateManifest(baseManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors on missing name', () => {
    const result = validateManifest(baseManifest({ name: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"name"'))).toBe(true);
  });

  it('errors on missing version', () => {
    const result = validateManifest(baseManifest({ version: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"version"'))).toBe(true);
  });

  it('errors on missing description', () => {
    const result = validateManifest(baseManifest({ description: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"description"'))).toBe(true);
  });

  it('errors on missing author', () => {
    const result = validateManifest(baseManifest({ author: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"author"'))).toBe(true);
  });

  it('errors on missing license', () => {
    const result = validateManifest(baseManifest({ license: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"license"'))).toBe(true);
  });

  it('errors on missing orionomega field', () => {
    const result = validateManifest(baseManifest({ orionomega: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"orionomega"'))).toBe(true);
  });

  it('errors when requires is missing', () => {
    const m = baseManifest();
    // @ts-expect-error — deliberately omitting required field for test
    delete m.requires;
    const result = validateManifest(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"requires"'))).toBe(true);
  });

  it('errors when triggers is missing', () => {
    const m = baseManifest();
    // @ts-expect-error — deliberately omitting required field for test
    delete m.triggers;
    const result = validateManifest(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"triggers"'))).toBe(true);
  });
});

// ── Semver validation ────────────────────────────────────────────────────────

describe('validateManifest — semver version', () => {
  it('accepts valid semver X.Y.Z', () => {
    expect(validateManifest(baseManifest({ version: '2.3.4' })).valid).toBe(true);
  });

  it('accepts semver with prerelease tag', () => {
    expect(validateManifest(baseManifest({ version: '1.0.0-alpha.1' })).valid).toBe(true);
  });

  it('accepts semver with build metadata', () => {
    expect(validateManifest(baseManifest({ version: '1.0.0+build.42' })).valid).toBe(true);
  });

  it('errors on non-semver version string', () => {
    const result = validateManifest(baseManifest({ version: 'latest' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('semver'))).toBe(true);
  });

  it('errors on partial version (missing patch)', () => {
    const result = validateManifest(baseManifest({ version: '1.0' }));
    expect(result.valid).toBe(false);
  });
});

// ── orionomega compatibility range ───────────────────────────────────────────

describe('validateManifest — compatibility', () => {
  it('passes when running version satisfies >=0.1.0', () => {
    const result = validateManifest(baseManifest({ orionomega: '>=0.1.0' }), '0.2.0');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors when running version is below required minimum', () => {
    const result = validateManifest(baseManifest({ orionomega: '>=2.0.0' }), '0.1.0');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('orionomega'))).toBe(true);
  });

  it('passes when versions are equal', () => {
    const result = validateManifest(baseManifest({ orionomega: '>=1.0.0' }), '1.0.0');
    expect(result.valid).toBe(true);
  });

  it('warns on unparseable range but still passes', () => {
    const result = validateManifest(baseManifest({ orionomega: 'not-a-range' }), '0.1.0');
    // Should not be an error, just a warning
    expect(result.warnings.some((w) => w.includes('could not be parsed'))).toBe(true);
  });
});

// ── Tool definitions ─────────────────────────────────────────────────────────

describe('validateManifest — tool definitions', () => {
  it('passes a manifest with a valid tool', () => {
    const result = validateManifest(
      baseManifest({
        tools: [
          {
            name: 'my-tool',
            description: 'Does something',
            handler: './handler.sh',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('errors when a tool is missing name', () => {
    const result = validateManifest(
      baseManifest({
        // @ts-expect-error — testing missing name
        tools: [{ handler: './h.sh', inputSchema: {} }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tools[0]') && e.includes('name'))).toBe(true);
  });

  it('errors when a tool is missing handler', () => {
    const result = validateManifest(
      baseManifest({
        // @ts-expect-error — testing missing handler
        tools: [{ name: 'tool', inputSchema: {} }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('handler'))).toBe(true);
  });

  it('errors when a tool is missing inputSchema', () => {
    const result = validateManifest(
      baseManifest({
        // @ts-expect-error — testing missing inputSchema
        tools: [{ name: 'tool', handler: './h.sh' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('inputSchema'))).toBe(true);
  });

  it('warns when a tool has no description', () => {
    const result = validateManifest(
      baseManifest({
        // @ts-expect-error — deliberately omitting description
        tools: [{ name: 'tool', handler: './h.sh', inputSchema: {} }],
      }),
    );
    // Missing description is a warning, not an error
    expect(result.warnings.some((w) => w.includes('description'))).toBe(true);
  });

  it('warns on non-positive timeout', () => {
    const result = validateManifest(
      baseManifest({
        tools: [
          {
            name: 'tool',
            description: 'x',
            handler: './h.sh',
            inputSchema: {},
            timeout: -1,
          },
        ],
      }),
    );
    expect(result.warnings.some((w) => w.includes('timeout'))).toBe(true);
  });
});

// ── OS / Arch warnings ───────────────────────────────────────────────────────

describe('validateManifest — OS and arch warnings', () => {
  it('warns when OS list excludes current platform', () => {
    // Force an OS that can't be the current platform
    const result = validateManifest(baseManifest({ os: ['nonexistent-os'] }));
    expect(result.warnings.some((w) => w.includes('OS'))).toBe(true);
  });

  it('does not warn when OS list includes current platform', () => {
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const result = validateManifest(baseManifest({ os: [platform] }));
    expect(result.warnings.filter((w) => w.includes('OS'))).toHaveLength(0);
  });
});

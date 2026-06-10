/**
 * @module __tests__/validator
 * Unit tests for the manifest validator — structural and semantic checks.
 */

import { describe, it, expect } from 'vitest';
import { validateManifest } from '../validator.js';
import type { SkillManifest } from '../types.js';

function baseManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'my-skill',
    version: '1.0.0',
    description: 'A test skill',
    author: 'Tester',
    license: 'MIT',
    orionomega: '>=0.1.0',
    requires: {},
    triggers: { keywords: ['hello'] },
    ...overrides,
  } as SkillManifest;
}

describe('validateManifest — identity fields', () => {
  it('accepts a well-formed manifest', () => {
    const result = validateManifest(baseManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports every missing required field in a single pass', () => {
    const result = validateManifest({} as SkillManifest);
    expect(result.valid).toBe(false);
    const joined = result.errors.join('\n');
    expect(joined).toMatch(/manifest\.name/);
    expect(joined).toMatch(/manifest\.version/);
    expect(joined).toMatch(/manifest\.description/);
    expect(joined).toMatch(/manifest\.author/);
    expect(joined).toMatch(/manifest\.license/);
    expect(joined).toMatch(/manifest\.orionomega/);
    expect(joined).toMatch(/manifest\.requires/);
    expect(joined).toMatch(/manifest\.triggers/);
  });

  it('warns (does not error) on a non-kebab-case name', () => {
    const result = validateManifest(baseManifest({ name: 'MySkill' }));
    expect(result.valid).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/kebab-case/);
  });
});

describe('validateManifest — requires block', () => {
  it('errors when requires is an array instead of an object', () => {
    const result = validateManifest(baseManifest({ requires: [] as never }));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/manifest\.requires is required/);
  });

  it('errors when a requires field is not an array', () => {
    const result = validateManifest(
      baseManifest({ requires: { commands: 'git' as never } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/manifest\.requires\.commands must be an array/);
  });
});

describe('validateManifest — triggers block', () => {
  it('warns when there are no triggers at all', () => {
    const result = validateManifest(baseManifest({ triggers: {} }));
    expect(result.valid).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/never match user input/);
  });

  it('errors on an invalid regex pattern', () => {
    const result = validateManifest(
      baseManifest({ triggers: { patterns: ['([unclosed'] } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/invalid regex/);
  });
});

describe('validateManifest — tools block', () => {
  it('accepts a valid tool', () => {
    const result = validateManifest(
      baseManifest({
        tools: [
          {
            name: 'do_thing',
            description: 'Does a thing',
            handler: 'handlers/do_thing.js',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('errors when a tool is missing required fields and has a bad schema type', () => {
    const result = validateManifest(
      baseManifest({
        tools: [
          {
            // missing name, description, handler
            inputSchema: { type: 'string' },
          } as never,
        ],
      }),
    );
    expect(result.valid).toBe(false);
    const joined = result.errors.join('\n');
    expect(joined).toMatch(/tools\[0\]\.name is required/);
    expect(joined).toMatch(/tools\[0\]\.description is required/);
    expect(joined).toMatch(/tools\[0\]\.handler is required/);
    expect(joined).toMatch(/inputSchema must have type "object"/);
  });

  it('errors when timeout is not a number', () => {
    const result = validateManifest(
      baseManifest({
        tools: [
          {
            name: 'do_thing',
            description: 'Does a thing',
            handler: 'handlers/do_thing.js',
            inputSchema: { type: 'object', properties: {} },
            timeout: 'soon' as never,
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/tools\[0\]\.timeout must be a number/);
  });

  it('warns on a non-snake_case tool name', () => {
    const result = validateManifest(
      baseManifest({
        tools: [
          {
            name: 'doThing',
            description: 'Does a thing',
            handler: 'handlers/do_thing.js',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/snake_case/);
  });
});

describe('validateManifest — settings block', () => {
  it('errors when settings.type is not "object"', () => {
    const result = validateManifest(
      baseManifest({ settings: { type: 'string', properties: {} } as never }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/settings\.type must be "object"/);
  });

  it('errors when settings.properties is missing', () => {
    const result = validateManifest(
      baseManifest({ settings: { type: 'object' } as never }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/settings\.properties is required/);
  });
});

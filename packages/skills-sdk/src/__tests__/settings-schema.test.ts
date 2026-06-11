/**
 * @module __tests__/settings-schema
 * Tests for JSON-Schema-driven settings validation — types, ranges, enums,
 * required fields, multiselect option lists, and URL format — plus the
 * underlying generic JSON Schema validator.
 */

import { describe, it, expect } from 'vitest';
import { validateSettings, buildSettingsJsonSchema } from '../settings.js';
import { validateAgainstSchema } from '../json-schema.js';
import { SkillSettingType } from '../types.js';
import type { SkillManifest, SkillSettingsBlock } from '../types.js';

function manifestWith(settings: SkillSettingsBlock): SkillManifest {
  return {
    name: 'cfg-skill',
    version: '1.0.0',
    description: 'config skill',
    author: 'Tester',
    license: 'MIT',
    orionomega: '>=0.1.0',
    requires: {},
    triggers: { keywords: ['hello'] },
    settings,
  } as SkillManifest;
}

const block: SkillSettingsBlock = {
  type: 'object',
  required: ['apiKey'],
  properties: {
    apiKey: { type: SkillSettingType.Password, label: 'API Key', validation: { min: 8 } },
    retries: { type: SkillSettingType.Number, label: 'Retries', validation: { min: 0, max: 5 } },
    enabled: { type: SkillSettingType.Boolean, label: 'Enabled' },
    endpoint: { type: SkillSettingType.URL, label: 'Endpoint' },
    region: {
      type: SkillSettingType.Select,
      label: 'Region',
      options: [
        { label: 'US', value: 'us' },
        { label: 'EU', value: 'eu' },
      ],
    },
    tags: {
      type: SkillSettingType.Multiselect,
      label: 'Tags',
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
    },
  },
};

describe('validateSettings — JSON-Schema-driven', () => {
  it('accepts a fully valid settings object', () => {
    const result = validateSettings(manifestWith(block), {
      apiKey: 'longenoughkey',
      retries: 3,
      enabled: true,
      endpoint: 'https://example.com/api',
      region: 'eu',
      tags: ['a', 'b'],
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('reports a missing required field', () => {
    const result = validateSettings(manifestWith(block), { retries: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Required property "apiKey"/);
  });

  it('treats an empty-string required field as missing', () => {
    const result = validateSettings(manifestWith(block), { apiKey: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Required property "apiKey"/);
  });

  it('rejects a wrong type (string where number expected)', () => {
    const result = validateSettings(manifestWith(block), {
      apiKey: 'longenoughkey',
      retries: 'three',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Retries.*must be of type number/);
  });

  it('enforces numeric ranges (minimum / maximum)', () => {
    const tooHigh = validateSettings(manifestWith(block), { apiKey: 'longenoughkey', retries: 9 });
    expect(tooHigh.valid).toBe(false);
    expect(tooHigh.errors.join('\n')).toMatch(/Retries.*must be <= 5/);

    const tooLow = validateSettings(manifestWith(block), { apiKey: 'longenoughkey', retries: -1 });
    expect(tooLow.valid).toBe(false);
    expect(tooLow.errors.join('\n')).toMatch(/Retries.*must be >= 0/);
  });

  it('enforces string minLength derived from validation.min', () => {
    const result = validateSettings(manifestWith(block), { apiKey: 'short' });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/API Key.*at least 8 characters/);
  });

  it('enforces Select enums from options', () => {
    const result = validateSettings(manifestWith(block), {
      apiKey: 'longenoughkey',
      region: 'antarctica',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Region.*must be one of/);
  });

  it('enforces Multiselect item enums and array typing', () => {
    const badItem = validateSettings(manifestWith(block), {
      apiKey: 'longenoughkey',
      tags: ['a', 'zzz'],
    });
    expect(badItem.valid).toBe(false);
    expect(badItem.errors.join('\n')).toMatch(/tags\[1\]/);

    const notArray = validateSettings(manifestWith(block), {
      apiKey: 'longenoughkey',
      tags: 'a',
    });
    expect(notArray.valid).toBe(false);
    expect(notArray.errors.join('\n')).toMatch(/Tags.*must be of type array/);
  });

  it('enforces URI format on URL fields', () => {
    const result = validateSettings(manifestWith(block), {
      apiKey: 'longenoughkey',
      endpoint: 'not a url',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Endpoint.*must be a valid URI/);
  });

  it('warns about unknown settings without failing validation', () => {
    const result = validateSettings(manifestWith(block), {
      apiKey: 'longenoughkey',
      mystery: 42,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/Unknown setting "mystery"/);
  });

  it('passes when a manifest declares no settings block', () => {
    const m = manifestWith(block);
    delete (m as { settings?: unknown }).settings;
    const result = validateSettings(m, { anything: 'goes' });
    expect(result.valid).toBe(true);
  });
});

describe('buildSettingsJsonSchema', () => {
  it('maps setting types and constraints into a JSON Schema', () => {
    const schema = buildSettingsJsonSchema(block);
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['apiKey']);
    expect(schema.properties?.apiKey).toMatchObject({ type: 'string', minLength: 8 });
    expect(schema.properties?.retries).toMatchObject({ type: 'number', minimum: 0, maximum: 5 });
    expect(schema.properties?.endpoint).toMatchObject({ type: 'string', format: 'uri' });
    expect(schema.properties?.region).toMatchObject({ type: 'string', enum: ['us', 'eu'] });
    expect(schema.properties?.tags).toMatchObject({
      type: 'array',
      items: { type: 'string', enum: ['a', 'b'] },
    });
  });
});

describe('validateAgainstSchema — generic keywords', () => {
  it('validates integer type, exclusive bounds, and multipleOf', () => {
    const schema = {
      type: 'integer' as const,
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
      multipleOf: 5,
    };
    expect(validateAgainstSchema(10, schema)).toEqual([]);
    expect(validateAgainstSchema(2.5, schema).length).toBeGreaterThan(0); // not integer
    expect(validateAgainstSchema(0, schema).length).toBeGreaterThan(0); // exclusiveMinimum
    expect(validateAgainstSchema(7, schema).length).toBeGreaterThan(0); // multipleOf
  });

  it('validates nested objects and reports paths', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        nested: {
          type: 'object' as const,
          properties: { count: { type: 'number' as const, minimum: 1 } },
          required: ['count'],
        },
      },
      required: ['nested'],
    };
    const errors = validateAgainstSchema({ nested: { count: 0 } }, schema, 'root');
    expect(errors.some((e) => e.path === 'root.nested.count')).toBe(true);
  });

  it('honours const and enum equality, including deep equality for arrays', () => {
    expect(validateAgainstSchema(['a', 'b'], { const: ['a', 'b'] })).toEqual([]);
    expect(validateAgainstSchema(['a', 'c'], { const: ['a', 'b'] }).length).toBe(1);
    expect(validateAgainstSchema('x', { enum: ['y', 'z'] }).length).toBe(1);
  });

  it('enforces additionalProperties:false', () => {
    const schema = {
      type: 'object' as const,
      properties: { a: { type: 'string' as const } },
      additionalProperties: false,
    };
    const errors = validateAgainstSchema({ a: 'ok', b: 1 }, schema);
    expect(errors.some((e) => /Unknown property "b"/.test(e.message))).toBe(true);
  });

  it('enforces array uniqueItems and bounds', () => {
    const schema = { type: 'array' as const, uniqueItems: true, minItems: 2, maxItems: 3 };
    expect(validateAgainstSchema([1, 1], schema).some((e) => /duplicate/.test(e.message))).toBe(true);
    expect(validateAgainstSchema([1], schema).some((e) => /at least 2/.test(e.message))).toBe(true);
    expect(validateAgainstSchema([1, 2, 3, 4], schema).some((e) => /at most 3/.test(e.message))).toBe(true);
  });
});

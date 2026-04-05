#!/usr/bin/env tsx
/**
 * Unit tests for skills-sdk/validator.ts
 * Tests: validateManifest
 */

import { suite, section, assert, assertEq, printSummary, resetResults } from './test-harness.js';
import { validateManifest } from '../packages/skills-sdk/src/validator.js';
import type { SkillManifest } from '../packages/skills-sdk/src/types.js';

// ── Helper ──────────────────────────────────────────────────────

function validManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'my-skill',
    version: '1.0.0',
    description: 'A test skill',
    author: 'Test Author',
    license: 'MIT',
    orionomega: '>=0.1.0',
    requires: {},
    triggers: {
      keywords: ['test'],
    },
    ...overrides,
  } as SkillManifest;
}

// ── Tests ───────────────────────────────────────────────────────

resetResults();
suite('Validator — validateManifest');

section('valid manifest');
{
  const result = validateManifest(validManifest());
  assert(result.valid, 'valid manifest passes');
  assertEq(result.errors.length, 0, 'no errors');
}

// ── Required field checks ───────────────────────────────────────

section('missing name');
{
  const result = validateManifest(validManifest({ name: '' }));
  assert(!result.valid, 'missing name is invalid');
  assert(result.errors.some(e => e.includes('name')), 'error mentions name');
}

section('missing version');
{
  const result = validateManifest(validManifest({ version: '' }));
  assert(!result.valid, 'missing version is invalid');
  assert(result.errors.some(e => e.includes('version')), 'error mentions version');
}

section('missing description');
{
  const result = validateManifest(validManifest({ description: '' }));
  assert(!result.valid, 'missing description is invalid');
}

section('missing author');
{
  const result = validateManifest(validManifest({ author: '' }));
  assert(!result.valid, 'missing author is invalid');
}

section('missing license');
{
  const result = validateManifest(validManifest({ license: '' }));
  assert(!result.valid, 'missing license is invalid');
}

section('missing orionomega version');
{
  const result = validateManifest(validManifest({ orionomega: '' }));
  assert(!result.valid, 'missing orionomega is invalid');
}

// ── Name format warning ─────────────────────────────────────────

section('non-kebab-case name warning');
{
  const result = validateManifest(validManifest({ name: 'MySkill' }));
  assert(result.valid, 'non-kebab-case name still valid (warning not error)');
  assert(result.warnings.some(w => w.includes('kebab-case')), 'warns about kebab-case');
}

section('valid kebab-case name — no warning');
{
  const result = validateManifest(validManifest({ name: 'my-cool-skill' }));
  assertEq(result.warnings.filter(w => w.includes('kebab-case')).length, 0, 'no kebab-case warning');
}

// ── requires validation ─────────────────────────────────────────

section('missing requires');
{
  const m = validManifest();
  (m as Record<string, unknown>).requires = undefined;
  const result = validateManifest(m);
  assert(!result.valid, 'missing requires is invalid');
}

section('requires.commands not array');
{
  const m = validManifest({ requires: { commands: 'git' as unknown as string[] } });
  const result = validateManifest(m);
  assert(!result.valid, 'requires.commands must be array');
}

section('valid requires with arrays');
{
  const result = validateManifest(validManifest({
    requires: { commands: ['git'], env: ['HOME'] },
  }));
  assert(result.valid, 'valid requires with arrays passes');
}

// ── triggers validation ─────────────────────────────────────────

section('missing triggers');
{
  const m = validManifest();
  (m as Record<string, unknown>).triggers = undefined;
  const result = validateManifest(m);
  assert(!result.valid, 'missing triggers is invalid');
}

section('empty triggers warning');
{
  const result = validateManifest(validManifest({
    triggers: {},
  }));
  assert(result.valid, 'empty triggers is valid (warning only)');
  assert(result.warnings.some(w => w.includes('never match')), 'warns about no trigger');
}

section('triggers.keywords not array');
{
  const m = validManifest();
  m.triggers = { keywords: 'bad' as unknown as string[] };
  const result = validateManifest(m);
  assert(!result.valid, 'keywords must be array');
}

section('invalid regex pattern');
{
  const result = validateManifest(validManifest({
    triggers: { patterns: ['[invalid('] },
  }));
  assert(!result.valid, 'invalid regex is an error');
  assert(result.errors.some(e => e.includes('invalid regex')), 'error mentions regex');
}

section('valid regex pattern');
{
  const result = validateManifest(validManifest({
    triggers: { patterns: ['^deploy\\s+.*$'] },
  }));
  assert(result.valid, 'valid regex passes');
}

// ── tools validation ────────────────────────────────────────────

section('valid tool');
{
  const result = validateManifest(validManifest({
    tools: [{
      name: 'my_tool',
      description: 'Does things',
      handler: 'tools/my-tool.ts',
      inputSchema: { type: 'object', properties: {} },
    }],
  }));
  assert(result.valid, 'valid tool passes');
}

section('tool missing name');
{
  const result = validateManifest(validManifest({
    tools: [{
      name: '',
      description: 'Does things',
      handler: 'tools/my-tool.ts',
      inputSchema: { type: 'object' },
    }],
  }));
  assert(!result.valid, 'tool without name is invalid');
}

section('tool non-snake_case name warning');
{
  const result = validateManifest(validManifest({
    tools: [{
      name: 'myTool',
      description: 'Does things',
      handler: 'tools/my-tool.ts',
      inputSchema: { type: 'object' },
    }],
  }));
  assert(result.warnings.some(w => w.includes('snake_case')), 'warns about non-snake_case tool name');
}

section('tool inputSchema wrong type');
{
  const result = validateManifest(validManifest({
    tools: [{
      name: 'my_tool',
      description: 'Does things',
      handler: 'tools/my-tool.ts',
      inputSchema: { type: 'string' },
    }],
  }));
  assert(!result.valid, 'inputSchema must have type object');
}

section('tool missing handler');
{
  const result = validateManifest(validManifest({
    tools: [{
      name: 'my_tool',
      description: 'Does things',
      handler: '',
      inputSchema: { type: 'object' },
    }],
  }));
  assert(!result.valid, 'tool without handler is invalid');
}

section('tool timeout must be number');
{
  const result = validateManifest(validManifest({
    tools: [{
      name: 'my_tool',
      description: 'Does things',
      handler: 'tools/my-tool.ts',
      inputSchema: { type: 'object' },
      timeout: 'slow' as unknown as number,
    }],
  }));
  assert(!result.valid, 'string timeout is invalid');
}

// ── settings validation ─────────────────────────────────────────

section('valid settings');
{
  const result = validateManifest(validManifest({
    settings: {
      type: 'object',
      properties: { apiKey: { type: 'string' } },
    },
  } as Partial<SkillManifest>));
  assert(result.valid, 'valid settings pass');
}

section('settings wrong type');
{
  const result = validateManifest(validManifest({
    settings: {
      type: 'array',
      properties: {},
    },
  } as Partial<SkillManifest>));
  assert(!result.valid, 'settings.type must be object');
}

section('settings missing properties');
{
  const result = validateManifest(validManifest({
    settings: {
      type: 'object',
    },
  } as Partial<SkillManifest>));
  assert(!result.valid, 'settings.properties is required');
}

const ok = printSummary('Validator Tests');
process.exit(ok ? 0 : 1);

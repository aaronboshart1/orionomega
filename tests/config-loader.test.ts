#!/usr/bin/env tsx
/**
 * Unit tests for config/loader.ts
 * Tests: normalizeBindAddresses, getDefaultConfig
 */

import { suite, section, assert, assertEq, assertDeepEq, printSummary, resetResults } from './test-harness.js';
import { normalizeBindAddresses, getDefaultConfig } from '../packages/core/src/config/loader.js';

resetResults();
suite('Config Loader — normalizeBindAddresses, getDefaultConfig');

// ── normalizeBindAddresses ──────────────────────────────────────

section('normalizeBindAddresses — undefined');
{
  const result = normalizeBindAddresses(undefined);
  assertDeepEq(result, ['127.0.0.1'], 'undefined defaults to [127.0.0.1]');
}

section('normalizeBindAddresses — single string');
{
  const result = normalizeBindAddresses('0.0.0.0');
  assertDeepEq(result, ['0.0.0.0'], 'single address string');
}

section('normalizeBindAddresses — comma-separated string');
{
  const result = normalizeBindAddresses('127.0.0.1, 0.0.0.0');
  assertDeepEq(result, ['127.0.0.1', '0.0.0.0'], 'splits and trims comma-separated');
}

section('normalizeBindAddresses — array input');
{
  const result = normalizeBindAddresses(['127.0.0.1', '::1']);
  assertDeepEq(result, ['127.0.0.1', '::1'], 'array passes through');
}

section('normalizeBindAddresses — deduplication');
{
  const result = normalizeBindAddresses(['127.0.0.1', '127.0.0.1', '0.0.0.0']);
  assertDeepEq(result, ['127.0.0.1', '0.0.0.0'], 'deduplicates');
}

section('normalizeBindAddresses — empty string defaults');
{
  const result = normalizeBindAddresses('');
  assertDeepEq(result, ['127.0.0.1'], 'empty string defaults to [127.0.0.1]');
}

section('normalizeBindAddresses — empty array defaults');
{
  const result = normalizeBindAddresses([]);
  assertDeepEq(result, ['127.0.0.1'], 'empty array defaults to [127.0.0.1]');
}

section('normalizeBindAddresses — array with comma values');
{
  const result = normalizeBindAddresses(['127.0.0.1,0.0.0.0', '::1']);
  assertDeepEq(result, ['127.0.0.1', '0.0.0.0', '::1'], 'splits commas within array elements');
}

section('normalizeBindAddresses — whitespace-only values filtered');
{
  const result = normalizeBindAddresses(['  ', '127.0.0.1', '']);
  assertDeepEq(result, ['127.0.0.1'], 'filters whitespace-only entries');
}

// ── getDefaultConfig ────────────────────────────────────────────

section('getDefaultConfig — returns valid config structure');
{
  const config = getDefaultConfig();
  assert(config.gateway !== undefined, 'has gateway');
  assert(config.hindsight !== undefined, 'has hindsight');
  assert(config.models !== undefined, 'has models');
  assert(config.orchestration !== undefined, 'has orchestration');
  assert(config.workspace !== undefined, 'has workspace');
  assert(config.logging !== undefined, 'has logging');
  assert(config.skills !== undefined, 'has skills');
  assert(config.codingMode !== undefined, 'has codingMode');
}

section('getDefaultConfig — gateway defaults');
{
  const config = getDefaultConfig();
  assertEq(config.gateway.port, 8000, 'gateway port = 8000');
  assertDeepEq(config.gateway.bind, ['127.0.0.1'], 'gateway binds to localhost');
  assertEq(config.gateway.auth.mode, 'none', 'auth mode = none');
}

section('getDefaultConfig — orchestration defaults');
{
  const config = getDefaultConfig();
  assertEq(config.orchestration.maxSpawnDepth, 3, 'maxSpawnDepth = 3');
  // Bumped 300 → 600 in task #103 — the previous default was the root cause
  // of "Worker timed out after 120s" errors on long-running coding loops.
  assertEq(config.orchestration.workerTimeout, 600, 'workerTimeout = 600');
  assertEq(config.orchestration.codingAgentTimeout, 1800, 'codingAgentTimeout = 1800');
  assertEq(config.orchestration.validationTimeout, 300, 'validationTimeout = 300');
  assertEq(config.orchestration.maxRetries, 2, 'maxRetries = 2');
  assert(config.orchestration.planFirst === true, 'planFirst = true');
}

section('getDefaultConfig — codingMode defaults');
{
  const config = getDefaultConfig();
  assert(config.codingMode.enabled === true, 'codingMode enabled');
  assertEq(config.codingMode.maxParallelAgents, 4, 'maxParallelAgents = 4');
  assertEq(config.codingMode.budgetMultiplier, 1.0, 'budgetMultiplier = 1.0');
}

section('getDefaultConfig — models provider');
{
  const config = getDefaultConfig();
  assertEq(config.models.provider, 'anthropic', 'provider = anthropic');
}

const ok = printSummary('Config Loader Tests');
process.exit(ok ? 0 : 1);

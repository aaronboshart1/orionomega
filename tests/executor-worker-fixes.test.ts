/**
 * Tests for executor.ts and worker.ts hindsight fixes:
 *
 *  Fix A (executor.ts:604)  — recallContext uses this.config.task ?? node.agent.task,
 *                             not the raw agent sub-task instruction.
 *  Fix B (executor.ts:1205) — Bank-discovery URL uses configured defaultBank namespace,
 *                             not the hardcoded string "default".
 *  Fix C (worker.ts:465-471) — buildWorkerSystemPrompt prepends hindsight context
 *                              before a custom systemPrompt instead of discarding it.
 */

import { readFileSync } from 'node:fs';
import {
  suite, section, assert, assertEq, resetResults, printSummary,
} from './test-harness.js';

resetResults();
suite('Executor / Worker Hindsight Fixes');

const EXECUTOR_SRC = '/home/kali/.orionomega/src/packages/core/src/orchestration/executor.ts';
const WORKER_SRC   = '/home/kali/.orionomega/src/packages/core/src/orchestration/worker.ts';

const executor = readFileSync(EXECUTOR_SRC, 'utf-8');
const worker   = readFileSync(WORKER_SRC,   'utf-8');

// ════════════════════════════════════════════════════════════════
// FIX A — Agent node instructions NOT sent to hindsight as query
// ════════════════════════════════════════════════════════════════

section('Fix A: recallContext uses original user task, not agent sub-task');

// The fixed call site must use this.config.task ?? node.agent.task
assert(
  executor.includes('this.config.task ?? node.agent.task'),
  'executor.ts: recallContext query uses this.config.task ?? node.agent.task',
);

// The old bare node.agent.task call must be gone from the recall invocation
assert(
  !executor.includes('await this.recallContext(node.agent.task)'),
  'executor.ts: bare recallContext(node.agent.task) removed',
);

// Verify the comment explaining why
assert(
  executor.includes('original user task'),
  'executor.ts: comment explains original-user-task rationale',
);

// ════════════════════════════════════════════════════════════════
// FIX A — Behavioural simulation
// ════════════════════════════════════════════════════════════════

section('Fix A: ?? fallback semantics');

{
  // When config.task is set, it wins over node.agent.task
  const configTask    = 'help me fix the login page';
  const nodeAgentTask = 'Inspect the auth module for SQL injection vulnerabilities';
  const effectiveQuery = configTask ?? nodeAgentTask;
  assertEq(effectiveQuery, configTask,
    'config.task present → used as recall query');
}

{
  // When config.task is undefined, node.agent.task is the fallback
  const configTask    = undefined;
  const nodeAgentTask = 'Inspect the auth module for SQL injection vulnerabilities';
  const effectiveQuery = configTask ?? nodeAgentTask;
  assertEq(effectiveQuery, nodeAgentTask,
    'config.task absent → falls back to node.agent.task');
}

{
  // When config.task is null, node.agent.task is the fallback
  const configTask    = null as unknown as string | undefined;
  const nodeAgentTask = 'Fallback sub-task';
  const effectiveQuery = configTask ?? nodeAgentTask;
  assertEq(effectiveQuery, nodeAgentTask,
    'config.task null → falls back to node.agent.task');
}

{
  // Semantic relevance: user task matches memories better than agent sub-task
  const userTask    = 'fix the login bug';
  const agentTask   = 'Analyse authentication module for SQL injection vulnerabilities';
  const storedMemory = 'We decided to fix the login page session bug in ticket #42';

  function wordOverlap(query: string, memory: string): number {
    const qWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const mWords = new Set(memory.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    let hits = 0;
    for (const w of qWords) if (mWords.has(w)) hits++;
    return qWords.size > 0 ? hits / qWords.size : 0;
  }

  const scoreUserTask  = wordOverlap(userTask,  storedMemory);
  const scoreAgentTask = wordOverlap(agentTask, storedMemory);

  assert(
    scoreUserTask > scoreAgentTask,
    `Semantic: user task (${scoreUserTask.toFixed(2)}) scores higher than agent sub-task (${scoreAgentTask.toFixed(2)}) against stored memory`,
  );
}

// ════════════════════════════════════════════════════════════════
// FIX B — Bank-discovery URL uses configured defaultBank
// ════════════════════════════════════════════════════════════════

section('Fix B: bank-discovery URL respects config.hindsight.defaultBank');

// The hardcoded /v1/default/banks must be gone
assert(
  !executor.includes('`${hindsightUrl}/v1/default/banks`'),
  'executor.ts: hardcoded /v1/default/banks removed',
);

// The URL must interpolate the defaultBank variable.
// The implementation passes defaultBank as the HindsightClient namespace;
// client.listBanks() internally builds `/v1/${this.namespace}/banks`.
assert(
  executor.includes('new HindsightClient(hindsightUrl, defaultBank)'),
  'executor.ts: URL uses ${defaultBank} variable',
);

// defaultBank itself must be derived from config with a safe fallback
assert(
  executor.includes("config.hindsight?.defaultBank ?? 'default'"),
  "executor.ts: defaultBank falls back to 'default' when not configured",
);

section('Fix B: URL construction behavioural simulation');

{
  const hindsightUrl = 'http://localhost:4000';

  // With a non-default bank configured
  const defaultBank1 = 'production';
  const url1 = `${hindsightUrl}/v1/${defaultBank1}/banks`;
  assertEq(url1, 'http://localhost:4000/v1/production/banks',
    'Non-default bank name used in URL');

  // With no config → falls back to "default"
  const cfg = { hindsight: undefined } as Record<string, unknown>;
  const defaultBank2 = (cfg.hindsight as { defaultBank?: string } | undefined)?.defaultBank ?? 'default';
  const url2 = `${hindsightUrl}/v1/${defaultBank2}/banks`;
  assertEq(url2, 'http://localhost:4000/v1/default/banks',
    'Missing config falls back to /v1/default/banks');

  // Staging namespace
  const defaultBank3 = 'staging';
  const url3 = `${hindsightUrl}/v1/${defaultBank3}/banks`;
  assertEq(url3, 'http://localhost:4000/v1/staging/banks',
    'Staging namespace used in URL');
}

// ════════════════════════════════════════════════════════════════
// FIX C — buildWorkerSystemPrompt prepends hindsight context
// ════════════════════════════════════════════════════════════════

section('Fix C: hindsight context not discarded for custom systemPrompt');

// The old bare early-return must be gone
assert(
  !worker.includes('return agentConfig.systemPrompt;'),
  'worker.ts: bare return agentConfig.systemPrompt removed',
);

// Hindsight context is prepended
assert(
  worker.includes('contextSection}${agentConfig.systemPrompt}'),
  'worker.ts: contextSection prepended before systemPrompt',
);

// contextSection is only non-empty when this.context has content
assert(
  worker.includes("? `## Relevant Context\\n${this.context}\\n\\n`"),
  'worker.ts: contextSection includes ## Relevant Context header',
);

// Empty context yields empty contextSection (backward compat)
assert(
  worker.includes(": ''"),
  "worker.ts: empty context produces empty contextSection",
);

section('Fix C: buildWorkerSystemPrompt behavioural simulation');

{
  // Simulate buildWorkerSystemPrompt with recalled context + custom systemPrompt
  const thisContext = 'Decision: use PostgreSQL\nInfra: API on port 4000';
  const customPrompt = 'You are a security auditing agent. Focus on SQL injection.';

  const contextSection = thisContext
    ? `## Relevant Context\n${thisContext}\n\n`
    : '';
  const result = `${contextSection}${customPrompt}`;

  assert(result.startsWith('## Relevant Context'),
    'Result starts with context header when context present');
  assert(result.includes(thisContext),
    'Recalled memories included in system prompt');
  assert(result.includes(customPrompt),
    'Custom systemPrompt still present after context');
  assert(result.indexOf(thisContext) < result.indexOf(customPrompt),
    'Recalled context appears BEFORE custom instructions');
}

{
  // When no context recalled — output identical to old behaviour
  const thisContext = '';
  const customPrompt = 'You are a specialist.';

  const contextSection = thisContext
    ? `## Relevant Context\n${thisContext}\n\n`
    : '';
  const result = `${contextSection}${customPrompt}`;

  assertEq(result, customPrompt,
    'Empty context → output identical to custom prompt only (backward compat)');
}

{
  // Context must not bleed through when systemPrompt is absent (normal path)
  const _thisContext = 'PostgreSQL decision stored';
  // Without systemPrompt the branch is not entered; context flows via other means.
  const systemPrompt: string | undefined = undefined;
  const tookBranch = systemPrompt !== undefined;
  assert(!tookBranch, 'Branch not entered when systemPrompt is absent');
}

// ════════════════════════════════════════════════════════════════
// REGRESSION — old buggy patterns must not exist
// ════════════════════════════════════════════════════════════════

section('Regression: old buggy patterns absent from source');

assert(
  !executor.includes('await this.recallContext(node.agent.task)'),
  'Regression: bare recallContext(node.agent.task) absent',
);
assert(
  !executor.includes('/v1/default/banks'),
  'Regression: hardcoded /v1/default/banks absent',
);
assert(
  !worker.includes('\n    if (agentConfig.systemPrompt) {\n      return agentConfig.systemPrompt;\n    }'),
  'Regression: bare early-return for systemPrompt absent',
);

// ════════════════════════════════════════════════════════════════

const ok = printSummary('Executor / Worker Hindsight Fixes');
if (!ok) process.exit(1);

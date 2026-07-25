#!/usr/bin/env npx tsx
/**
 * Backfill script: stores all .md artifacts from existing completed runs
 * into memory. Run this once after deploying the run artifact collector
 * feature to ensure all historical run data is available for recall.
 *
 * Memory is self-hosted Redis (`RedisMemoryStore`). Redis is expected to be
 * already running at redis://localhost:6379 — this script does not provision
 * it. Override with REDIS_URL.
 *
 * Usage:
 *   npx tsx scripts/backfill-run-artifacts.ts [--dry-run] [--scope SCOPE_ID] [--limit N]
 *
 * Options:
 *   --dry-run    Scan and report what would be stored without actually storing
 *   --scope ID   Target memory scope (default: 'core')
 *   --limit N    Process at most N runs (default: all)
 *   --run-id ID  Process only a specific run ID
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RedisMemoryStore } from '../packages/core/src/memory/redis-store.js';
import type { MemoryStore } from '../packages/core/src/memory/store.js';
import { RunArtifactCollector } from '../packages/core/src/memory/run-artifact-collector.js';

// ── Parse CLI args ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const scopeIdx = args.indexOf('--scope');
const scopeId = scopeIdx >= 0 && args[scopeIdx + 1] ? args[scopeIdx + 1] : 'core';
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : Infinity;
const runIdIdx = args.indexOf('--run-id');
const specificRunId = runIdIdx >= 0 && args[runIdIdx + 1] ? args[runIdIdx + 1] : null;

// ── Config ────────────────────────────────────────────────────────────

const WORKSPACE_OUTPUT = process.env.WORKSPACE_OUTPUT ?? '/home/kali/orionomega/workspace/output';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// UUID pattern for run directories
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🔄 Run Artifact Backfill');
  console.log(`   Workspace: ${WORKSPACE_OUTPUT}`);
  console.log(`   Redis: ${REDIS_URL}`);
  console.log(`   Scope: ${scopeId}`);
  console.log(`   Dry run: ${dryRun}`);
  if (specificRunId) console.log(`   Specific run: ${specificRunId}`);
  if (limit < Infinity) console.log(`   Limit: ${limit}`);
  console.log('');

  if (!existsSync(WORKSPACE_OUTPUT)) {
    console.error(`❌ Workspace output directory not found: ${WORKSPACE_OUTPUT}`);
    process.exit(1);
  }

  // Find all run directories (UUID-named directories)
  let runDirs: string[];
  if (specificRunId) {
    const runDir = join(WORKSPACE_OUTPUT, specificRunId);
    if (!existsSync(runDir)) {
      console.error(`❌ Run directory not found: ${runDir}`);
      process.exit(1);
    }
    runDirs = [specificRunId];
  } else {
    runDirs = readdirSync(WORKSPACE_OUTPUT)
      .filter(name => UUID_PATTERN.test(name))
      .filter(name => {
        const fullPath = join(WORKSPACE_OUTPUT, name);
        try { return statSync(fullPath).isDirectory(); } catch { return false; }
      })
      .slice(0, limit);
  }

  console.log(`📂 Found ${runDirs.length} run directories\n`);

  if (runDirs.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  // Open the memory store (or a mock for dry run)
  let store: MemoryStore;
  let redisStore: RedisMemoryStore | null = null;
  if (dryRun) {
    // Create a mock store that just counts
    store = {
      retainOne: async () => ({ ok: true, count: 1 }),
    } as unknown as MemoryStore;
  } else {
    redisStore = new RedisMemoryStore({ redis: { url: REDIS_URL } });
    store = redisStore;
    // Verify connection — Redis is expected to be running already.
    const health = await store.health();
    if (!health.healthy) {
      console.error(`❌ Cannot connect to Redis at ${REDIS_URL}`);
      process.exit(1);
    }
    console.log('✅ Redis connected\n');
  }

  const collector = new RunArtifactCollector({
    store,
    bankId: scopeId,
  });

  // Process each run
  let totalFiles = 0;
  let totalItems = 0;
  let totalTokens = 0;
  let totalErrors = 0;
  let runsProcessed = 0;
  let runsSkipped = 0;

  for (const runId of runDirs) {
    const runDir = join(WORKSPACE_OUTPUT, runId);

    // Try to read the run summary to get the task description
    let taskSummary = 'Unknown task';
    try {
      const summaryPath = join(runDir, 'run-summary.json');
      if (existsSync(summaryPath)) {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        taskSummary = summary.taskSummary ?? summary.task ?? 'Unknown task';
      } else {
        // Try to read from run-summary.md
        const mdPath = join(runDir, 'run-summary.md');
        if (existsSync(mdPath)) {
          const md = readFileSync(mdPath, 'utf-8');
          const titleMatch = md.match(/^# Run Summary:\s*(.+)$/m);
          if (titleMatch) taskSummary = titleMatch[1].trim();
        }
      }
    } catch { /* ignore */ }

    process.stdout.write(`  [${runsProcessed + 1}/${runDirs.length}] ${runId} — ${taskSummary.slice(0, 60)}...`);

    try {
      const result = await collector.collectAndStore(runId, runDir, taskSummary);

      if (result.filesFound === 0) {
        console.log(' (no .md files, skipped)');
        runsSkipped++;
      } else {
        console.log(` ✅ ${result.itemsStored} records, ${result.totalTokens} tokens${result.budgetExhausted ? ' (budget exhausted)' : ''}`);
        totalFiles += result.filesFound;
        totalItems += result.itemsStored;
        totalTokens += result.totalTokens;
        totalErrors += result.errors.length;
      }
    } catch (err) {
      console.log(` ❌ ${err instanceof Error ? err.message : String(err)}`);
      totalErrors++;
    }

    runsProcessed++;
  }

  console.log('\n' + '─'.repeat(60));
  console.log('📊 Backfill Summary');
  console.log(`   Runs processed: ${runsProcessed}`);
  console.log(`   Runs skipped: ${runsSkipped}`);
  console.log(`   Files found: ${totalFiles}`);
  console.log(`   Records stored: ${totalItems}`);
  console.log(`   Total tokens: ${totalTokens}`);
  console.log(`   Errors: ${totalErrors}`);
  if (dryRun) console.log('\n   ⚠️  DRY RUN — nothing was actually stored');

  await redisStore?.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

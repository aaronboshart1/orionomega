/**
 * Tests for RunArtifactCollector — verifies that .md files from completed
 * runs are properly scanned, chunked, and stored to Hindsight memory.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RunArtifactCollector } from '../packages/core/src/memory/run-artifact-collector.js';
import type { RunArtifactCollectorConfig } from '../packages/core/src/memory/run-artifact-collector.js';

// ── Mock HindsightClient ──────────────────────────────────────────────

interface StoredItem {
  bankId: string;
  content: string;
  context: string;
}

class MockHindsightClient {
  storedItems: StoredItem[] = [];
  failOnRetain = false;

  async retainOne(bankId: string, content: string, context: string) {
    if (this.failOnRetain) {
      throw new Error('Simulated retain failure');
    }
    this.storedItems.push({ bankId, content, context });
    return { success: true, bank_id: bankId, items_count: 1 };
  }
}

// ── Test helpers ──────────────────────────────────────────────────────

const TEST_DIR = '/tmp/run-artifact-collector-test';
const RUN_ID = 'test-run-12345678';

function setupTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

function createTestFile(relativePath: string, content: string) {
  const fullPath = join(TEST_DIR, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

// ── Tests ─────────────────────────────────────────────────────────────

async function testBasicCollection() {
  setupTestDir();
  const mock = new MockHindsightClient();

  createTestFile('run-summary.md', '# Run Summary\n\nThis is a test run summary with enough content to pass the minimum threshold.');
  createTestFile('analyze-codebase/output.md', '# Analysis\n\nThe codebase uses TypeScript with Node.js runtime. Found 15 source files.');
  createTestFile('implement-changes/output.md', '# Implementation\n\nAdded new feature X with proper error handling and tests.');

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    minContentChars: 20,
  });

  const result = await collector.collectAndStore(RUN_ID, TEST_DIR, 'Test task summary');

  console.assert(result.filesFound === 3, `Expected 3 files found, got ${result.filesFound}`);
  console.assert(result.itemsStored >= 3, `Expected at least 3 items stored (3 files + manifest), got ${result.itemsStored}`);
  console.assert(result.filesSkipped === 0, `Expected 0 files skipped, got ${result.filesSkipped}`);
  console.assert(result.errors.length === 0, `Expected 0 errors, got ${result.errors.length}`);

  // Verify all stored items have the correct bank
  for (const item of mock.storedItems) {
    console.assert(item.bankId === 'test-bank', `Expected bank 'test-bank', got '${item.bankId}'`);
  }

  // Verify run_artifact context type
  const artifacts = mock.storedItems.filter(i => i.context === 'run_artifact');
  console.assert(artifacts.length === 3, `Expected 3 run_artifact items, got ${artifacts.length}`);

  // Verify manifest
  const manifests = mock.storedItems.filter(i => i.context === 'run_manifest');
  console.assert(manifests.length === 1, `Expected 1 run_manifest item, got ${manifests.length}`);
  console.assert(manifests[0].content.includes(RUN_ID), 'Manifest should contain run ID');

  // Verify run ID is in each artifact's content
  for (const artifact of artifacts) {
    console.assert(artifact.content.includes(`[Run: ${RUN_ID}]`), 'Artifact should contain run ID header');
  }

  console.log('✅ testBasicCollection passed');
  cleanupTestDir();
}

async function testPrioritization() {
  setupTestDir();
  const mock = new MockHindsightClient();

  // Create files in reverse priority order
  createTestFile('other-report.md', '# Other Report\n\nThis is a supplementary report with enough content.');
  createTestFile('analyze/output.md', '# Node Output\n\nThis is a node output with analysis details.');
  createTestFile('run-summary.md', '# Run Summary\n\nThis is the main run summary with task overview.');

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    minContentChars: 20,
  });

  await collector.collectAndStore(RUN_ID, TEST_DIR, 'Test prioritization');

  // Verify run-summary.md is stored first
  const artifacts = mock.storedItems.filter(i => i.context === 'run_artifact');
  console.assert(artifacts[0].content.includes('[Node: run-summary]'), 'First stored artifact should be run-summary');

  console.log('✅ testPrioritization passed');
  cleanupTestDir();
}

async function testSkipsSmallFiles() {
  setupTestDir();
  const mock = new MockHindsightClient();

  createTestFile('tiny.md', 'Hi');  // Too small
  createTestFile('good.md', '# Good File\n\nThis has enough content to be meaningful and stored.');

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    minContentChars: 50,
  });

  const result = await collector.collectAndStore(RUN_ID, TEST_DIR, 'Test small files');

  console.assert(result.filesFound === 2, `Expected 2 files found, got ${result.filesFound}`);
  console.assert(result.filesSkipped === 1, `Expected 1 file skipped, got ${result.filesSkipped}`);

  const artifacts = mock.storedItems.filter(i => i.context === 'run_artifact');
  console.assert(artifacts.length === 1, `Expected 1 artifact stored, got ${artifacts.length}`);

  console.log('✅ testSkipsSmallFiles passed');
  cleanupTestDir();
}

async function testSkipsNodeModules() {
  setupTestDir();
  const mock = new MockHindsightClient();

  createTestFile('good.md', '# Good File\n\nThis has enough content to be meaningful.');
  createTestFile('node_modules/some-package/README.md', '# Package README\n\nThis should be skipped.');

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    minContentChars: 20,
  });

  const result = await collector.collectAndStore(RUN_ID, TEST_DIR, 'Test node_modules skip');

  console.assert(result.filesFound === 1, `Expected 1 file found (node_modules skipped), got ${result.filesFound}`);

  console.log('✅ testSkipsNodeModules passed');
  cleanupTestDir();
}

async function testChunking() {
  setupTestDir();
  const mock = new MockHindsightClient();

  // Create a large file that should be chunked
  const sections = [];
  for (let i = 0; i < 20; i++) {
    sections.push(`## Section ${i + 1}\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(50)}`);
  }
  createTestFile('large-report.md', sections.join('\n\n'));

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    maxChunkTokens: 512,  // Small chunk size to force chunking
    minContentChars: 20,
  });

  await collector.collectAndStore(RUN_ID, TEST_DIR, 'Test chunking');

  const artifacts = mock.storedItems.filter(i => i.context === 'run_artifact');
  console.assert(artifacts.length > 1, `Expected multiple chunks, got ${artifacts.length}`);

  // Verify each chunk has the run ID header
  for (const artifact of artifacts) {
    console.assert(artifact.content.includes(`[Run: ${RUN_ID}]`), 'Each chunk should contain run ID header');
  }

  console.log('✅ testChunking passed');
  cleanupTestDir();
}

async function testTokenBudgetExhaustion() {
  setupTestDir();
  const mock = new MockHindsightClient();

  // Create many files
  for (let i = 0; i < 10; i++) {
    createTestFile(`node-${i}/output.md`, `# Node ${i} Output\n\n${'Detailed analysis content. '.repeat(100)}`);
  }

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    maxTotalTokensPerRun: 2000,  // Small budget — enough for ~2-3 files but not all 10
    minContentChars: 20,
  });

  const result = await collector.collectAndStore(RUN_ID, TEST_DIR, 'Test budget exhaustion');

  console.assert(result.budgetExhausted === true, 'Budget should be exhausted');
  console.assert(result.filesSkipped > 0, `Expected some files skipped, got ${result.filesSkipped}`);

  console.log('✅ testTokenBudgetExhaustion passed');
  cleanupTestDir();
}

async function testRetainFailures() {
  setupTestDir();
  const mock = new MockHindsightClient();
  mock.failOnRetain = true;

  createTestFile('report.md', '# Report\n\nThis report should fail to store but not crash.');

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    minContentChars: 20,
  });

  const result = await collector.collectAndStore(RUN_ID, TEST_DIR, 'Test retain failures');

  console.assert(result.errors.length > 0, `Expected errors, got ${result.errors.length}`);
  console.assert(result.itemsStored === 0, `Expected 0 items stored, got ${result.itemsStored}`);

  console.log('✅ testRetainFailures passed');
  cleanupTestDir();
}

async function testNonexistentRunDir() {
  const mock = new MockHindsightClient();

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
  });

  const result = await collector.collectAndStore(RUN_ID, '/tmp/nonexistent-dir-12345', 'Test nonexistent dir');

  console.assert(result.filesFound === 0, `Expected 0 files found, got ${result.filesFound}`);
  console.assert(result.itemsStored === 0, `Expected 0 items stored, got ${result.itemsStored}`);

  console.log('✅ testNonexistentRunDir passed');
}

async function testNodeLabelExtraction() {
  setupTestDir();
  const mock = new MockHindsightClient();

  createTestFile('analyze-codebase/output.md', '# Analysis\n\nDetailed codebase analysis with enough content to store.');
  createTestFile('impl-changes/subdir/report.md', '# Sub Report\n\nNested report with enough content to be stored.');
  createTestFile('top-level-report.md', '# Top Level\n\nTop-level report not in a subdirectory with content.');

  const collector = new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    minContentChars: 20,
  });

  await collector.collectAndStore(RUN_ID, TEST_DIR, 'Test node label extraction');

  const artifacts = mock.storedItems.filter(i => i.context === 'run_artifact');

  const hasAnalyze = artifacts.some(a => a.content.includes('[Node: analyze-codebase]'));
  const hasImpl = artifacts.some(a => a.content.includes('[Node: impl-changes]'));
  const hasTopLevel = artifacts.some(a => a.content.includes('[Node: top-level-report]'));

  console.assert(hasAnalyze, 'Should have analyze-codebase node label');
  console.assert(hasImpl, 'Should have impl-changes node label');
  console.assert(hasTopLevel, 'Should have top-level-report node label');

  console.log('✅ testNodeLabelExtraction passed');
  cleanupTestDir();
}

// ── Runner ────────────────────────────────────────────────────────────

async function main() {
  console.log('🧪 RunArtifactCollector Tests\n');

  try {
    await testBasicCollection();
    await testPrioritization();
    await testSkipsSmallFiles();
    await testSkipsNodeModules();
    await testChunking();
    await testTokenBudgetExhaustion();
    await testRetainFailures();
    await testNonexistentRunDir();
    await testNodeLabelExtraction();

    console.log('\n✅ All RunArtifactCollector tests passed!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
}

main();

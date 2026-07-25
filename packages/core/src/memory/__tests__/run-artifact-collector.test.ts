/**
 * @module __tests__/run-artifact-collector
 * Tests for RunArtifactCollector — verifies that .md files from completed runs
 * are scanned, prioritized, chunked, budgeted, and stored to Hindsight memory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { RunArtifactCollector } from '../run-artifact-collector.js';
import type { RunArtifactCollectorConfig } from '../run-artifact-collector.js';

const RUN_ID = 'test-run-12345678';

interface StoredItem {
  bankId: string;
  content: string;
  context: string;
}

class MockHindsightClient {
  storedItems: StoredItem[] = [];
  failOnRetain = false;

  async retainOne(bankId: string, content: string, context: string) {
    if (this.failOnRetain) throw new Error('Simulated retain failure');
    this.storedItems.push({ bankId, content, context });
    return { success: true, bank_id: bankId, items_count: 1 };
  }
}

let testDir: string;
let mock: MockHindsightClient;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'run-artifact-collector-test-'));
  mock = new MockHindsightClient();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function createTestFile(relativePath: string, content: string) {
  const fullPath = join(testDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

function makeCollector(overrides: Partial<RunArtifactCollectorConfig> = {}) {
  return new RunArtifactCollector({
    hindsight: mock as unknown as RunArtifactCollectorConfig['hindsight'],
    bankId: 'test-bank',
    minContentChars: 20,
    ...overrides,
  });
}

const artifactsOf = () => mock.storedItems.filter((i) => i.context === 'run_artifact');

describe('RunArtifactCollector — basic collection', () => {
  it('stores every .md file plus a manifest, tagged with the run ID and bank', async () => {
    createTestFile('run-summary.md', '# Run Summary\n\nThis is a test run summary with enough content to pass the minimum threshold.');
    createTestFile('analyze-codebase/output.md', '# Analysis\n\nThe codebase uses TypeScript with Node.js runtime. Found 15 source files.');
    createTestFile('implement-changes/output.md', '# Implementation\n\nAdded new feature X with proper error handling and tests.');

    const result = await makeCollector().collectAndStore(RUN_ID, testDir, 'Test task summary');

    expect(result.filesFound).toBe(3);
    expect(result.itemsStored).toBeGreaterThanOrEqual(3);
    expect(result.filesSkipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    expect(mock.storedItems.every((i) => i.bankId === 'test-bank')).toBe(true);
    expect(artifactsOf()).toHaveLength(3);

    const manifests = mock.storedItems.filter((i) => i.context === 'run_manifest');
    expect(manifests).toHaveLength(1);
    expect(manifests[0].content).toContain(RUN_ID);

    for (const artifact of artifactsOf()) {
      expect(artifact.content).toContain(`[Run: ${RUN_ID}]`);
    }
  });
});

describe('RunArtifactCollector — prioritization', () => {
  it('stores run-summary.md first regardless of discovery order', async () => {
    createTestFile('other-report.md', '# Other Report\n\nThis is a supplementary report with enough content.');
    createTestFile('analyze/output.md', '# Node Output\n\nThis is a node output with analysis details.');
    createTestFile('run-summary.md', '# Run Summary\n\nThis is the main run summary with task overview.');

    await makeCollector().collectAndStore(RUN_ID, testDir, 'Test prioritization');

    expect(artifactsOf()[0].content).toContain('[Node: run-summary]');
  });
});

describe('RunArtifactCollector — filtering', () => {
  it('skips files below the minimum content threshold', async () => {
    createTestFile('tiny.md', 'Hi');
    createTestFile('good.md', '# Good File\n\nThis has enough content to be meaningful and stored.');

    const result = await makeCollector({ minContentChars: 50 })
      .collectAndStore(RUN_ID, testDir, 'Test small files');

    expect(result.filesFound).toBe(2);
    expect(result.filesSkipped).toBe(1);
    expect(artifactsOf()).toHaveLength(1);
  });

  it('does not descend into node_modules', async () => {
    createTestFile('good.md', '# Good File\n\nThis has enough content to be meaningful.');
    createTestFile('node_modules/some-package/README.md', '# Package README\n\nThis should be skipped.');

    const result = await makeCollector().collectAndStore(RUN_ID, testDir, 'Test node_modules skip');

    expect(result.filesFound).toBe(1);
  });
});

describe('RunArtifactCollector — chunking', () => {
  it('splits a large report into multiple chunks, each carrying the run ID header', async () => {
    const sections = Array.from({ length: 20 }, (_, i) =>
      `## Section ${i + 1}\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(50)}`);
    createTestFile('large-report.md', sections.join('\n\n'));

    await makeCollector({ maxChunkTokens: 512 }).collectAndStore(RUN_ID, testDir, 'Test chunking');

    const artifacts = artifactsOf();
    expect(artifacts.length).toBeGreaterThan(1);
    for (const artifact of artifacts) {
      expect(artifact.content).toContain(`[Run: ${RUN_ID}]`);
    }
  });
});

describe('RunArtifactCollector — token budget', () => {
  it('stops collecting once the per-run token budget is exhausted', async () => {
    for (let i = 0; i < 10; i++) {
      createTestFile(`node-${i}/output.md`, `# Node ${i} Output\n\n${'Detailed analysis content. '.repeat(100)}`);
    }

    const result = await makeCollector({ maxTotalTokensPerRun: 2000 })
      .collectAndStore(RUN_ID, testDir, 'Test budget exhaustion');

    expect(result.budgetExhausted).toBe(true);
    expect(result.filesSkipped).toBeGreaterThan(0);
  });
});

describe('RunArtifactCollector — failure handling', () => {
  it('records a retain failure as an error without throwing', async () => {
    mock.failOnRetain = true;
    createTestFile('report.md', '# Report\n\nThis report should fail to store but not crash.');

    const result = await makeCollector().collectAndStore(RUN_ID, testDir, 'Test retain failures');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.itemsStored).toBe(0);
  });

  it('returns an empty result for a run directory that does not exist', async () => {
    const result = await makeCollector()
      .collectAndStore(RUN_ID, join(testDir, 'nonexistent-dir-12345'), 'Test nonexistent dir');

    expect(result.filesFound).toBe(0);
    expect(result.itemsStored).toBe(0);
  });
});

describe('RunArtifactCollector — node label extraction', () => {
  it('labels artifacts by their containing node directory, or filename at top level', async () => {
    createTestFile('analyze-codebase/output.md', '# Analysis\n\nDetailed codebase analysis with enough content to store.');
    createTestFile('impl-changes/subdir/report.md', '# Sub Report\n\nNested report with enough content to be stored.');
    createTestFile('top-level-report.md', '# Top Level\n\nTop-level report not in a subdirectory with content.');

    await makeCollector().collectAndStore(RUN_ID, testDir, 'Test node label extraction');

    const contents = artifactsOf().map((a) => a.content);
    expect(contents.some((c) => c.includes('[Node: analyze-codebase]'))).toBe(true);
    expect(contents.some((c) => c.includes('[Node: impl-changes]'))).toBe(true);
    expect(contents.some((c) => c.includes('[Node: top-level-report]'))).toBe(true);
  });
});

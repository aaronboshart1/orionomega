/**
 * @module orchestration/__tests__/e2e-happy-path
 *
 * Task #236 — One happy-path end-to-end test.
 *
 * Exercises the real orchestration pipeline with NO Anthropic API key:
 * a prompt is modelled as a single real TOOL node whose shell command
 * produces output, run through the genuine `buildGraph` → `GraphExecutor`
 * → `WorkerProcess` → artifact chain over a real `EventBus`.
 *
 * Asserts the contract that the rest of the system relies on:
 *   1. The run completes with `status: 'complete'`.
 *   2. The worker actually executed the command (node output captured).
 *   3. The per-node `stdout.txt` artifact is written to disk.
 *   4. The run-summary artifacts (`run-summary.md` / `.json`) are written
 *      into the run directory and the JSON round-trips the result.
 *   5. The EventBus delivered the worker lifecycle events (status + done).
 *
 * This deliberately avoids AGENT / CODING_AGENT nodes (which need the
 * Claude Agent SDK + an API key) so it is hermetic and fast.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GraphExecutor, type ExecutorConfig } from '../executor.js';
import { EventBus } from '../event-bus.js';
import { buildGraph } from '../graph.js';
import type { WorkflowNode, WorkerEvent } from '../types.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('E2E happy path: prompt → gateway → core → worker → artifact', () => {
  let workspaceDir: string;
  let runsDir: string;
  let checkpointDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'e2e-ws-'));
    runsDir = mkdtempSync(join(tmpdir(), 'e2e-runs-'));
    checkpointDir = mkdtempSync(join(tmpdir(), 'e2e-cp-'));
  });

  afterEach(() => {
    for (const dir of [workspaceDir, runsDir, checkpointDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort cleanup */
      }
    }
  });

  it('runs a single TOOL node end-to-end and writes run artifacts', async () => {
    const marker = 'orionomega-e2e-ok';

    // A prompt, reduced to its simplest executable form: one TOOL node
    // whose single `command` param is run by the real WorkerProcess.
    const nodes: WorkflowNode[] = [
      {
        id: 'echo-step',
        type: 'TOOL',
        label: 'Echo a marker to stdout',
        dependsOn: [],
        status: 'pending',
        tool: {
          name: 'bash',
          params: { command: `echo ${marker}` },
        },
      },
    ];

    const graph = buildGraph(nodes, 'e2e-happy-path');
    const bus = new EventBus();

    // Capture every event delivered for this workflow over the bus.
    const events: WorkerEvent[] = [];
    bus.subscribe('*', (event) => {
      events.push(event);
    });

    const config: ExecutorConfig = {
      workspaceDir,
      runsDir,
      checkpointDir,
      workerTimeout: 30,
      maxRetries: 0,
      checkpointInterval: 1,
    };

    const executor = new GraphExecutor(graph, bus, config);
    const result = await executor.execute();

    // 1. The whole run completed successfully.
    expect(result.status).toBe('complete');
    expect(result.workflowId).toBe(graph.id);
    expect(result.workerCount).toBe(1);

    // 2. The worker actually ran the command and captured its output.
    expect(result.nodeOutputs?.['echo-step'] ?? '').toContain(marker);
    const finishedNode = graph.nodes.get('echo-step');
    expect(finishedNode?.status).toBe('done');

    // 3. The per-node stdout artifact was written to disk under the run dir.
    const runDir = join(runsDir, graph.id);
    const stdoutPath = join(runDir, 'echo-step', 'stdout.txt');
    expect(existsSync(stdoutPath)).toBe(true);
    expect(readFileSync(stdoutPath, 'utf-8')).toContain(marker);

    // 4. The run-summary artifacts exist and the JSON round-trips.
    const mdPath = join(runDir, 'run-summary.md');
    const jsonPath = join(runDir, 'run-summary.json');
    expect(existsSync(mdPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    expect(readFileSync(mdPath, 'utf-8')).toContain('# Run Summary');
    const summary = JSON.parse(readFileSync(jsonPath, 'utf-8')) as {
      status: string;
      workflowId: string;
    };
    expect(summary.status).toBe('complete');
    expect(summary.workflowId).toBe(graph.id);

    // 5. The EventBus delivered worker lifecycle events for this node.
    const nodeEvents = events.filter((e) => e.nodeId === 'echo-step');
    expect(nodeEvents.length).toBeGreaterThan(0);
    expect(nodeEvents.some((e) => e.type === 'done')).toBe(true);
  });
});

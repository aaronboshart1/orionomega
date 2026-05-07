/**
 * @module orchestration/__tests__/executor-staged-attachments
 *
 * Task #192 — proves that AGENT, TOOL, and CODING_AGENT workers each
 * receive the staged-attachments listing (absolute path / MIME / size)
 * via the executor's per-node context-injection, independent of any
 * planner-preamble propagation.
 *
 * We mock `WorkerProcess` (used by AGENT/TOOL) and `executeCodingAgent`
 * (used by CODING_AGENT) to capture the strings the executor passes,
 * then construct a 3-node graph and execute each node directly via the
 * executor's private `executeNodeByType` helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Capture the worker context passed for each WorkerProcess invocation.
const workerContexts: Array<{ nodeId: string; nodeType: string; context: string | undefined }> = [];
vi.mock('../worker.js', () => {
  return {
    WorkerProcess: class {
      private nodeId: string;
      private nodeType: string;
      private ctx: string | undefined;
      constructor(node: { id: string; type: string }, _bus: unknown, options: { context?: string }) {
        this.nodeId = node.id;
        this.nodeType = node.type;
        this.ctx = options.context;
        workerContexts.push({ nodeId: this.nodeId, nodeType: this.nodeType, context: this.ctx });
      }
      async run() {
        return { nodeId: this.nodeId, success: true, output: 'stub' };
      }
    },
  };
});

// Capture CODING_AGENT task strings.
const codingTasks: Array<{ nodeId: string; task: string }> = [];
vi.mock('../agent-sdk-bridge.js', () => ({
  executeCodingAgent: async (node: { id: string; codingAgent?: { task?: string } }) => {
    codingTasks.push({ nodeId: node.id, task: node.codingAgent?.task ?? '' });
    return { output: 'coding-stub', toolCalls: 0, success: true };
  },
}));

const { GraphExecutor } = await import('../executor.js');
const { EventBus } = await import('../event-bus.js');

const STAGED = [
  { name: 'data.csv', absPath: '/abs/_attachments/data.csv', mimeType: 'text/csv', size: 24 },
  { name: 'pic.png', absPath: '/abs/_attachments/pic.png', mimeType: 'image/png', size: 70 },
];

let workspaceDir: string;
beforeEach(() => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'oo-exec-stage-'));
  workerContexts.length = 0;
  codingTasks.length = 0;
});

function makeGraph(nodes: Array<{ id: string; type: 'AGENT' | 'TOOL' | 'CODING_AGENT'; task?: string }>) {
  const map = new Map();
  for (const n of nodes) {
    map.set(n.id, {
      id: n.id,
      type: n.type,
      label: n.id,
      dependsOn: [],
      ...(n.type === 'AGENT' ? { agent: { task: n.task ?? `${n.id} task` } } : {}),
      ...(n.type === 'CODING_AGENT' ? { codingAgent: { task: n.task ?? `${n.id} task` } } : {}),
      ...(n.type === 'TOOL' ? { tool: { command: 'echo hello' } } : {}),
    });
  }
  return { id: 'g1', nodes: map, dependencies: new Map(), entryNodes: [], terminalNodes: [] };
}

describe('Task #192 — executor injects staged-attachments paths into AGENT, TOOL, and CODING_AGENT', () => {
  it('AGENT injectedContext starts with the staged-attachments block', async () => {
    const graph = makeGraph([{ id: 'a1', type: 'AGENT', task: 'analyse the file' }]);
    const exec = new GraphExecutor(
      graph as never,
      new EventBus(),
      
      {
        workspaceDir,
        checkpointDir: path.join(workspaceDir, 'checkpoints'),
        workerTimeout: 1,
        maxRetries: 0,
        checkpointInterval: 1,
        stagedAttachments: STAGED,
      } as never,
    );
    await (exec as unknown as { executeNodeByType: (n: unknown) => Promise<unknown> }).executeNodeByType(graph.nodes.get('a1'));
    const captured = workerContexts.find((w) => w.nodeId === 'a1');
    expect(captured).toBeDefined();
    expect(captured!.context).toContain('Attached files (staged on disk');
    expect(captured!.context).toContain('/abs/_attachments/data.csv');
    expect(captured!.context).toContain('mime: image/png');
    // Block sits at the very top of the injected context (after the
    // markdown heading prefix), before any upstream/memory sections.
    expect(captured!.context!.startsWith('## Attached files')).toBe(true);
  });

  it('TOOL injectedContext is set to the staged-attachments block', async () => {
    const graph = makeGraph([{ id: 't1', type: 'TOOL' }]);
    const exec = new GraphExecutor(
      graph as never,
      new EventBus(),
      
      {
        workspaceDir,
        checkpointDir: path.join(workspaceDir, "checkpoints"),
        workerTimeout: 1,
        maxRetries: 0,
        checkpointInterval: 1,
        stagedAttachments: STAGED,
      } as never,
    );
    await (exec as unknown as { executeNodeByType: (n: unknown) => Promise<unknown> }).executeNodeByType(graph.nodes.get('t1'));
    const captured = workerContexts.find((w) => w.nodeId === 't1');
    expect(captured).toBeDefined();
    expect(captured!.context).toContain('Attached files (staged on disk');
    expect(captured!.context).toContain('/abs/_attachments/data.csv');
    expect(captured!.context).toContain('/abs/_attachments/pic.png');
  });

  it('CODING_AGENT task is prepended with the staged-attachments block', async () => {
    const graph = makeGraph([{ id: 'c1', type: 'CODING_AGENT', task: 'add a parser' }]);
    const exec = new GraphExecutor(
      graph as never,
      new EventBus(),
      
      {
        workspaceDir,
        checkpointDir: path.join(workspaceDir, "checkpoints"),
        workerTimeout: 1,
        maxRetries: 0,
        checkpointInterval: 1,
        stagedAttachments: STAGED,
      } as never,
    );
    await (exec as unknown as { executeNodeByType: (n: unknown) => Promise<unknown> }).executeNodeByType(graph.nodes.get('c1'));
    const captured = codingTasks.find((c) => c.nodeId === 'c1');
    expect(captured).toBeDefined();
    expect(captured!.task).toContain('Attached files (staged on disk');
    expect(captured!.task).toContain('/abs/_attachments/data.csv');
    expect(captured!.task).toContain('add a parser');
    // Block precedes the original task body.
    expect(captured!.task.indexOf('Attached files')).toBeLessThan(captured!.task.indexOf('add a parser'));
  });

  it('omits the staged block entirely when stagedAttachments is empty/undefined', async () => {
    const graph = makeGraph([
      { id: 'a2', type: 'AGENT', task: 'no attachments' },
      { id: 't2', type: 'TOOL' },
    ]);
    const exec = new GraphExecutor(
      graph as never,
      new EventBus(),
      
      {
        workspaceDir,
        checkpointDir: path.join(workspaceDir, "checkpoints"),
        workerTimeout: 1,
        maxRetries: 0,
        checkpointInterval: 1,
      } as never,
    );
    await (exec as unknown as { executeNodeByType: (n: unknown) => Promise<unknown> }).executeNodeByType(graph.nodes.get('a2'));
    await (exec as unknown as { executeNodeByType: (n: unknown) => Promise<unknown> }).executeNodeByType(graph.nodes.get('t2'));
    for (const c of workerContexts) {
      expect(c.context ?? '').not.toContain('Attached files (staged on disk');
    }
  });
});

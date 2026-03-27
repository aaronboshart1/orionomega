import { create } from 'zustand';

export interface WorkerEvent {
  workerId: string;
  nodeId: string;
  timestamp: string;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'finding' | 'status' | 'error' | 'done';
  tool?: { name: string; action?: string; file?: string; summary: string };
  thinking?: string;
  progress?: number;
  message?: string;
  data?: unknown;
  error?: string;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  status: string;
  progress?: number;
  agent?: { model: string; task: string };
  dependsOn: string[];
  output?: unknown;
}

export interface GraphState {
  workflowId: string;
  name: string;
  status: string;
  elapsed: number;
  nodes: Record<string, GraphNode>;
  recentEvents: WorkerEvent[];
  completedLayers: number;
  totalLayers: number;
}

export interface PlanData {
  id: string;
  reasoning: string;
  estimatedCost: number;
  estimatedTime: number;
  summary: string;
  graph: { nodes: Record<string, GraphNode> };
}

export type InlineDAGStatus = 'dispatched' | 'running' | 'complete' | 'error' | 'stopped';

export interface InlineDAGNode {
  id: string;
  label: string;
  type: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  progress?: number;
  output?: string;
}

export interface ModelUsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  workerCount: number;
  costUsd: number;
}

export interface InlineDAG {
  dagId: string;
  summary: string;
  status: InlineDAGStatus;
  nodes: InlineDAGNode[];
  completedCount: number;
  totalCount: number;
  elapsed: number;
  result?: string;
  error?: string;
  durationSec?: number;
  workerCount?: number;
  totalCostUsd?: number;
  toolCallCount?: number;
  modelUsage?: ModelUsageEntry[];
  nodeOutputPaths?: Record<string, string[]>;
}

export interface DAGConfirmation {
  dagId: string;
  summary: string;
  reason: string;
  guardedNodes: { id: string; label: string; risk: string }[];
}

export interface WorkflowData {
  graphState: GraphState | null;
  events: WorkerEvent[];
}

interface OrchestrationStore {
  workflows: Record<string, WorkflowData>;
  activeWorkflowId: string | null;
  activePlan: PlanData | null;
  selectedWorker: string | null;
  inlineDAGs: Record<string, InlineDAG>;
  pendingConfirmation: DAGConfirmation | null;

  graphState: GraphState | null;
  events: WorkerEvent[];

  setActiveWorkflowId: (id: string | null) => void;
  removeWorkflow: (id: string) => void;
  setGraphState: (s: GraphState) => void;
  addEvent: (e: WorkerEvent, workflowId?: string) => void;
  setActivePlan: (p: PlanData | null) => void;
  selectWorker: (id: string | null) => void;
  upsertInlineDAG: (dag: InlineDAG) => void;
  updateDAGNode: (dagId: string, nodeId: string, update: Partial<InlineDAGNode>) => void;
  completeDAG: (dagId: string, result?: string, error?: string, stats?: { durationSec?: number; workerCount?: number; totalCostUsd?: number; toolCallCount?: number; modelUsage?: ModelUsageEntry[]; nodeOutputPaths?: Record<string, string[]>; stopped?: boolean }) => void;
  removeInlineDAG: (dagId: string) => void;
  setPendingConfirmation: (c: DAGConfirmation | null) => void;
  reset: () => void;
}

function deriveActive(workflows: Record<string, WorkflowData>, activeWorkflowId: string | null) {
  const data = activeWorkflowId ? workflows[activeWorkflowId] : undefined;
  return {
    graphState: data?.graphState ?? null,
    events: data?.events ?? [],
  };
}

export const useOrchestrationStore = create<OrchestrationStore>((set) => ({
  workflows: {},
  activeWorkflowId: null,
  activePlan: null,
  selectedWorker: null,
  inlineDAGs: {},
  pendingConfirmation: null,
  graphState: null,
  events: [],

  setActiveWorkflowId: (id) =>
    set((s) => ({
      activeWorkflowId: id,
      selectedWorker: null,
      ...deriveActive(s.workflows, id),
    })),

  removeWorkflow: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.workflows;
      const { [id]: _dag, ...restDAGs } = s.inlineDAGs;
      const newActiveId = s.activeWorkflowId === id
        ? (Object.keys(rest)[0] ?? null)
        : s.activeWorkflowId;
      return {
        workflows: rest,
        inlineDAGs: restDAGs,
        activeWorkflowId: newActiveId,
        selectedWorker: s.activeWorkflowId === id ? null : s.selectedWorker,
        ...deriveActive(rest, newActiveId),
      };
    }),

  setGraphState: (graphState) =>
    set((s) => {
      const wfId = graphState.workflowId;
      const isNew = !s.workflows[wfId];
      const existing = s.workflows[wfId] || { graphState: null, events: [] };
      const updatedWorkflows = {
        ...s.workflows,
        [wfId]: { ...existing, graphState },
      };

      const newActiveId = isNew ? wfId : (s.activeWorkflowId ?? wfId);

      return {
        workflows: updatedWorkflows,
        activeWorkflowId: newActiveId,
        ...deriveActive(updatedWorkflows, newActiveId),
      };
    }),

  addEvent: (event, workflowId) =>
    set((s) => {
      const wfId = workflowId || s.activeWorkflowId;
      if (!wfId) {
        return {
          events: [...s.events.slice(-999), event],
        };
      }
      const isNew = !s.workflows[wfId];
      const existing = s.workflows[wfId] || { graphState: null, events: [] };
      const updatedWorkflows = {
        ...s.workflows,
        [wfId]: {
          ...existing,
          events: [...existing.events.slice(-999), event],
        },
      };
      const newActiveId = isNew ? wfId : (s.activeWorkflowId ?? wfId);
      return {
        workflows: updatedWorkflows,
        activeWorkflowId: newActiveId,
        ...deriveActive(updatedWorkflows, newActiveId),
      };
    }),

  setActivePlan: (activePlan) => set({ activePlan }),
  selectWorker: (selectedWorker) => set({ selectedWorker }),

  upsertInlineDAG: (dag) =>
    set((s) => {
      const wfId = dag.dagId;
      const isNew = !s.workflows[wfId];
      const existing = s.workflows[wfId] || { graphState: null, events: [] };
      const updatedWorkflows = {
        ...s.workflows,
        [wfId]: existing,
      };
      const newActiveId = isNew ? wfId : (s.activeWorkflowId ?? wfId);
      return {
        workflows: updatedWorkflows,
        activeWorkflowId: newActiveId,
        inlineDAGs: { ...s.inlineDAGs, [dag.dagId]: dag },
        ...deriveActive(updatedWorkflows, newActiveId),
      };
    }),

  updateDAGNode: (dagId, nodeId, update) =>
    set((s) => {
      const dag = s.inlineDAGs[dagId];
      if (!dag) return s;
      const nodes = dag.nodes.map((n) =>
        n.id === nodeId ? { ...n, ...update } : n,
      );
      const completedCount = nodes.filter(
        (n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped',
      ).length;
      return {
        inlineDAGs: {
          ...s.inlineDAGs,
          [dagId]: { ...dag, nodes, completedCount, status: 'running' },
        },
      };
    }),

  completeDAG: (dagId, result, error, stats) =>
    set((s) => {
      const dag = s.inlineDAGs[dagId];
      if (!dag) return s;
      const terminalStatus: InlineDAGStatus = error ? 'error' : (stats?.stopped ? 'stopped' : 'complete');
      return {
        inlineDAGs: {
          ...s.inlineDAGs,
          [dagId]: {
            ...dag,
            status: terminalStatus,
            result,
            error,
            completedCount: dag.totalCount,
            durationSec: stats?.durationSec,
            workerCount: stats?.workerCount,
            totalCostUsd: stats?.totalCostUsd,
            toolCallCount: stats?.toolCallCount,
            modelUsage: stats?.modelUsage,
            nodeOutputPaths: stats?.nodeOutputPaths,
          },
        },
      };
    }),

  removeInlineDAG: (dagId) =>
    set((s) => {
      const { [dagId]: _, ...rest } = s.inlineDAGs;
      return { inlineDAGs: rest };
    }),

  setPendingConfirmation: (pendingConfirmation) => set({ pendingConfirmation }),

  reset: () =>
    set({
      workflows: {},
      activeWorkflowId: null,
      graphState: null,
      events: [],
      activePlan: null,
      selectedWorker: null,
      inlineDAGs: {},
      pendingConfirmation: null,
    }),
}));

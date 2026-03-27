import { create } from 'zustand';

// Define minimal types inline (don't import from core — this is a Next.js app)
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

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface SessionMetrics {
  model: string;
  sessionCostUsd: number;
  completedLayers: number;
  totalLayers: number;
  completedNodes: number;
  totalNodes: number;
  activeWorkers: number;
  elapsed: number;
}

export interface HindsightState {
  connected: boolean | null;
  busy: boolean;
}

interface OrchestrationStore {
  graphState: GraphState | null;
  events: WorkerEvent[];
  activePlan: PlanData | null;
  selectedWorker: string | null;
  inlineDAGs: Record<string, InlineDAG>;
  pendingConfirmation: DAGConfirmation | null;
  connectionStatus: ConnectionStatus;
  sessionMetrics: SessionMetrics;
  hindsight: HindsightState;
  runStartTime: number | null;
  setGraphState: (s: GraphState) => void;
  addEvent: (e: WorkerEvent) => void;
  setActivePlan: (p: PlanData | null) => void;
  selectWorker: (id: string | null) => void;
  upsertInlineDAG: (dag: InlineDAG) => void;
  updateDAGNode: (dagId: string, nodeId: string, update: Partial<InlineDAGNode>) => void;
  completeDAG: (dagId: string, result?: string, error?: string, stats?: { durationSec?: number; workerCount?: number; totalCostUsd?: number; toolCallCount?: number; modelUsage?: ModelUsageEntry[]; nodeOutputPaths?: Record<string, string[]>; stopped?: boolean }) => void;
  removeInlineDAG: (dagId: string) => void;
  setPendingConfirmation: (c: DAGConfirmation | null) => void;
  setConnectionStatus: (s: ConnectionStatus) => void;
  updateSessionMetrics: (m: Partial<SessionMetrics>) => void;
  setHindsight: (h: Partial<HindsightState>) => void;
  setRunStartTime: (t: number | null) => void;
  reset: () => void;
}

const defaultSessionMetrics: SessionMetrics = {
  model: '',
  sessionCostUsd: 0,
  completedLayers: 0,
  totalLayers: 0,
  completedNodes: 0,
  totalNodes: 0,
  activeWorkers: 0,
  elapsed: 0,
};

export const useOrchestrationStore = create<OrchestrationStore>((set) => ({
  graphState: null,
  events: [],
  activePlan: null,
  selectedWorker: null,
  inlineDAGs: {},
  pendingConfirmation: null,
  connectionStatus: 'disconnected',
  sessionMetrics: { ...defaultSessionMetrics },
  hindsight: { connected: null, busy: false },
  runStartTime: null,
  setGraphState: (graphState) => set({ graphState }),
  addEvent: (event) => set((s) => ({ events: [...s.events.slice(-999), event] })),
  setActivePlan: (activePlan) => set({ activePlan }),
  selectWorker: (selectedWorker) => set({ selectedWorker }),
  upsertInlineDAG: (dag) =>
    set((s) => ({ inlineDAGs: { ...s.inlineDAGs, [dag.dagId]: dag } })),
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
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  updateSessionMetrics: (m) =>
    set((s) => ({ sessionMetrics: { ...s.sessionMetrics, ...m } })),
  setHindsight: (h) =>
    set((s) => ({ hindsight: { ...s.hindsight, ...h } })),
  setRunStartTime: (runStartTime) => set({ runStartTime }),
  reset: () =>
    set({
      graphState: null,
      events: [],
      activePlan: null,
      selectedWorker: null,
      inlineDAGs: {},
      pendingConfirmation: null,
      connectionStatus: 'disconnected',
      sessionMetrics: { ...defaultSessionMetrics },
      hindsight: { connected: null, busy: false },
      runStartTime: null,
    }),
}));

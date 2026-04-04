import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useEffect, useMemo, useState } from 'react';

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

export type InlineDAGStatus = 'dispatched' | 'running' | 'complete' | 'error' | 'stopped' | 'paused' | 'interrupted';

export interface InlineDAGNode {
  id: string;
  label: string;
  type: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled';
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

export interface MemoryEvent {
  id: string;
  timestamp: string;
  op: 'retain' | 'recall' | 'dedup' | 'quality' | 'bootstrap' | 'flush' | 'session_anchor' | 'summary' | 'self_knowledge';
  detail: string;
  bank?: string;
  meta?: Record<string, unknown>;
}

/** Typed read-side accessors for retain meta — cast meta as RetainMeta for safe access */
export interface RetainMeta {
  context?: string;
  score?: number;
  signals?: string[];
  contentPreview?: string;
  contentLength?: number;
  itemCount?: number;
  items?: Array<{ content: string; context: string; timestamp: string }>;
  durationMs?: number;
  result?: { success: boolean; bankId?: string; itemsCount?: number };
}

/** Typed read-side accessors for recall meta */
export interface RecallMeta {
  query?: string;
  resultCount?: number;
  totalFromApi?: number;
  droppedByRelevance?: number;
  topScore?: number;
  durationMs?: number;
  clientScored?: boolean;
  tokensUsed?: number;
  budget?: string;
  maxTokens?: number;
  minRelevance?: number;
  results?: Array<{ content: string; context: string; timestamp: string; relevance: number }>;
}

/** Typed read-side accessors for quality rejection meta */
export interface QualityMeta {
  score?: number;
  threshold?: number;
  context?: string;
  signals?: string[];
  contentPreview?: string;
  wordCount?: number;
}

/** Typed read-side accessors for dedup meta */
export interface DedupMeta {
  context?: string;
  contentPreview?: string;
  bankId?: string;
  similarityThreshold?: number;
}

export interface MemoryFilterState {
  ops: Set<MemoryEvent['op']> | null;
  bank: string | null;
  searchText: string;
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
  orchPaneOpen: boolean;
  scrollToDagId: string | null;
  activitySectionCollapsed: boolean;
  memoryEvents: MemoryEvent[];
  activeOrchTab: 'memory' | 'workflow' | 'files';

  graphState: GraphState | null;
  events: WorkerEvent[];

  memoryFilter: MemoryFilterState;
  addMemoryEvent: (e: MemoryEvent) => void;
  setMemoryFilter: (filter: Partial<MemoryFilterState>) => void;
  setActiveOrchTab: (tab: 'memory' | 'workflow' | 'files') => void;
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
  setOrchPaneOpen: (open: boolean) => void;
  clearScrollToDagId: () => void;
  toggleActivitySectionCollapsed: () => void;
  openOrchPane: (dagId: string) => void;
  markAllInterrupted: () => void;
  pauseDAG: (dagId: string) => void;
  resumeDAG: (dagId: string) => void;
  stopDAG: (dagId: string) => void;
  reset: () => void;
}

/** Max entries to persist for each collection to prevent localStorage bloat. */
const MAX_PERSISTED_WORKFLOWS = 10;
const MAX_PERSISTED_EVENTS = 100;
const MAX_PERSISTED_MEMORY_EVENTS = 100;
const MAX_PERSISTED_INLINE_DAGS = 20;

/**
 * Safe localStorage adapter that catches QuotaExceededError.
 * On quota exceeded, clears the existing entry and retries once.
 */
const safeLocalStorage = {
  getItem: (name: string): string | null => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
        try {
          localStorage.removeItem(name);
          localStorage.setItem(name, value);
        } catch {
          // Still failing after clearing — give up gracefully
        }
      }
    }
  },
  removeItem: (name: string): void => {
    try {
      localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
};

function deriveActive(workflows: Record<string, WorkflowData>, activeWorkflowId: string | null) {
  const data = activeWorkflowId ? workflows[activeWorkflowId] : undefined;
  return {
    graphState: data?.graphState ?? null,
    events: data?.events ?? [],
  };
}

export const useOrchestrationStore = create<OrchestrationStore>()(
  persist(
  (set) => ({
  workflows: {},
  activeWorkflowId: null,
  activePlan: null,
  selectedWorker: null,
  inlineDAGs: {},
  pendingConfirmation: null,
  orchPaneOpen: true,
  scrollToDagId: null,
  activitySectionCollapsed: false,
  memoryEvents: [],
  memoryFilter: { ops: null, bank: null, searchText: '' },
  activeOrchTab: 'memory',
  graphState: null,
  events: [],

  addMemoryEvent: (e) =>
    set((s) => ({
      memoryEvents: [...s.memoryEvents.slice(-199), e],
    })),

  setMemoryFilter: (filter) =>
    set((s) => ({
      memoryFilter: { ...s.memoryFilter, ...filter },
    })),

  setActiveOrchTab: (tab) => set({ activeOrchTab: tab }),

  setActiveWorkflowId: (id) =>
    set((s) => ({
      activeWorkflowId: id,
      selectedWorker: null,
      scrollToDagId: id,
      ...deriveActive(s.workflows, id),
    })),

  removeWorkflow: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.workflows;
      const { [id]: _dag, ...restDAGs } = s.inlineDAGs;
      const newActiveId = s.activeWorkflowId === id
        ? (Object.keys(rest)[0] ?? null)
        : s.activeWorkflowId;
      const noWorkflowsLeft = Object.keys(rest).length === 0;
      return {
        workflows: rest,
        inlineDAGs: restDAGs,
        activeWorkflowId: newActiveId,
        selectedWorker: s.activeWorkflowId === id ? null : s.selectedWorker,
        ...(noWorkflowsLeft ? { activeOrchTab: 'memory' as const } : {}),
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
        (n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped' || n.status === 'cancelled',
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

  setOrchPaneOpen: (open) => set({ orchPaneOpen: open }),
  clearScrollToDagId: () => set({ scrollToDagId: null }),

  toggleActivitySectionCollapsed: () =>
    set((s) => ({ activitySectionCollapsed: !s.activitySectionCollapsed })),

  openOrchPane: (dagId) =>
    set((s) => ({
      orchPaneOpen: true,
      activeWorkflowId: dagId,
      selectedWorker: null,
      ...deriveActive(s.workflows, dagId),
    })),

  pauseDAG: (dagId) =>
    set((s) => {
      const dag = s.inlineDAGs[dagId];
      if (!dag) return s;
      return {
        inlineDAGs: {
          ...s.inlineDAGs,
          [dagId]: { ...dag, status: 'paused' },
        },
      };
    }),

  resumeDAG: (dagId) =>
    set((s) => {
      const dag = s.inlineDAGs[dagId];
      if (!dag) return s;
      return {
        inlineDAGs: {
          ...s.inlineDAGs,
          [dagId]: { ...dag, status: 'running' },
        },
      };
    }),

  stopDAG: (dagId) =>
    set((s) => {
      const dag = s.inlineDAGs[dagId];
      if (!dag) return s;
      return {
        inlineDAGs: {
          ...s.inlineDAGs,
          [dagId]: {
            ...dag,
            status: 'stopped',
            nodes: dag.nodes.map((n) =>
              n.status === 'pending'
                ? { ...n, status: 'cancelled' as const }
                : n.status === 'running'
                  ? { ...n, status: 'cancelled' as const }
                  : n,
            ),
          },
        },
      };
    }),

  markAllInterrupted: () =>
    set((s) => {
      const activeStatuses = new Set<InlineDAGStatus>(['dispatched', 'running']);

      const updatedDAGs = { ...s.inlineDAGs };
      let changed = false;
      for (const [id, dag] of Object.entries(updatedDAGs)) {
        if (activeStatuses.has(dag.status)) {
          changed = true;
          updatedDAGs[id] = {
            ...dag,
            status: 'interrupted',
            error: 'Gateway disconnected — run interrupted',
            nodes: dag.nodes.map((n) =>
              n.status === 'running'
                ? { ...n, status: 'error' as const }
                : n,
            ),
          };
        }
      }

      const updatedWorkflows = { ...s.workflows };
      for (const [id, wf] of Object.entries(updatedWorkflows)) {
        if (wf.graphState && wf.graphState.status !== 'complete' && wf.graphState.status !== 'error' && wf.graphState.status !== 'stopped') {
          changed = true;
          const updatedNodes = { ...wf.graphState.nodes };
          for (const [nid, node] of Object.entries(updatedNodes)) {
            if (node.status === 'running') {
              updatedNodes[nid] = { ...node, status: 'error' };
            }
          }
          updatedWorkflows[id] = {
            ...wf,
            graphState: {
              ...wf.graphState,
              status: 'stopped',
              nodes: updatedNodes,
            },
          };
        }
      }

      if (!changed) return s;

      return {
        inlineDAGs: updatedDAGs,
        workflows: updatedWorkflows,
        pendingConfirmation: null,
        ...deriveActive(updatedWorkflows, s.activeWorkflowId),
      };
    }),

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
      orchPaneOpen: true,
      scrollToDagId: null,
      activitySectionCollapsed: false,
      memoryEvents: [],
      memoryFilter: { ops: null, bank: null, searchText: '' },
      activeOrchTab: 'memory',
    }),
  }),
  {
    name: 'orionomega-orchestration',
    storage: createJSONStorage(() => safeLocalStorage),
    partialize: (state) => {
      // Cap collections to prevent localStorage bloat
      const workflowKeys = Object.keys(state.workflows);
      const cappedWorkflows: Record<string, WorkflowData> = {};
      for (const key of workflowKeys.slice(-MAX_PERSISTED_WORKFLOWS)) {
        const wf = state.workflows[key];
        cappedWorkflows[key] = {
          graphState: wf.graphState,
          events: wf.events.slice(-MAX_PERSISTED_EVENTS),
        };
      }

      const dagKeys = Object.keys(state.inlineDAGs);
      const cappedDAGs: Record<string, InlineDAG> = {};
      for (const key of dagKeys.slice(-MAX_PERSISTED_INLINE_DAGS)) {
        cappedDAGs[key] = state.inlineDAGs[key];
      }

      return {
        inlineDAGs: cappedDAGs,
        workflows: cappedWorkflows,
        activeWorkflowId: state.activeWorkflowId,
        orchPaneOpen: state.orchPaneOpen,
        activeOrchTab: state.activeOrchTab,
        graphState: state.graphState,
        events: state.events.slice(-MAX_PERSISTED_EVENTS),
        activePlan: state.activePlan,
        selectedWorker: state.selectedWorker,
        memoryEvents: state.memoryEvents.slice(-MAX_PERSISTED_MEMORY_EVENTS),
      };
    },
    onRehydrateStorage: () => (state) => {
      if (state) {
        const hasWorkflows = Object.keys(state.workflows).length > 0;
        if ((state.activeOrchTab as string) === 'activity') {
          state.activeOrchTab = hasWorkflows ? 'workflow' : 'memory';
        }
        if (state.activeOrchTab === 'workflow' && !hasWorkflows) {
          state.activeOrchTab = 'memory';
        }
        if (hasWorkflows && !state.activeWorkflowId) {
          state.activeWorkflowId = Object.keys(state.workflows)[0];
        }
        const derived = deriveActive(state.workflows, state.activeWorkflowId);
        state.graphState = derived.graphState;
        state.events = derived.events;
      }
    },
  },
));

export function useFilteredMemoryEvents(): MemoryEvent[] {
  const events = useOrchestrationStore((s) => s.memoryEvents);
  const filter = useOrchestrationStore((s) => s.memoryFilter);
  return useMemo(() => {
    let filtered = events;
    if (filter.ops) filtered = filtered.filter(e => filter.ops!.has(e.op));
    if (filter.bank) filtered = filtered.filter(e => e.bank === filter.bank);
    if (filter.searchText) {
      const q = filter.searchText.toLowerCase();
      filtered = filtered.filter(e =>
        e.detail.toLowerCase().includes(q) ||
        (e.bank?.toLowerCase().includes(q) ?? false) ||
        JSON.stringify(e.meta ?? {}).toLowerCase().includes(q),
      );
    }
    return filtered;
  }, [events, filter]);
}

export function useOrchHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const unsub = useOrchestrationStore.persist.onFinishHydration(() => setHydrated(true));
    if (useOrchestrationStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  return hydrated;
}

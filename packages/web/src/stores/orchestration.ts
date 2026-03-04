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

interface OrchestrationStore {
  graphState: GraphState | null;
  events: WorkerEvent[];
  activePlan: PlanData | null;
  selectedWorker: string | null;
  setGraphState: (s: GraphState) => void;
  addEvent: (e: WorkerEvent) => void;
  setActivePlan: (p: PlanData | null) => void;
  selectWorker: (id: string | null) => void;
  reset: () => void;
}

export const useOrchestrationStore = create<OrchestrationStore>((set) => ({
  graphState: null,
  events: [],
  activePlan: null,
  selectedWorker: null,
  setGraphState: (graphState) => set({ graphState }),
  addEvent: (event) => set((s) => ({ events: [...s.events.slice(-999), event] })),
  setActivePlan: (activePlan) => set({ activePlan }),
  selectWorker: (selectedWorker) => set({ selectedWorker }),
  reset: () => set({ graphState: null, events: [], activePlan: null, selectedWorker: null }),
}));

export interface WorkerEvent {
    workerId: string;
    nodeId: string;
    timestamp: string;
    type: 'thinking' | 'tool_call' | 'tool_result' | 'finding' | 'status' | 'error' | 'done';
    tool?: {
        name: string;
        action?: string;
        file?: string;
        summary: string;
    };
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
    agent?: {
        model: string;
        task: string;
    };
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
    graph: {
        nodes: Record<string, GraphNode>;
    };
}
export type InlineDAGStatus = 'dispatched' | 'running' | 'complete' | 'error';
export interface InlineDAGNode {
    id: string;
    label: string;
    type: string;
    status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
    progress?: number;
    output?: string;
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
}
export interface DAGConfirmation {
    dagId: string;
    summary: string;
    reason: string;
    guardedNodes: {
        id: string;
        label: string;
        risk: string;
    }[];
}
interface OrchestrationStore {
    graphState: GraphState | null;
    events: WorkerEvent[];
    activePlan: PlanData | null;
    selectedWorker: string | null;
    inlineDAGs: Record<string, InlineDAG>;
    pendingConfirmation: DAGConfirmation | null;
    setGraphState: (s: GraphState) => void;
    addEvent: (e: WorkerEvent) => void;
    setActivePlan: (p: PlanData | null) => void;
    selectWorker: (id: string | null) => void;
    upsertInlineDAG: (dag: InlineDAG) => void;
    updateDAGNode: (dagId: string, nodeId: string, update: Partial<InlineDAGNode>) => void;
    completeDAG: (dagId: string, result?: string, error?: string) => void;
    removeInlineDAG: (dagId: string) => void;
    setPendingConfirmation: (c: DAGConfirmation | null) => void;
    reset: () => void;
}
export declare const useOrchestrationStore: import("zustand").UseBoundStore<import("zustand").StoreApi<OrchestrationStore>>;
export {};
//# sourceMappingURL=orchestration.d.ts.map
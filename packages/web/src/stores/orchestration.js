import { create } from 'zustand';
export const useOrchestrationStore = create((set) => ({
    graphState: null,
    events: [],
    activePlan: null,
    selectedWorker: null,
    inlineDAGs: {},
    pendingConfirmation: null,
    setGraphState: (graphState) => set({ graphState }),
    addEvent: (event) => set((s) => ({ events: [...s.events.slice(-999), event] })),
    setActivePlan: (activePlan) => set({ activePlan }),
    selectWorker: (selectedWorker) => set({ selectedWorker }),
    upsertInlineDAG: (dag) => set((s) => ({ inlineDAGs: { ...s.inlineDAGs, [dag.dagId]: dag } })),
    updateDAGNode: (dagId, nodeId, update) => set((s) => {
        const dag = s.inlineDAGs[dagId];
        if (!dag)
            return s;
        const nodes = dag.nodes.map((n) => n.id === nodeId ? { ...n, ...update } : n);
        const completedCount = nodes.filter((n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped').length;
        return {
            inlineDAGs: {
                ...s.inlineDAGs,
                [dagId]: { ...dag, nodes, completedCount, status: 'running' },
            },
        };
    }),
    completeDAG: (dagId, result, error) => set((s) => {
        const dag = s.inlineDAGs[dagId];
        if (!dag)
            return s;
        return {
            inlineDAGs: {
                ...s.inlineDAGs,
                [dagId]: {
                    ...dag,
                    status: error ? 'error' : 'complete',
                    result,
                    error,
                    completedCount: dag.totalCount,
                },
            },
        };
    }),
    removeInlineDAG: (dagId) => set((s) => {
        const { [dagId]: _, ...rest } = s.inlineDAGs;
        return { inlineDAGs: rest };
    }),
    setPendingConfirmation: (pendingConfirmation) => set({ pendingConfirmation }),
    reset: () => set({
        graphState: null,
        events: [],
        activePlan: null,
        selectedWorker: null,
        inlineDAGs: {},
        pendingConfirmation: null,
    }),
}));
//# sourceMappingURL=orchestration.js.map
import { create } from 'zustand';

export type AgentMode = 'orchestrate' | 'direct' | 'code';

/** Ordered list of modes for cycling via keyboard shortcut. */
const MODE_CYCLE: AgentMode[] = ['orchestrate', 'direct', 'code'];

interface AgentModeStore {
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
  /** Cycle to the next mode in the sequence: orchestrate → direct → code → orchestrate. */
  toggle: () => void;
  lastChangedAt: number;
  /** Rehydrate store from a server state snapshot (replaces localStorage persistence). */
  hydrateFromSnapshot: (snapshot: { mode?: AgentMode }) => void;
}

export const useAgentModeStore = create<AgentModeStore>()((set) => ({
  mode: 'orchestrate',
  lastChangedAt: 0,
  setMode: (mode) => set({ mode, lastChangedAt: Date.now() }),
  toggle: () =>
    set((s) => {
      const idx = MODE_CYCLE.indexOf(s.mode);
      const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
      return { mode: next, lastChangedAt: Date.now() };
    }),
  hydrateFromSnapshot: (snapshot) =>
    set({
      mode: snapshot.mode ?? 'orchestrate',
      lastChangedAt: Date.now(),
    }),
}));

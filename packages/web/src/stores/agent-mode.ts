import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useEffect, useState } from 'react';

export type AgentMode = 'orchestrate' | 'direct' | 'code';

/** Ordered list of modes for cycling via keyboard shortcut. */
const MODE_CYCLE: AgentMode[] = ['orchestrate', 'direct', 'code'];

interface AgentModeStore {
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
  /** Cycle to the next mode in the sequence: orchestrate → direct → code → orchestrate. */
  toggle: () => void;
  lastChangedAt: number;
}

export const useAgentModeStore = create<AgentModeStore>()(
  persist(
    (set) => ({
      mode: 'orchestrate',
      lastChangedAt: 0,
      setMode: (mode) => set({ mode, lastChangedAt: Date.now() }),
      toggle: () =>
        set((s) => {
          const idx = MODE_CYCLE.indexOf(s.mode);
          const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
          return { mode: next, lastChangedAt: Date.now() };
        }),
    }),
    {
      name: 'orionomega-agent-mode',
      partialize: (state) => ({ mode: state.mode, lastChangedAt: state.lastChangedAt }),
    },
  ),
);

export function useAgentModeHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const unsub = useAgentModeStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAgentModeStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  return hydrated;
}

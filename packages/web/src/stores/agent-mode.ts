import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useEffect, useState } from 'react';

export type AgentMode = 'orchestrate' | 'direct';

interface AgentModeStore {
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
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
        set((s) => ({
          mode: s.mode === 'orchestrate' ? 'direct' : 'orchestrate',
          lastChangedAt: Date.now(),
        })),
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

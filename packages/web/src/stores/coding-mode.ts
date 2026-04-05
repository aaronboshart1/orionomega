import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useEffect, useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

export type CodingStepStatus = 'pending' | 'running' | 'completed' | 'failed';

export type CodingStepType =
  | 'clone'
  | 'analyze'
  | 'plan'
  | 'implement'
  | 'test'
  | 'review'
  | 'commit'
  | 'custom';

export interface CodingStep {
  id: string;
  label: string;
  type: CodingStepType;
  status: CodingStepStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: string;
  error?: string;
  codeDiff?: string;
  dependsOn?: string[];
}

export interface TestResults {
  passed: number;
  failed: number;
  total: number;
  details?: string;
}

export interface ArchitectReview {
  iteration: number;
  buildStatus: 'pass' | 'fail' | 'pending';
  testResults?: TestResults;
  qualityScore?: number;
  decision: 'approved' | 'retask' | 'pending';
  feedback?: string;
  reviewedAt?: string;
}

export type CodingSessionStatus =
  | 'idle'
  | 'running'
  | 'reviewing'
  | 'completed'
  | 'failed';

export interface CodingSession {
  sessionId: string;
  taskDescription: string;
  repoUrl: string;
  branch: string;
  status: CodingSessionStatus;
  steps: CodingStep[];
  reviews: ArchitectReview[];
  currentIteration: number;
  startedAt?: string;
  completedAt?: string;
  commitHash?: string;
  filesChanged?: string[];
  totalDurationMs?: number;
}

// ── Store interface ────────────────────────────────────────────────────────────

interface CodingModeStore {
  session: CodingSession | null;
  pendingStart: { repoUrl: string; branch: string; taskDescription: string } | null;

  setPendingStart: (config: { repoUrl: string; branch: string; taskDescription: string } | null) => void;
  setSession: (session: CodingSession) => void;
  updateStep: (stepId: string, update: Partial<CodingStep>) => void;
  addOrUpdateStep: (step: CodingStep) => void;
  addReview: (review: ArchitectReview) => void;
  setSessionStatus: (status: CodingSessionStatus) => void;
  completeSession: (params: {
    commitHash?: string;
    filesChanged?: string[];
    totalDurationMs?: number;
  }) => void;
  failSession: (error: string) => void;
  clearSession: () => void;
}

// ── Safe localStorage ──────────────────────────────────────────────────────────

const safeLocalStorage = {
  getItem: (name: string): string | null => {
    try { return localStorage.getItem(name); } catch { return null; }
  },
  setItem: (name: string, value: string): void => {
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
        try { localStorage.removeItem(name); localStorage.setItem(name, value); } catch { /* ignore */ }
      }
    }
  },
  removeItem: (name: string): void => {
    try { localStorage.removeItem(name); } catch { /* ignore */ }
  },
};

// ── Store ──────────────────────────────────────────────────────────────────────

export const useCodingModeStore = create<CodingModeStore>()(
  persist(
    (set) => ({
      session: null,
      pendingStart: null,

      setPendingStart: (config) => set({ pendingStart: config }),

      setSession: (session) => set({ session, pendingStart: null }),

      updateStep: (stepId, update) =>
        set((s) => {
          if (!s.session) return s;
          return {
            session: {
              ...s.session,
              steps: s.session.steps.map((step) =>
                step.id === stepId ? { ...step, ...update } : step,
              ),
            },
          };
        }),

      addOrUpdateStep: (step) =>
        set((s) => {
          if (!s.session) return s;
          const existing = s.session.steps.findIndex((st) => st.id === step.id);
          if (existing >= 0) {
            const steps = [...s.session.steps];
            steps[existing] = { ...steps[existing], ...step };
            return { session: { ...s.session, steps } };
          }
          return { session: { ...s.session, steps: [...s.session.steps, step] } };
        }),

      addReview: (review) =>
        set((s) => {
          if (!s.session) return s;
          const existing = s.session.reviews.findIndex((r) => r.iteration === review.iteration);
          const reviews =
            existing >= 0
              ? s.session.reviews.map((r) => (r.iteration === review.iteration ? review : r))
              : [...s.session.reviews, review];
          return {
            session: {
              ...s.session,
              reviews,
              currentIteration: review.iteration,
              status: review.decision === 'approved' ? 'reviewing' : 'running',
            },
          };
        }),

      setSessionStatus: (status) =>
        set((s) => (s.session ? { session: { ...s.session, status } } : s)),

      completeSession: ({ commitHash, filesChanged, totalDurationMs }) =>
        set((s) => {
          if (!s.session) return s;
          return {
            session: {
              ...s.session,
              status: 'completed',
              completedAt: new Date().toISOString(),
              commitHash,
              filesChanged,
              totalDurationMs,
            },
          };
        }),

      failSession: (error) =>
        set((s) => {
          if (!s.session) return s;
          return {
            session: {
              ...s.session,
              status: 'failed',
              completedAt: new Date().toISOString(),
              steps: s.session.steps.map((step) =>
                step.status === 'running'
                  ? { ...step, status: 'failed', error }
                  : step,
              ),
            },
          };
        }),

      clearSession: () => set({ session: null, pendingStart: null }),
    }),
    {
      name: 'orionomega-coding-mode',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({ session: state.session }),
    },
  ),
);

// ── Hydration hook ─────────────────────────────────────────────────────────────

export function useCodingModeHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const unsub = useCodingModeStore.persist.onFinishHydration(() => setHydrated(true));
    if (useCodingModeStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  return hydrated;
}

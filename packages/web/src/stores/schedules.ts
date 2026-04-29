import { create } from 'zustand';

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  cronExpr: string;
  prompt: string;
  agentMode: 'orchestrate' | 'direct' | 'code';
  sessionId: string;
  status: 'active' | 'paused' | 'deleted';
  timezone: string;
  overlapPolicy: 'skip' | 'queue' | 'allow';
  maxRetries: number;
  timeoutSec: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  runCount: number;
  runAt: string | null;
}

export interface TaskExecution {
  id: string;
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'skipped';
  startedAt: string;
  completedAt: string | null;
  durationSec: number | null;
  error: string | null;
  triggerType: 'cron' | 'manual';
}

interface SchedulesState {
  schedules: ScheduledTask[];
  loading: boolean;
  error: string | null;
  setSchedules: (schedules: ScheduledTask[]) => void;
  updateScheduleInList: (id: string, patch: Partial<ScheduledTask>) => void;
  removeSchedule: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useSchedulesStore = create<SchedulesState>((set) => ({
  schedules: [],
  loading: false,
  error: null,
  setSchedules: (schedules) => set({ schedules, loading: false, error: null }),
  updateScheduleInList: (id, patch) => set((s) => ({
    schedules: s.schedules.map((t) => t.id === id ? { ...t, ...patch } : t),
  })),
  removeSchedule: (id) => set((s) => ({
    schedules: s.schedules.filter((t) => t.id !== id),
  })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));

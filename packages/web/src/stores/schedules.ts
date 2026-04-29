'use client';

/**
 * @module stores/schedules
 * Zustand store for the Schedules (cron) tab in Settings.
 * Mirrors `ScheduledTask` and `TaskExecution` shapes from the gateway.
 */

import { create } from 'zustand';

export interface Schedule {
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

export interface Execution {
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
  schedules: Schedule[];
  executions: Record<string, Execution[]>;
  loading: boolean;
  error: string | null;
  /**
   * In-flight execution IDs keyed by task ID. Tracking per-execution lets us
   * keep the "running" badge lit while overlapPolicy='allow' has multiple
   * concurrent runs in flight — the badge clears only when the *last* one
   * completes.
   */
  liveTriggers: Map<string, Set<string>>;
  setSchedules: (schedules: Schedule[]) => void;
  upsertSchedule: (schedule: Schedule) => void;
  removeSchedule: (id: string) => void;
  setExecutions: (taskId: string, executions: Execution[]) => void;
  prependExecution: (taskId: string, execution: Execution) => void;
  updateExecution: (taskId: string, executionId: string, patch: Partial<Execution>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  markTriggered: (taskId: string, executionId: string) => void;
  clearTriggered: (taskId: string, executionId: string) => void;
}

export const useSchedulesStore = create<SchedulesState>((set) => ({
  schedules: [],
  executions: {},
  loading: false,
  error: null,
  liveTriggers: new Map(),
  setSchedules: (schedules) => set({ schedules }),
  upsertSchedule: (schedule) =>
    set((state) => {
      const idx = state.schedules.findIndex((s) => s.id === schedule.id);
      if (idx === -1) return { schedules: [...state.schedules, schedule] };
      const next = [...state.schedules];
      next[idx] = schedule;
      return { schedules: next };
    }),
  removeSchedule: (id) =>
    set((state) => ({ schedules: state.schedules.filter((s) => s.id !== id) })),
  setExecutions: (taskId, executions) =>
    set((state) => ({ executions: { ...state.executions, [taskId]: executions } })),
  prependExecution: (taskId, execution) =>
    set((state) => {
      const list = state.executions[taskId] ?? [];
      return {
        executions: {
          ...state.executions,
          [taskId]: [execution, ...list].slice(0, 50),
        },
      };
    }),
  updateExecution: (taskId, executionId, patch) =>
    set((state) => {
      const list = state.executions[taskId];
      if (!list) return state;
      return {
        executions: {
          ...state.executions,
          [taskId]: list.map((e) => (e.id === executionId ? { ...e, ...patch } : e)),
        },
      };
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  markTriggered: (taskId, executionId) =>
    set((state) => {
      const next = new Map(state.liveTriggers);
      const inflight = new Set(next.get(taskId) ?? []);
      inflight.add(executionId);
      next.set(taskId, inflight);
      return { liveTriggers: next };
    }),
  clearTriggered: (taskId, executionId) =>
    set((state) => {
      const inflight = state.liveTriggers.get(taskId);
      if (!inflight || !inflight.has(executionId)) return state;
      const next = new Map(state.liveTriggers);
      const updated = new Set(inflight);
      updated.delete(executionId);
      if (updated.size === 0) next.delete(taskId);
      else next.set(taskId, updated);
      return { liveTriggers: next };
    }),
}));

// ── REST helpers ─────────────────────────────────────────────────────────────

const API_BASE = '/api/gateway/api/schedules';

export async function fetchSchedules(): Promise<Schedule[]> {
  const res = await fetch(API_BASE);
  if (!res.ok) throw new Error(`Failed to load schedules: ${res.status}`);
  const data = (await res.json()) as { tasks: Schedule[] };
  return data.tasks;
}

export async function createSchedule(input: Partial<Schedule> & { name: string; cronExpr: string; prompt: string }): Promise<Schedule> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Create failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { task: Schedule };
  return data.task;
}

export async function updateSchedule(id: string, patch: Partial<Schedule>): Promise<Schedule> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Update failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { task: Schedule };
  return data.task;
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function pauseSchedule(id: string): Promise<Schedule> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error(`Pause failed: ${res.status}`);
  const data = (await res.json()) as { task: Schedule };
  return data.task;
}

export async function resumeSchedule(id: string): Promise<Schedule> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  if (!res.ok) throw new Error(`Resume failed: ${res.status}`);
  const data = (await res.json()) as { task: Schedule };
  return data.task;
}

export async function triggerSchedule(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/trigger`, { method: 'POST' });
  if (!res.ok) throw new Error(`Trigger failed: ${res.status}`);
}

export async function fetchExecutions(id: string, limit = 50): Promise<Execution[]> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/executions?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to load executions: ${res.status}`);
  const data = (await res.json()) as { executions: Execution[] };
  return data.executions;
}

export async function describeCron(expr: string): Promise<{ description: string; valid: boolean }> {
  const res = await fetch(`${API_BASE}/describe-cron?expr=${encodeURIComponent(expr)}`);
  if (!res.ok) return { description: 'Invalid expression', valid: false };
  return (await res.json()) as { description: string; valid: boolean };
}

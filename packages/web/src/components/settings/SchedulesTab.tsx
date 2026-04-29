'use client';

import { useState, useEffect, useCallback } from 'react';
import cronstrue from 'cronstrue';
import {
  Loader2,
  AlertCircle,
  CheckCircle,
  Play,
  Pause,
  Trash2,
  Plus,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { useSchedulesStore, type ScheduledTask, type TaskExecution } from '@/stores/schedules';

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
];

function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { verbose: true });
  } catch {
    return 'Invalid expression';
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'soon';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'in <1m';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

function StatusBadge({ status }: { status: ScheduledTask['status'] }) {
  const styles: Record<ScheduledTask['status'], string> = {
    active: 'bg-green-500/20 text-green-400 border border-green-500/30',
    paused: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
    deleted: 'bg-red-500/20 text-red-400 border border-red-500/30',
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

function LastStatusDot({ status }: { status: string | null }) {
  if (!status) return null;
  const color =
    status === 'completed' ? 'bg-green-400'
    : status === 'failed' ? 'bg-red-400'
    : status === 'timeout' ? 'bg-amber-400'
    : 'bg-zinc-500';
  return (
    <span className="flex items-center gap-1 text-xs text-zinc-500">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      {status}
    </span>
  );
}

interface CreateFormValues {
  name: string;
  prompt: string;
  cronExpr: string;
  timezone: string;
  agentMode: 'orchestrate' | 'direct' | 'code';
  overlapPolicy: 'skip' | 'queue' | 'allow';
  timeoutSec: number;
  maxRetries: number;
}

const DEFAULT_FORM: CreateFormValues = {
  name: '',
  prompt: '',
  cronExpr: '0 * * * *',
  timezone: 'UTC',
  agentMode: 'direct',
  overlapPolicy: 'skip',
  timeoutSec: 300,
  maxRetries: 0,
};

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState<CreateFormValues>(DEFAULT_FORM);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronDesc = describeCron(form.cronExpr);

  const handleCreate = async () => {
    if (!form.name.trim() || !form.prompt.trim() || !form.cronExpr.trim()) {
      setError('Name, prompt, and cron expression are required.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/gateway/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      setForm(DEFAULT_FORM);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create schedule');
    } finally {
      setCreating(false);
    }
  };

  const field = (label: string, children: React.ReactNode) => (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
      <label className="min-w-[140px] shrink-0 pt-1.5 text-xs text-zinc-400">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );

  const inputCls = 'w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2.5 md:py-1.5 text-sm md:text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors';
  const selectCls = inputCls;

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900/60 p-4 space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">New Scheduled Task</h4>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </div>
      )}

      <div className="space-y-2">
        {field('Name',
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Daily report"
            className={inputCls}
          />
        )}
        {field('Prompt',
          <textarea
            value={form.prompt}
            onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            placeholder="Generate a daily summary of..."
            rows={3}
            className={`${inputCls} resize-y`}
          />
        )}
        {field('Cron Expression',
          <div className="space-y-1">
            <input
              type="text"
              value={form.cronExpr}
              onChange={(e) => setForm((f) => ({ ...f, cronExpr: e.target.value }))}
              placeholder="0 * * * *"
              className={`${inputCls} font-mono`}
            />
            <p className={`text-xs ${cronDesc === 'Invalid expression' ? 'text-red-400' : 'text-zinc-500'}`}>
              {cronDesc}
            </p>
          </div>
        )}
        {field('Timezone',
          <select
            value={form.timezone}
            onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
            className={selectCls}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        )}
        {field('Agent Mode',
          <select
            value={form.agentMode}
            onChange={(e) => setForm((f) => ({ ...f, agentMode: e.target.value as CreateFormValues['agentMode'] }))}
            className={selectCls}
          >
            <option value="orchestrate">Orchestrate</option>
            <option value="direct">Direct</option>
            <option value="code">Code</option>
          </select>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        Advanced options
      </button>

      {showAdvanced && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          {field('Overlap Policy',
            <select
              value={form.overlapPolicy}
              onChange={(e) => setForm((f) => ({ ...f, overlapPolicy: e.target.value as CreateFormValues['overlapPolicy'] }))}
              className={selectCls}
            >
              <option value="skip">Skip (skip if already running)</option>
              <option value="queue">Queue (run after current finishes)</option>
              <option value="allow">Allow (run concurrently)</option>
            </select>
          )}
          {field('Timeout (sec)',
            <input
              type="number"
              value={form.timeoutSec}
              onChange={(e) => setForm((f) => ({ ...f, timeoutSec: Number(e.target.value) }))}
              className={inputCls}
              min={0}
            />
          )}
          {field('Max Retries',
            <input
              type="number"
              value={form.maxRetries}
              onChange={(e) => setForm((f) => ({ ...f, maxRetries: Number(e.target.value) }))}
              className={inputCls}
              min={0}
              max={10}
            />
          )}
        </div>
      )}

      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 md:py-1.5 text-sm md:text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          {creating ? 'Creating...' : 'Create Schedule'}
        </button>
      </div>
    </div>
  );
}

function ExecutionHistory({ taskId }: { taskId: string }) {
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/gateway/api/schedules/${taskId}/executions?limit=10`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setExecutions((data as { executions?: TaskExecution[] }).executions ?? []);
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 py-2 text-xs text-zinc-500">
        <Loader2 size={10} className="animate-spin" />
        Loading history…
      </div>
    );
  }

  if (executions.length === 0) {
    return <p className="py-2 text-xs text-zinc-600">No executions yet.</p>;
  }

  const statusColor = (s: TaskExecution['status']) => {
    if (s === 'completed') return 'text-green-400';
    if (s === 'failed') return 'text-red-400';
    if (s === 'timeout') return 'text-amber-400';
    if (s === 'running') return 'text-blue-400';
    return 'text-zinc-500';
  };

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-zinc-600 border-b border-zinc-800">
          <th className="pb-1 text-left font-normal">Status</th>
          <th className="pb-1 text-left font-normal">Started</th>
          <th className="pb-1 text-left font-normal">Duration</th>
          <th className="pb-1 text-left font-normal">Trigger</th>
        </tr>
      </thead>
      <tbody>
        {executions.map((ex) => (
          <tr key={ex.id} className="border-b border-zinc-800/50 last:border-0">
            <td className={`py-1 pr-3 ${statusColor(ex.status)}`}>{ex.status}</td>
            <td className="py-1 pr-3 text-zinc-400">{timeAgo(ex.startedAt)}</td>
            <td className="py-1 pr-3 text-zinc-400">
              {ex.durationSec != null ? `${ex.durationSec}s` : '—'}
            </td>
            <td className="py-1 text-zinc-500">{ex.triggerType}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TaskRow({
  task,
  onAction,
}: {
  task: ScheduledTask;
  onAction: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [actioning, setActioning] = useState<string | null>(null);

  const doAction = async (action: 'run' | 'pause' | 'resume' | 'delete') => {
    setActioning(action);
    try {
      if (action === 'run') {
        await fetch(`/api/gateway/api/schedules/${task.id}/run`, { method: 'POST' });
      } else if (action === 'delete') {
        await fetch(`/api/gateway/api/schedules/${task.id}`, { method: 'DELETE' });
      } else {
        await fetch(`/api/gateway/api/schedules/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: action === 'pause' ? 'paused' : 'active' }),
        });
      }
      onAction();
    } catch { /* ignore */ } finally {
      setActioning(null);
    }
  };

  const btnCls = 'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:opacity-40';

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-0.5">
            <span className="text-sm text-zinc-100 font-medium truncate">{task.name}</span>
            <StatusBadge status={task.status} />
          </div>
          <p className="text-xs text-zinc-500 font-mono">{task.cronExpr}</p>
          <p className="text-xs text-zinc-600 mt-0.5">{describeCron(task.cronExpr)}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => doAction('run')}
            disabled={actioning !== null}
            className={`${btnCls} text-blue-400 hover:bg-zinc-700 hover:text-blue-300`}
            title="Run now"
          >
            {actioning === 'run' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          </button>
          {task.status === 'active' ? (
            <button
              type="button"
              onClick={() => doAction('pause')}
              disabled={actioning !== null}
              className={`${btnCls} text-amber-400 hover:bg-zinc-700 hover:text-amber-300`}
              title="Pause"
            >
              {actioning === 'pause' ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => doAction('resume')}
              disabled={actioning !== null || task.status === 'deleted'}
              className={`${btnCls} text-green-400 hover:bg-zinc-700 hover:text-green-300`}
              title="Resume"
            >
              {actioning === 'resume' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => doAction('delete')}
            disabled={actioning !== null}
            className={`${btnCls} text-red-400 hover:bg-zinc-700 hover:text-red-300`}
            title="Delete"
          >
            {actioning === 'delete' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1 text-xs text-zinc-500">
          <Clock size={10} />
          {task.lastRunAt ? timeAgo(task.lastRunAt) : 'Never run'}
        </span>
        {task.nextRunAt && (
          <span className="text-xs text-zinc-600">{timeUntil(task.nextRunAt)}</span>
        )}
        <LastStatusDot status={task.lastStatus} />
        <span className="text-xs text-zinc-600">{task.runCount} run{task.runCount !== 1 ? 's' : ''}</span>
      </div>

      <button
        type="button"
        onClick={() => setShowHistory((v) => !v)}
        className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        {showHistory ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        {showHistory ? 'Hide history' : 'Show history'}
      </button>

      {showHistory && (
        <div className="border-t border-zinc-800 pt-2">
          <ExecutionHistory taskId={task.id} />
        </div>
      )}
    </div>
  );
}

export function SchedulesTab() {
  const { schedules, loading, error, setSchedules, setLoading, setError } = useSchedulesStore();
  const [showCreate, setShowCreate] = useState(false);

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/gateway/api/schedules');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSchedules((data as { schedules?: ScheduledTask[] }).schedules ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedules');
      setLoading(false);
    }
  }, [setSchedules, setLoading, setError]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 pb-2 flex-1">
          Scheduled Tasks
        </h3>
        <div className="flex items-center gap-2 mb-2 ml-4">
          <button
            type="button"
            onClick={fetchSchedules}
            disabled={loading}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
          >
            <Plus size={10} />
            New
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateForm
          onCreated={() => {
            setShowCreate(false);
            fetchSchedules();
          }}
        />
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </div>
      )}

      {loading && schedules.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-500">
          <Loader2 size={14} className="animate-spin" />
          Loading schedules…
        </div>
      )}

      {!loading && schedules.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-zinc-600">
          <CheckCircle size={20} className="text-zinc-700" />
          No scheduled tasks yet. Create one above.
        </div>
      )}

      <div className="space-y-2">
        {schedules
          .filter((t) => t.status !== 'deleted')
          .map((task) => (
            <TaskRow key={task.id} task={task} onAction={fetchSchedules} />
          ))}
      </div>
    </div>
  );
}

'use client';

/**
 * @module SchedulesPane
 * First-class Schedules tab for the orchestration pane.
 *
 * Master/detail layout: a list of schedules on the left (with status pills,
 * cron summary, next-run countdown, bulk-action checkboxes) and an editor
 * + execution-history timeline on the right. Reuses `useSchedulesStore`
 * for live updates from the WS handler — no new gateway/REST surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Trash2,
  Play,
  Pause,
  Zap,
  Loader2,
  RefreshCw,
  Clock,
  CalendarClock,
  ChevronRight,
  Search,
  Check,
  X,
  AlertCircle,
  CheckCircle2,
  XCircle,
  CircleDashed,
  Sparkles,
} from 'lucide-react';
import cronstrue from 'cronstrue';
import {
  useSchedulesStore,
  fetchSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  fetchExecutions,
  type Schedule,
  type Execution,
} from '@/stores/schedules';
import { nextRuns } from '@/lib/cron-forecast';

interface FormState {
  id?: string;
  name: string;
  description: string;
  cronExpr: string;
  prompt: string;
  agentMode: 'orchestrate' | 'direct' | 'code';
  timezone: string;
  overlapPolicy: 'skip' | 'queue' | 'allow';
  maxRetries: number;
  timeoutSec: number;
  runAt: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  cronExpr: '0 9 * * *',
  prompt: '',
  agentMode: 'orchestrate',
  timezone: 'UTC',
  overlapPolicy: 'skip',
  maxRetries: 0,
  timeoutSec: 0,
  runAt: '',
};

const PRESETS: { label: string; expr: string }[] = [
  { label: 'Every minute', expr: '* * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily 9am', expr: '0 9 * * *' },
  { label: 'Weekdays 9am', expr: '0 9 * * 1-5' },
  { label: 'Mondays 9am', expr: '0 9 * * 1' },
  { label: '1st of month', expr: '0 0 1 * *' },
];

/** Empty-state templates the user can one-click into the form. */
const TEMPLATES: { name: string; description: string; cronExpr: string; prompt: string; agentMode: FormState['agentMode'] }[] = [
  {
    name: 'Daily summary at 9am',
    description: 'Summarize yesterday\'s activity each morning',
    cronExpr: '0 9 * * *',
    prompt: 'Summarize yesterday\'s activity across the project: notable commits, open PRs, and outstanding issues.',
    agentMode: 'orchestrate',
  },
  {
    name: 'Hourly health check',
    description: 'Probe critical services every hour',
    cronExpr: '0 * * * *',
    prompt: 'Run a health check across critical services and report any failures or degraded responses.',
    agentMode: 'direct',
  },
  {
    name: 'Weekly cleanup on Sunday',
    description: 'Sundays at midnight — sweep stale state',
    cronExpr: '0 0 * * 0',
    prompt: 'Perform weekly cleanup: prune stale temp files, archive completed tickets, and rotate old logs.',
    agentMode: 'orchestrate',
  },
];

const COMMON_TIMEZONES: string[] = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Africa/Cairo', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo',
  'Australia/Sydney', 'Pacific/Auckland',
];

function getTimezoneOptions(): string[] {
  try {
    const intlAny = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof intlAny.supportedValuesOf === 'function') {
      const all = intlAny.supportedValuesOf('timeZone');
      if (Array.isArray(all) && all.length > 0) return ['UTC', ...all.filter((t) => t !== 'UTC')];
    }
  } catch { /* fall through */ }
  return COMMON_TIMEZONES;
}
const TIMEZONE_OPTIONS = getTimezoneOptions();

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/;

function isCronValid(expr: string): boolean {
  if (!expr.trim()) return false;
  try { cronstrue.toString(expr); return true; } catch { return false; }
}

function describeLocal(expr: string): string {
  try { return cronstrue.toString(expr, { verbose: false }); } catch { return 'Invalid expression'; }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const deltaMs = t - Date.now();
  const abs = Math.abs(deltaMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  let out: string;
  if (sec < 60) out = `${sec}s`;
  else if (min < 60) out = `${min}m`;
  else if (hr < 48) out = `${hr}h`;
  else out = `${day}d`;
  return deltaMs >= 0 ? `in ${out}` : `${out} ago`;
}

function statusPill(status: string | null): { color: string; label: string; icon: React.ReactNode } {
  switch (status) {
    case 'completed': return { color: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30', label: 'OK', icon: <CheckCircle2 size={10} /> };
    case 'failed': return { color: 'bg-red-500/15 text-red-300 ring-red-500/30', label: 'Failed', icon: <XCircle size={10} /> };
    case 'timeout': return { color: 'bg-amber-500/15 text-amber-300 ring-amber-500/30', label: 'Timeout', icon: <AlertCircle size={10} /> };
    case 'skipped': return { color: 'bg-zinc-700/40 text-zinc-400 ring-zinc-600/40', label: 'Skipped', icon: <CircleDashed size={10} /> };
    case 'running': return { color: 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/30', label: 'Running', icon: <Loader2 size={10} className="animate-spin" /> };
    default: return { color: 'bg-zinc-700/40 text-zinc-400 ring-zinc-600/40', label: status ?? '—', icon: <CircleDashed size={10} /> };
  }
}

export function SchedulesPane() {
  const schedules = useSchedulesStore((s) => s.schedules);
  const executions = useSchedulesStore((s) => s.executions);
  const liveTriggers = useSchedulesStore((s) => s.liveTriggers);
  const setSchedules = useSchedulesStore((s) => s.setSchedules);
  const upsertSchedule = useSchedulesStore((s) => s.upsertSchedule);
  const removeSchedule = useSchedulesStore((s) => s.removeSchedule);
  const setExecutionsInStore = useSchedulesStore((s) => s.setExecutions);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused' | 'failing'>('all');
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  /** Forces relative-time labels (e.g. "in 2m") to refresh once a minute. */
  const [, setTick] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Refresh "in 2m"-style labels every 30 seconds.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchSchedules();
      setSchedules(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [setSchedules]);

  useEffect(() => { void reload(); }, [reload]);

  const selected = useMemo(
    () => schedules.find((s) => s.id === selectedId) ?? null,
    [schedules, selectedId],
  );

  // Auto-load executions when selecting a schedule.
  useEffect(() => {
    if (!selected) return;
    if (executions[selected.id]) return;
    void fetchExecutions(selected.id)
      .then((list) => setExecutionsInStore(selected.id, list))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load executions'));
  }, [selected, executions, setExecutionsInStore]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return schedules.filter((s) => {
      if (statusFilter === 'active' && s.status !== 'active') return false;
      if (statusFilter === 'paused' && s.status !== 'paused') return false;
      if (statusFilter === 'failing' && s.lastStatus !== 'failed' && s.lastStatus !== 'timeout') return false;
      if (q && !(
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.cronExpr.toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [schedules, search, statusFilter]);

  const handleNew = useCallback(() => {
    setEditing({ ...EMPTY_FORM });
    setSelectedId(null);
  }, []);

  const handleEdit = useCallback((s: Schedule) => {
    setEditing({
      id: s.id,
      name: s.name,
      description: s.description,
      cronExpr: s.cronExpr,
      prompt: s.prompt,
      agentMode: s.agentMode,
      timezone: s.timezone,
      overlapPolicy: s.overlapPolicy,
      maxRetries: s.maxRetries,
      timeoutSec: s.timeoutSec,
      runAt: '',
    });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
    setError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!editing) return;
    const trimmedName = editing.name.trim();
    if (!trimmedName || !editing.cronExpr.trim() || !editing.prompt.trim()) {
      setError('Name, cron expression, and prompt are required');
      return;
    }
    if (!NAME_REGEX.test(trimmedName)) {
      setError('Name must start with a letter or digit and contain only letters, digits, spaces, hyphens, or underscores');
      return;
    }
    if (!isCronValid(editing.cronExpr)) {
      setError('Cron expression is invalid');
      return;
    }
    let runAtIso: string | undefined;
    if (!editing.id && editing.runAt.trim()) {
      const parsed = new Date(editing.runAt);
      if (Number.isNaN(parsed.getTime())) { setError('Run at: invalid date/time'); return; }
      if (parsed.getTime() <= Date.now()) { setError('Run at: must be in the future'); return; }
      runAtIso = parsed.toISOString();
    }
    setSubmitting(true);
    setError(null);
    try {
      const basePayload = {
        name: trimmedName,
        description: editing.description.trim(),
        cronExpr: editing.cronExpr.trim(),
        prompt: editing.prompt.trim(),
        agentMode: editing.agentMode,
        timezone: editing.timezone,
        overlapPolicy: editing.overlapPolicy,
        maxRetries: editing.maxRetries,
        timeoutSec: editing.timeoutSec,
      };
      const task = editing.id
        ? await updateSchedule(editing.id, basePayload)
        : await createSchedule(runAtIso ? { ...basePayload, runAt: runAtIso } : basePayload);
      upsertSchedule(task);
      setEditing(null);
      setSelectedId(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save schedule');
    } finally {
      setSubmitting(false);
    }
  }, [editing, upsertSchedule]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this schedule? Execution history will be preserved.')) return;
    try {
      await deleteSchedule(id);
      removeSchedule(id);
      if (selectedId === id) setSelectedId(null);
      setBulkSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }, [removeSchedule, selectedId]);

  const handlePause = useCallback(async (id: string) => {
    try { upsertSchedule(await pauseSchedule(id)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to pause'); }
  }, [upsertSchedule]);

  const handleResume = useCallback(async (id: string) => {
    try { upsertSchedule(await resumeSchedule(id)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to resume'); }
  }, [upsertSchedule]);

  const handleTrigger = useCallback(async (id: string) => {
    try { await triggerSchedule(id); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to trigger'); }
  }, []);

  // ── Bulk actions ─────────────────────────────────────────────────────
  const toggleBulk = useCallback((id: string) => {
    setBulkSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const handleBulkPause = useCallback(async () => {
    for (const id of bulkSelected) {
      const s = schedules.find((x) => x.id === id);
      if (s?.status === 'active') {
        try { upsertSchedule(await pauseSchedule(id)); } catch { /* continue */ }
      }
    }
    setBulkSelected(new Set());
  }, [bulkSelected, schedules, upsertSchedule]);

  const handleBulkResume = useCallback(async () => {
    for (const id of bulkSelected) {
      const s = schedules.find((x) => x.id === id);
      if (s?.status === 'paused') {
        try { upsertSchedule(await resumeSchedule(id)); } catch { /* continue */ }
      }
    }
    setBulkSelected(new Set());
  }, [bulkSelected, schedules, upsertSchedule]);

  const handleBulkDelete = useCallback(async () => {
    if (!confirm(`Delete ${bulkSelected.size} schedule(s)? Execution history will be preserved.`)) return;
    for (const id of bulkSelected) {
      try { await deleteSchedule(id); removeSchedule(id); } catch { /* continue */ }
    }
    if (selectedId && bulkSelected.has(selectedId)) setSelectedId(null);
    setBulkSelected(new Set());
  }, [bulkSelected, removeSchedule, selectedId]);

  // ── Keyboard shortcuts (scoped to this pane) ─────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (inField) return;
      if (e.key.toLowerCase() === 'n') { e.preventDefault(); handleNew(); return; }
      if (e.key === 'Escape') {
        if (editing) { setEditing(null); return; }
        if (selectedId) { setSelectedId(null); return; }
      }
      // Arrow keys move cursor in list (j/k retained as alias for vim users).
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        if (filtered.length === 0) return;
        const idx = filtered.findIndex((s) => s.id === selectedId);
        const goDown = e.key === 'ArrowDown' || e.key === 'j';
        const nextIdx = goDown
          ? Math.min(filtered.length - 1, idx < 0 ? 0 : idx + 1)
          : Math.max(0, idx <= 0 ? 0 : idx - 1);
        setSelectedId(filtered[nextIdx].id);
        setEditing(null);
        return;
      }
      // Enter opens detail (focus on first item if nothing selected).
      if (e.key === 'Enter' && !editing) {
        if (!selectedId && filtered.length > 0) {
          e.preventDefault();
          setSelectedId(filtered[0].id);
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, selectedId, filtered, handleNew]);

  // ── Layout ───────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className="flex h-full min-h-0">
      {/* Master list */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-zinc-800">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 bg-zinc-900/40">
          <CalendarClock size={12} className="text-zinc-500" />
          <span className="text-xs text-zinc-300 font-medium">Schedules</span>
          <span className="text-[10px] text-zinc-600">{schedules.length}</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void reload()}
              disabled={loading}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
              title="Refresh schedules"
              aria-label="Refresh schedules"
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={handleNew}
              className="flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-1 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25"
              title="New schedule (n)"
            >
              <Plus size={10} />
              New
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-zinc-800 px-2 py-1.5">
          <div className="relative flex-1">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter… ( / )"
              className="w-full rounded bg-zinc-800/60 border border-zinc-700/50 pl-7 pr-2 py-1 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-emerald-500/50"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-1 text-[10px] text-zinc-300 outline-none focus:border-emerald-500/50"
            aria-label="Filter by status"
          >
            <option value="all">all</option>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="failing">failing</option>
          </select>
        </div>

        {bulkSelected.size > 0 && (
          <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/50 px-2 py-1.5 text-[10px]">
            <span className="text-zinc-400">{bulkSelected.size} selected</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => void handleBulkResume()}
                className="rounded bg-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-700"
              >Resume</button>
              <button
                onClick={() => void handleBulkPause()}
                className="rounded bg-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-700"
              >Pause</button>
              <button
                onClick={() => void handleBulkDelete()}
                className="rounded bg-red-500/15 px-2 py-1 text-red-300 ring-1 ring-red-500/30 hover:bg-red-500/25"
              >Delete</button>
              <button
                onClick={() => setBulkSelected(new Set())}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                aria-label="Clear bulk selection"
                title="Clear bulk selection"
              >
                <X size={11} />
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {schedules.length === 0 && !loading ? (
            <EmptyState
              onTemplate={(t) => {
                setEditing({ ...EMPTY_FORM, ...t });
                setSelectedId(null);
              }}
            />
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-zinc-600">
              No schedules match the current filter.
            </div>
          ) : (
            <ul role="listbox" aria-label="Schedules">
              {filtered.map((s) => (
                <ScheduleRow
                  key={s.id}
                  schedule={s}
                  selected={s.id === selectedId}
                  bulkChecked={bulkSelected.has(s.id)}
                  isLive={liveTriggers.has(s.id)}
                  onSelect={() => { setSelectedId(s.id); setEditing(null); }}
                  onToggleBulk={() => toggleBulk(s.id)}
                  onRun={() => void handleTrigger(s.id)}
                  onPause={() => void handlePause(s.id)}
                  onResume={() => void handleResume(s.id)}
                  onEdit={() => handleEdit(s)}
                  onDelete={() => void handleDelete(s.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 min-w-0 flex flex-col">
        {error && (
          <div className="flex items-start gap-1.5 border-b border-red-500/30 bg-red-950/20 px-3 py-1.5 text-[11px] text-red-300">
            <AlertCircle size={11} className="mt-px shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-zinc-500 hover:text-zinc-200"
              aria-label="Dismiss error"
              title="Dismiss error"
            >
              <X size={11} />
            </button>
          </div>
        )}

        {editing ? (
          <ScheduleEditor
            form={editing}
            setForm={setEditing}
            onSubmit={handleSubmit}
            onCancel={handleCancelEdit}
            submitting={submitting}
          />
        ) : selected ? (
          <ScheduleDetail
            schedule={selected}
            executions={executions[selected.id] ?? []}
            isLive={liveTriggers.has(selected.id)}
            onSave={async (patch) => {
              try {
                const updated = await updateSchedule(selected.id, patch);
                upsertSchedule(updated);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to save');
              }
            }}
            onPause={() => void handlePause(selected.id)}
            onResume={() => void handleResume(selected.id)}
            onTrigger={() => void handleTrigger(selected.id)}
            onDelete={() => void handleDelete(selected.id)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
            Select a schedule to view details, or press <kbd className="mx-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px]">N</kbd> to create one.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────

function ScheduleRow({
  schedule,
  selected,
  bulkChecked,
  isLive,
  onSelect,
  onToggleBulk,
  onRun,
  onPause,
  onResume,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  selected: boolean;
  bulkChecked: boolean;
  isLive: boolean;
  onSelect: () => void;
  onToggleBulk: () => void;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const lastBadge = statusPill(schedule.lastStatus);
  // Stop propagation wrapper for row-level quick actions.
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <li
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`group flex cursor-pointer items-start gap-2 border-b border-zinc-800/50 px-2 py-2 transition-colors ${
        selected ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/30' : 'hover:bg-zinc-800/40'
      }`}
    >
      <input
        type="checkbox"
        checked={bulkChecked}
        onChange={onToggleBulk}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select ${schedule.name} for bulk action`}
        title={`Select ${schedule.name} for bulk action`}
        className="mt-0.5 h-3 w-3 cursor-pointer accent-emerald-500"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-zinc-200">{schedule.name}</span>
          {isLive && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-cyan-500/15 px-1 py-px text-[9px] font-semibold text-cyan-300 ring-1 ring-cyan-500/30"
              aria-label="Currently running"
              title="Currently running"
            >
              <Loader2 size={8} className="animate-spin" />
              live
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[10px] text-zinc-500 font-mono" title={schedule.cronExpr}>
          {schedule.cronExpr} · {describeLocal(schedule.cronExpr)}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-600">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              schedule.status === 'active' ? 'bg-emerald-500' : schedule.status === 'paused' ? 'bg-amber-500' : 'bg-zinc-600'
            }`}
            aria-label={`Status: ${schedule.status}`}
          />
          <span>{schedule.status}</span>
          <span>·</span>
          <Clock size={9} />
          <span title={schedule.nextRunAt ? formatTime(schedule.nextRunAt) : ''}>
            {formatRelative(schedule.nextRunAt)}
          </span>
          <span>·</span>
          <span className="tabular-nums" title={`${schedule.runCount} total runs`}>
            {schedule.runCount} run{schedule.runCount === 1 ? '' : 's'}
          </span>
          {schedule.lastStatus && (
            <>
              <span>·</span>
              <span
                className={`inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium ring-1 ring-inset ${lastBadge.color}`}
                title={`Last: ${lastBadge.label}`}
                aria-label={`Last run: ${lastBadge.label}`}
              >
                {lastBadge.icon}
                {lastBadge.label}
              </span>
            </>
          )}
        </div>
      </div>
      {/* Per-row quick actions (visible on hover or selection) */}
      <div
        className={`mt-px flex shrink-0 items-center gap-0.5 transition-opacity ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={stop(onRun)}
          title={`Run "${schedule.name}" now`}
          aria-label={`Run "${schedule.name}" now`}
          className="rounded p-1 text-cyan-400 hover:bg-cyan-500/15"
        >
          <Zap size={11} />
        </button>
        {schedule.status === 'active' ? (
          <button
            type="button"
            onClick={stop(onPause)}
            title={`Pause "${schedule.name}"`}
            aria-label={`Pause "${schedule.name}"`}
            className="rounded p-1 text-amber-400 hover:bg-amber-500/15"
          >
            <Pause size={11} />
          </button>
        ) : (
          <button
            type="button"
            onClick={stop(onResume)}
            title={`Resume "${schedule.name}"`}
            aria-label={`Resume "${schedule.name}"`}
            className="rounded p-1 text-emerald-400 hover:bg-emerald-500/15"
          >
            <Play size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={stop(onEdit)}
          title={`Edit "${schedule.name}"`}
          aria-label={`Edit "${schedule.name}"`}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-700"
        >
          <Sparkles size={11} />
        </button>
        <button
          type="button"
          onClick={stop(onDelete)}
          title={`Delete "${schedule.name}"`}
          aria-label={`Delete "${schedule.name}"`}
          className="rounded p-1 text-zinc-500 hover:bg-red-500/20 hover:text-red-300"
        >
          <Trash2 size={11} />
        </button>
      </div>
      <ChevronRight
        size={11}
        aria-hidden="true"
        className={`mt-1 shrink-0 text-zinc-700 transition-opacity ${selected ? 'opacity-100 text-emerald-400' : 'opacity-0'}`}
      />
    </li>
  );
}

function ScheduleDetail({
  schedule,
  executions,
  isLive,
  onSave,
  onPause,
  onResume,
  onTrigger,
  onDelete,
}: {
  schedule: Schedule;
  executions: Execution[];
  isLive: boolean;
  onSave: (patch: Partial<Schedule>) => Promise<void>;
  onPause: () => void;
  onResume: () => void;
  onTrigger: () => void;
  onDelete: () => void;
}) {
  const deepLinkToSession = useCallback((sessionId: string) => {
    if (typeof window === 'undefined' || !sessionId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    window.history.pushState({}, '', url.toString());
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);
  const [openExec, setOpenExec] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<'overview' | 'history' | 'settings'>('overview');
  const upcoming = useMemo(() => nextRuns(schedule.cronExpr, 5), [schedule.cronExpr]);

  // Success rate over last 20 runs (only counting completed/failed/timeout —
  // skipped runs don't reflect the prompt's success or failure).
  const successRate = useMemo(() => {
    const last20 = executions.slice(0, 20);
    const decided = last20.filter((e) => e.status === 'completed' || e.status === 'failed' || e.status === 'timeout');
    if (decided.length === 0) return null;
    const ok = decided.filter((e) => e.status === 'completed').length;
    return { rate: ok / decided.length, sample: decided.length, ok };
  }, [executions]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-start gap-3 border-b border-zinc-800 px-4 py-3 bg-zinc-900/30">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-zinc-100 truncate">{schedule.name}</h2>
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                schedule.status === 'active'
                  ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                  : schedule.status === 'paused'
                    ? 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
                    : 'bg-zinc-700/40 text-zinc-400 ring-zinc-600/40'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${
                schedule.status === 'active' ? 'bg-emerald-400' : schedule.status === 'paused' ? 'bg-amber-400' : 'bg-zinc-500'
              }`} />
              {schedule.status}
            </span>
            {isLive && (
              <span className="inline-flex items-center gap-1 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300 ring-1 ring-cyan-500/30">
                <Loader2 size={10} className="animate-spin" />
                running
              </span>
            )}
          </div>
          {schedule.description && (
            <p className="mt-1 text-[11px] text-zinc-400">{schedule.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onTrigger}
            className="flex items-center gap-1 rounded bg-cyan-500/15 px-2 py-1 text-[10px] font-medium text-cyan-300 ring-1 ring-cyan-500/30 hover:bg-cyan-500/25"
            title="Run now (Enter)"
          >
            <Zap size={10} />
            Run
          </button>
          {schedule.status === 'active' ? (
            <button
              onClick={onPause}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 text-[10px] font-medium text-amber-300 ring-1 ring-amber-500/30 hover:bg-amber-500/25"
            >
              <Pause size={10} />
              Pause
            </button>
          ) : (
            <button
              onClick={onResume}
              className="flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-1 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25"
            >
              <Play size={10} />
              Resume
            </button>
          )}
          <button
            onClick={onDelete}
            className="rounded p-1.5 text-zinc-500 hover:bg-red-500/20 hover:text-red-300"
            title="Delete schedule"
            aria-label="Delete schedule"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {/* Sub-section tabs (Overview / Run History / Settings) */}
      <div role="tablist" aria-label="Schedule details" className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-900/20 px-3 py-1">
        {(['overview', 'history', 'settings'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={subTab === t}
            onClick={() => setSubTab(t)}
            className={`rounded px-2 py-1 text-[10px] font-medium transition-colors ${
              subTab === t
                ? 'bg-zinc-800 text-emerald-300 ring-1 ring-emerald-500/30'
                : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
            }`}
          >
            {t === 'overview' ? 'Overview' : t === 'history' ? `Run History (${executions.length})` : 'Settings'}
          </button>
        ))}
      </div>

      {subTab === 'overview' && (
        <ScheduleOverview
          schedule={schedule}
          upcoming={upcoming}
          successRate={successRate}
        />
      )}

      {subTab === 'history' && (
        <RunHistoryTimeline
          schedule={schedule}
          executions={executions}
          openExec={openExec}
          setOpenExec={setOpenExec}
          deepLinkToSession={deepLinkToSession}
        />
      )}

      {subTab === 'settings' && (
        <ScheduleSettingsForm schedule={schedule} onSave={onSave} />
      )}
    </div>
  );
}

function ScheduleOverview({
  schedule,
  upcoming,
  successRate,
}: {
  schedule: Schedule;
  upcoming: Date[];
  successRate: { rate: number; sample: number; ok: number } | null;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 px-4 py-3 text-[11px]">
        <Field label="Cron" value={<span className="font-mono text-zinc-200">{schedule.cronExpr}</span>} />
        <Field label="Description" value={<span className="text-zinc-300">{describeLocal(schedule.cronExpr)}</span>} />
        <Field label="Timezone" value={<span className="font-mono text-zinc-300">{schedule.timezone}</span>} />
        <Field label="Mode" value={<span className="text-zinc-300">{schedule.agentMode}</span>} />
        <Field label="Next run" value={
          <span className="text-zinc-300" title={formatTime(schedule.nextRunAt)}>
            {formatRelative(schedule.nextRunAt)}{' · '}
            <span className="text-zinc-500">{formatTime(schedule.nextRunAt)}</span>
          </span>
        } />
        <Field label="Last run" value={
          <span className="text-zinc-300" title={formatTime(schedule.lastRunAt)}>
            {formatRelative(schedule.lastRunAt)}{' · '}
            <span className="text-zinc-500">{formatTime(schedule.lastRunAt)}</span>
          </span>
        } />
        <Field label="Total runs" value={<span className="text-zinc-300 tabular-nums">{schedule.runCount}</span>} />
        <Field
          label="Success rate (last 20)"
          value={
            successRate ? (
              <span
                className={`tabular-nums ${
                  successRate.rate >= 0.9 ? 'text-emerald-300' :
                  successRate.rate >= 0.5 ? 'text-amber-300' :
                  'text-red-300'
                }`}
                title={`${successRate.ok} of ${successRate.sample} decided runs succeeded`}
              >
                {(successRate.rate * 100).toFixed(0)}%
                <span className="ml-1 text-zinc-500">({successRate.ok}/{successRate.sample})</span>
              </span>
            ) : (
              <span className="text-zinc-500">no data yet</span>
            )
          }
        />
      </div>

      {upcoming.length > 0 && (
        <div className="px-4 pb-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            Next 5 runs <span className="ml-1 normal-case text-zinc-600">(local time)</span>
          </div>
          <ul className="rounded border border-zinc-800 bg-zinc-900/30 divide-y divide-zinc-800/60">
            {upcoming.map((d, i) => (
              <li key={i} className="flex items-center justify-between px-2.5 py-1 text-[11px]">
                <span className="text-zinc-300 tabular-nums">{d.toLocaleString()}</span>
                <span className="text-zinc-500">{formatRelative(d.toISOString())}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-4 pb-4">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Prompt</div>
        <pre className="whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-950/60 p-2 text-[11px] text-zinc-300">
          {schedule.prompt}
        </pre>
      </div>
    </>
  );
}

function RunHistoryTimeline({
  schedule,
  executions,
  openExec,
  setOpenExec,
  deepLinkToSession,
}: {
  schedule: Schedule;
  executions: Execution[];
  openExec: string | null;
  setOpenExec: (id: string | null) => void;
  deepLinkToSession: (sessionId: string) => void;
}) {
  return (
    <div className="px-4 py-3">
        {executions.length === 0 ? (
          <div className="rounded border border-zinc-800 bg-zinc-900/30 px-3 py-4 text-center text-[11px] text-zinc-500">
            No executions yet.
          </div>
        ) : (
          <ol className="relative ml-2 border-l border-zinc-800">
            {executions.map((ex) => {
              const b = statusPill(ex.status);
              const isOpen = openExec === ex.id;
              return (
                <li key={ex.id} className="relative pl-4 pb-2">
                  <span
                    className={`absolute -left-[5px] top-1.5 h-2 w-2 rounded-full ring-2 ring-[var(--background)] ${
                      ex.status === 'completed' ? 'bg-emerald-500' :
                      ex.status === 'failed' || ex.status === 'timeout' ? 'bg-red-500' :
                      ex.status === 'running' ? 'bg-cyan-500 animate-pulse' :
                      'bg-zinc-600'
                    }`}
                  />
                  <button
                    onClick={() => setOpenExec(isOpen ? null : ex.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-zinc-800/40"
                  >
                    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium ring-1 ring-inset ${b.color}`}>
                      {b.icon}
                      {b.label}
                    </span>
                    <span className="text-zinc-400 tabular-nums">{formatTime(ex.startedAt)}</span>
                    {ex.durationSec !== null && (
                      <span className="text-zinc-500">· {ex.durationSec.toFixed(1)}s</span>
                    )}
                    <span className="text-zinc-600">· {ex.triggerType}</span>
                    {ex.error && !isOpen && (
                      <span className="ml-auto truncate text-red-400" title={ex.error}>{ex.error}</span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="ml-2 mt-1 rounded border border-zinc-800 bg-zinc-950/60 p-2 text-[10px]">
                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-zinc-400">
                        <span className="text-zinc-500">Started</span><span>{formatTime(ex.startedAt)}</span>
                        <span className="text-zinc-500">Completed</span><span>{formatTime(ex.completedAt)}</span>
                        <span className="text-zinc-500">Duration</span>
                        <span>{ex.durationSec !== null ? `${ex.durationSec.toFixed(2)}s` : '—'}</span>
                        <span className="text-zinc-500">Trigger</span><span>{ex.triggerType}</span>
                        <span className="text-zinc-500">Execution ID</span>
                        <span className="font-mono text-zinc-600 truncate" title={ex.id}>{ex.id}</span>
                      </div>
                      {ex.error && (
                        <div className="mt-1.5 rounded bg-red-500/10 px-2 py-1 text-red-300 ring-1 ring-red-500/20">
                          {ex.error}
                        </div>
                      )}
                      {schedule.sessionId && (
                        <button
                          type="button"
                          onClick={() => deepLinkToSession(schedule.sessionId)}
                          className="mt-1.5 inline-flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-700"
                          title="Open this schedule's session in chat"
                          aria-label="Open this schedule's session in chat"
                        >
                          Open session
                          <ChevronRight size={10} />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-widest text-zinc-600">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}

/**
 * In-detail Settings sub-section: lets the user edit the selected schedule
 * inline (without leaving detail view) and Save patches via PUT. Only
 * fields that actually changed are sent in the patch.
 */
function ScheduleSettingsForm({
  schedule,
  onSave,
}: {
  schedule: Schedule;
  onSave: (patch: Partial<Schedule>) => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    id: schedule.id,
    name: schedule.name,
    description: schedule.description,
    cronExpr: schedule.cronExpr,
    prompt: schedule.prompt,
    agentMode: schedule.agentMode,
    timezone: schedule.timezone,
    overlapPolicy: schedule.overlapPolicy,
    maxRetries: schedule.maxRetries,
    timeoutSec: schedule.timeoutSec,
    runAt: '',
  }));
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset form when the user switches to a different schedule.
  useEffect(() => {
    setForm({
      id: schedule.id,
      name: schedule.name,
      description: schedule.description,
      cronExpr: schedule.cronExpr,
      prompt: schedule.prompt,
      agentMode: schedule.agentMode,
      timezone: schedule.timezone,
      overlapPolicy: schedule.overlapPolicy,
      maxRetries: schedule.maxRetries,
      timeoutSec: schedule.timeoutSec,
      runAt: '',
    });
  }, [schedule]);

  const cronValid = useMemo(() => isCronValid(form.cronExpr), [form.cronExpr]);
  const upcoming = useMemo(() => (cronValid ? nextRuns(form.cronExpr, 5) : []), [form.cronExpr, cronValid]);
  const nameTrimmed = form.name.trim();
  const nameValid = nameTrimmed.length > 0 && NAME_REGEX.test(nameTrimmed);
  const promptValid = form.prompt.trim().length > 0;
  const dirty =
    form.name.trim() !== schedule.name ||
    form.description.trim() !== schedule.description ||
    form.cronExpr.trim() !== schedule.cronExpr ||
    form.prompt.trim() !== schedule.prompt ||
    form.agentMode !== schedule.agentMode ||
    form.timezone !== schedule.timezone ||
    form.overlapPolicy !== schedule.overlapPolicy ||
    form.maxRetries !== schedule.maxRetries ||
    form.timeoutSec !== schedule.timeoutSec;
  const canSave = !saving && dirty && nameValid && cronValid && promptValid;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setLocalError(null);
    try {
      await onSave({
        name: form.name.trim(),
        description: form.description.trim(),
        cronExpr: form.cronExpr.trim(),
        prompt: form.prompt.trim(),
        agentMode: form.agentMode,
        timezone: form.timezone,
        overlapPolicy: form.overlapPolicy,
        maxRetries: form.maxRetries,
        timeoutSec: form.timeoutSec,
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {localError && (
        <div className="rounded border border-red-500/30 bg-red-950/20 px-2 py-1.5 text-[11px] text-red-300">
          {localError}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Name</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            aria-invalid={nameTrimmed.length > 0 && !nameValid}
            className={`rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border outline-none ${
              nameTrimmed.length > 0 && !nameValid
                ? 'border-red-600 focus:border-red-500'
                : 'border-zinc-700 focus:border-emerald-500/60'
            }`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Cron</span>
          <input
            type="text"
            value={form.cronExpr}
            onChange={(e) => setForm({ ...form, cronExpr: e.target.value })}
            aria-invalid={!cronValid}
            className={`rounded bg-zinc-800 px-2 py-1.5 text-xs font-mono text-zinc-200 border outline-none ${
              cronValid ? 'border-zinc-700 focus:border-emerald-500/60' : 'border-red-600 focus:border-red-500'
            }`}
          />
          <span className={`text-[10px] ${cronValid ? 'text-zinc-400' : 'text-red-400'}`}>
            {describeLocal(form.cronExpr)}
          </span>
        </label>
      </div>

      {upcoming.length > 0 && (
        <div className="rounded border border-zinc-800 bg-zinc-900/30 px-2.5 py-1.5">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-500">
            Next 5 runs <span className="normal-case text-zinc-600">(local time)</span>
          </div>
          <ul className="text-[10px]">
            {upcoming.map((d, i) => (
              <li key={i} className="flex justify-between">
                <span className="text-zinc-300 tabular-nums">{d.toLocaleString()}</span>
                <span className="text-zinc-500">{formatRelative(d.toISOString())}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Description</span>
        <input
          type="text"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 focus:border-emerald-500/60 outline-none"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Prompt</span>
        <textarea
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          rows={4}
          className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 focus:border-emerald-500/60 outline-none resize-y"
        />
      </label>

      <details className="rounded border border-zinc-700/60 bg-zinc-800/30 px-3 py-2">
        <summary className="cursor-pointer text-[11px] text-zinc-300 select-none">Advanced</summary>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">Mode</span>
            <select
              value={form.agentMode}
              onChange={(e) => setForm({ ...form, agentMode: e.target.value as FormState['agentMode'] })}
              className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
            >
              <option value="orchestrate">orchestrate</option>
              <option value="direct">direct</option>
              <option value="code">code</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">Timezone</span>
            <select
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
            >
              {!TIMEZONE_OPTIONS.includes(form.timezone) && (
                <option value={form.timezone}>{form.timezone}</option>
              )}
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">Overlap</span>
            <select
              value={form.overlapPolicy}
              onChange={(e) => setForm({ ...form, overlapPolicy: e.target.value as FormState['overlapPolicy'] })}
              className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
            >
              <option value="skip">skip</option>
              <option value="queue">queue</option>
              <option value="allow">allow</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">Timeout (sec)</span>
            <input
              type="number"
              min={0}
              max={7200}
              value={form.timeoutSec}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                setForm({ ...form, timeoutSec: Number.isNaN(n) ? 0 : Math.max(0, Math.min(7200, n)) });
              }}
              className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
            />
          </label>
        </div>
      </details>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSave}
          className="flex items-center gap-1 rounded bg-emerald-500/20 px-3 py-1.5 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Save changes
        </button>
        {dirty && !saving && (
          <span className="text-[10px] text-amber-400">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}

function ScheduleEditor({
  form,
  setForm,
  onSubmit,
  onCancel,
  submitting,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const cronValid = useMemo(() => isCronValid(form.cronExpr), [form.cronExpr]);
  const cronDescription = useMemo(() => describeLocal(form.cronExpr), [form.cronExpr]);
  const upcoming = useMemo(() => (cronValid ? nextRuns(form.cronExpr, 5) : []), [form.cronExpr, cronValid]);
  const nameTrimmed = form.name.trim();
  const nameValid = nameTrimmed.length > 0 && NAME_REGEX.test(nameTrimmed);
  const promptValid = form.prompt.trim().length > 0;
  const formValid = nameValid && cronValid && promptValid;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 bg-zinc-900/30">
        <h3 className="text-xs font-semibold text-zinc-200">
          {form.id ? 'Edit schedule' : 'New schedule'}
        </h3>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={submitting || !formValid}
            title={!formValid ? 'Fix validation errors below' : undefined}
            className="flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-1 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
            {form.id ? 'Save' : 'Create'}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Daily standup digest"
              aria-invalid={nameTrimmed.length > 0 && !nameValid}
              className={`rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border outline-none ${
                nameTrimmed.length > 0 && !nameValid
                  ? 'border-red-600 focus:border-red-500'
                  : 'border-zinc-700 focus:border-emerald-500/60'
              }`}
            />
            {nameTrimmed.length > 0 && !nameValid && (
              <span className="text-[10px] text-red-400">
                Use letters, digits, spaces, hyphens, or underscores. Must start with a letter or digit.
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Cron expression</span>
            <input
              type="text"
              value={form.cronExpr}
              onChange={(e) => setForm({ ...form, cronExpr: e.target.value })}
              placeholder="0 9 * * *"
              aria-invalid={!cronValid}
              className={`rounded bg-zinc-800 px-2 py-1.5 text-xs font-mono text-zinc-200 border outline-none ${
                cronValid ? 'border-zinc-700 focus:border-emerald-500/60' : 'border-red-600 focus:border-red-500'
              }`}
            />
            <span className={`text-[10px] ${cronValid ? 'text-zinc-400' : 'text-red-400'}`}>
              {cronDescription}
            </span>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.expr}
                  type="button"
                  onClick={() => setForm({ ...form, cronExpr: p.expr })}
                  className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </label>
        </div>

        {upcoming.length > 0 && (
          <div className="rounded border border-zinc-800 bg-zinc-900/30 px-2.5 py-1.5">
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-500">
              Next 5 runs <span className="normal-case text-zinc-600">(local time)</span>
            </div>
            <ul className="grid grid-cols-1 gap-y-0.5 text-[10px]">
              {upcoming.map((d, i) => (
                <li key={i} className="flex justify-between">
                  <span className="text-zinc-300 tabular-nums">{d.toLocaleString()}</span>
                  <span className="text-zinc-500">{formatRelative(d.toISOString())}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Description (optional)</span>
          <input
            type="text"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 focus:border-emerald-500/60 outline-none"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Prompt</span>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder="Summarize yesterday's commits and post to #dev-updates"
            rows={4}
            className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 focus:border-emerald-500/60 outline-none resize-y"
          />
        </label>

        <details className="rounded border border-zinc-700/60 bg-zinc-800/30 px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-zinc-300 select-none">Advanced</summary>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">Mode</span>
              <select
                value={form.agentMode}
                onChange={(e) => setForm({ ...form, agentMode: e.target.value as FormState['agentMode'] })}
                className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
              >
                <option value="orchestrate">orchestrate</option>
                <option value="direct">direct</option>
                <option value="code">code</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">Timezone</span>
              <select
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
              >
                {!TIMEZONE_OPTIONS.includes(form.timezone) && (
                  <option value={form.timezone}>{form.timezone}</option>
                )}
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">Overlap</span>
              <select
                value={form.overlapPolicy}
                onChange={(e) => setForm({ ...form, overlapPolicy: e.target.value as FormState['overlapPolicy'] })}
                className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
              >
                <option value="skip">skip</option>
                <option value="queue">queue</option>
                <option value="allow">allow</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">Timeout (sec)</span>
              <input
                type="number"
                min={0}
                max={7200}
                value={form.timeoutSec}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setForm({ ...form, timeoutSec: Number.isNaN(n) ? 0 : Math.max(0, Math.min(7200, n)) });
                }}
                className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">Max retries (0–5, reserved)</span>
              <input
                type="number"
                min={0}
                max={5}
                value={form.maxRetries}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setForm({ ...form, maxRetries: Number.isNaN(n) ? 0 : Math.max(0, Math.min(5, n)) });
                }}
                className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
              />
            </label>
            {!form.id && (
              <label className="flex flex-col gap-1 col-span-2">
                <span className="text-[10px] text-zinc-500">One-shot run at (optional)</span>
                <input
                  type="datetime-local"
                  value={form.runAt}
                  onChange={(e) => setForm({ ...form, runAt: e.target.value })}
                  className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 w-fit"
                />
                <span className="text-[10px] text-zinc-500">
                  Leave empty for a recurring schedule. When set, the cron expression is ignored on the first fire.
                </span>
              </label>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

function EmptyState({ onTemplate }: { onTemplate: (t: { name: string; description: string; cronExpr: string; prompt: string; agentMode: FormState['agentMode'] }) => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-3 py-6 text-center">
      <CalendarClock size={28} className="text-zinc-700" />
      <div className="text-xs text-zinc-400">No scheduled tasks yet</div>
      <div className="max-w-[280px] text-[10px] text-zinc-600">
        Run prompts on a cron schedule. Tasks fire through the agent exactly like chat messages. Start from a template:
      </div>
      <div className="flex w-full flex-col gap-1.5">
        {TEMPLATES.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => onTemplate(t)}
            className="group flex flex-col gap-0.5 rounded border border-zinc-800 bg-zinc-900/40 px-2.5 py-1.5 text-left hover:border-emerald-500/40 hover:bg-emerald-500/5"
          >
            <div className="flex items-center gap-1.5">
              <Sparkles size={10} className="text-emerald-400" />
              <span className="text-[11px] font-medium text-zinc-200">{t.name}</span>
            </div>
            <span className="text-[10px] text-zinc-500">{t.description}</span>
            <span className="font-mono text-[9px] text-zinc-600">{t.cronExpr} · {describeLocal(t.cronExpr)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

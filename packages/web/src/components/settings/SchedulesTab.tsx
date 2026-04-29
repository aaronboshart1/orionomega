'use client';

/**
 * @module SchedulesTab
 * Settings sub-tab for managing scheduled (cron) tasks.
 *
 * Lists all schedules from the gateway, supports inline create/edit/delete,
 * pause/resume/trigger actions, and a per-task execution history drawer.
 * Subscribes to `useSchedulesStore` for live updates from the WS handler.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Play, Pause, Zap, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
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
} from '@/stores/schedules';

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
  /** When set (ISO 8601), task runs once at this time then auto-pauses. Create-only. */
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
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Every day at 9am', expr: '0 9 * * *' },
  { label: 'Every Monday at 9am', expr: '0 9 * * 1' },
  { label: 'First of month', expr: '0 0 1 * *' },
];

/**
 * Curated subset of common IANA timezones. The browser's
 * `Intl.supportedValuesOf('timeZone')` returns 400+ entries which is
 * impractical for a single dropdown; fall back to that list when available
 * so users on more exotic zones still get coverage.
 */
const COMMON_TIMEZONES: string[] = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Moscow',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function getTimezoneOptions(): string[] {
  try {
    const intlAny = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof intlAny.supportedValuesOf === 'function') {
      const all = intlAny.supportedValuesOf('timeZone');
      if (Array.isArray(all) && all.length > 0) {
        return ['UTC', ...all.filter((t) => t !== 'UTC')];
      }
    }
  } catch {
    /* fall through */
  }
  return COMMON_TIMEZONES;
}

const TIMEZONE_OPTIONS = getTimezoneOptions();

/** Mirrors the gateway's createScheduleSchema name regex. */
const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/;

function isCronValid(expr: string): boolean {
  if (!expr.trim()) return false;
  try {
    cronstrue.toString(expr);
    return true;
  } catch {
    return false;
  }
}

function describeLocal(expr: string): string {
  try {
    return cronstrue.toString(expr, { verbose: false });
  } catch {
    return 'Invalid expression';
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function statusBadge(status: string | null): { color: string; label: string } {
  switch (status) {
    case 'completed': return { color: 'bg-green-700 text-green-200', label: 'OK' };
    case 'failed': return { color: 'bg-red-700 text-red-200', label: 'Failed' };
    case 'timeout': return { color: 'bg-amber-700 text-amber-200', label: 'Timeout' };
    case 'skipped': return { color: 'bg-zinc-700 text-zinc-300', label: 'Skipped' };
    case 'running': return { color: 'bg-blue-700 text-blue-200', label: 'Running' };
    default: return { color: 'bg-zinc-800 text-zinc-400', label: status ?? '—' };
  }
}

export function SchedulesTab() {
  const schedules = useSchedulesStore((s) => s.schedules);
  const executions = useSchedulesStore((s) => s.executions);
  const liveTriggers = useSchedulesStore((s) => s.liveTriggers);
  const setSchedules = useSchedulesStore((s) => s.setSchedules);
  const upsertSchedule = useSchedulesStore((s) => s.upsertSchedule);
  const removeSchedule = useSchedulesStore((s) => s.removeSchedule);
  const setExecutionsInStore = useSchedulesStore((s) => s.setExecutions);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const handleSubmit = useCallback(async () => {
    const trimmedName = form.name.trim();
    if (!trimmedName || !form.cronExpr.trim() || !form.prompt.trim()) {
      setError('Name, cron expression, and prompt are required');
      return;
    }
    if (!NAME_REGEX.test(trimmedName)) {
      setError(
        'Name must start with a letter or digit and contain only letters, digits, spaces, hyphens, or underscores',
      );
      return;
    }
    if (!isCronValid(form.cronExpr)) {
      setError('Cron expression is invalid');
      return;
    }
    // Validate runAt (one-shot) if provided; must parse to a valid date in the future.
    let runAtIso: string | undefined;
    if (!form.id && form.runAt.trim()) {
      const parsed = new Date(form.runAt);
      if (Number.isNaN(parsed.getTime())) {
        setError('Run at: invalid date/time');
        return;
      }
      if (parsed.getTime() <= Date.now()) {
        setError('Run at: must be in the future');
        return;
      }
      runAtIso = parsed.toISOString();
    }
    setSubmitting(true);
    setError(null);
    try {
      const basePayload = {
        name: trimmedName,
        description: form.description.trim(),
        cronExpr: form.cronExpr.trim(),
        prompt: form.prompt.trim(),
        agentMode: form.agentMode,
        timezone: form.timezone,
        overlapPolicy: form.overlapPolicy,
        maxRetries: form.maxRetries,
        timeoutSec: form.timeoutSec,
      };
      let task: Schedule;
      if (form.id) {
        // runAt is create-only on the server; don't include it on update.
        task = await updateSchedule(form.id, basePayload);
      } else {
        task = await createSchedule(
          runAtIso ? { ...basePayload, runAt: runAtIso } : basePayload,
        );
      }
      upsertSchedule(task);
      setShowForm(false);
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save schedule');
    } finally {
      setSubmitting(false);
    }
  }, [form, upsertSchedule]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this schedule? Execution history will be preserved.')) return;
    try {
      await deleteSchedule(id);
      removeSchedule(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }, [removeSchedule]);

  const handlePause = useCallback(async (id: string) => {
    try {
      const task = await pauseSchedule(id);
      upsertSchedule(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pause');
    }
  }, [upsertSchedule]);

  const handleResume = useCallback(async (id: string) => {
    try {
      const task = await resumeSchedule(id);
      upsertSchedule(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume');
    }
  }, [upsertSchedule]);

  const handleTrigger = useCallback(async (id: string) => {
    try {
      await triggerSchedule(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger');
    }
  }, []);

  const handleExpand = useCallback(async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    try {
      const list = await fetchExecutions(id);
      setExecutionsInStore(id, list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load executions');
    }
  }, [expandedId, setExecutionsInStore]);

  const cronDescription = useMemo(() => describeLocal(form.cronExpr), [form.cronExpr]);
  const cronValid = useMemo(() => isCronValid(form.cronExpr), [form.cronExpr]);
  const nameTrimmed = form.name.trim();
  const nameValid = nameTrimmed.length > 0 && NAME_REGEX.test(nameTrimmed);
  const promptValid = form.prompt.trim().length > 0;
  const formValid = nameValid && cronValid && promptValid;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Scheduled Tasks</h3>
          <p className="text-xs text-zinc-500 mt-1">
            Run prompts automatically on a cron schedule. Tasks fire through the agent exactly like chat messages.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={reload}
            disabled={loading}
            className="flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => { setForm(EMPTY_FORM); setShowForm(true); }}
            className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
          >
            <Plus size={12} />
            New schedule
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-700 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {showForm && (
        <div className="rounded border border-zinc-700 bg-zinc-900/50 p-4 flex flex-col gap-3">
          <h4 className="text-sm font-medium text-zinc-200">
            {form.id ? 'Edit schedule' : 'Create schedule'}
          </h4>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Name</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Daily standup digest"
                aria-invalid={nameTrimmed.length > 0 && !nameValid}
                className={`rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border outline-none ${
                  nameTrimmed.length > 0 && !nameValid
                    ? 'border-red-600 focus:border-red-500'
                    : 'border-zinc-700 focus:border-blue-500'
                }`}
              />
              {nameTrimmed.length > 0 && !nameValid && (
                <span className="text-[11px] text-red-400">
                  Use letters, digits, spaces, hyphens, or underscores. Must start with a letter or digit.
                </span>
              )}
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Cron expression</span>
              <input
                type="text"
                value={form.cronExpr}
                onChange={(e) => setForm({ ...form, cronExpr: e.target.value })}
                placeholder="0 9 * * *"
                aria-invalid={!cronValid}
                className={`rounded bg-zinc-800 px-2 py-1.5 text-xs font-mono text-zinc-200 border outline-none ${
                  cronValid ? 'border-zinc-700 focus:border-blue-500' : 'border-red-600 focus:border-red-500'
                }`}
              />
              <span className={`text-[11px] ${cronValid ? 'text-zinc-500' : 'text-red-400'}`}>
                {cronDescription}
              </span>
              <div className="flex flex-wrap gap-1 mt-1">
                {PRESETS.map((p) => (
                  <button
                    key={p.expr}
                    type="button"
                    onClick={() => setForm({ ...form, cronExpr: p.expr })}
                    className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Description (optional)</span>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 focus:border-blue-500 outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Prompt</span>
            <textarea
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="Summarize yesterday's commits and post to #dev-updates"
              rows={3}
              className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 focus:border-blue-500 outline-none resize-y"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Agent mode</span>
            <select
              value={form.agentMode}
              onChange={(e) => setForm({ ...form, agentMode: e.target.value as FormState['agentMode'] })}
              className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 w-fit"
            >
              <option value="orchestrate">orchestrate</option>
              <option value="direct">direct</option>
              <option value="code">code</option>
            </select>
          </label>

          {/* Collapsible "Advanced" panel groups the optional tuning knobs
              (timezone, overlap policy, retries, timeout, one-shot runAt)
              so the form's primary fields stay uncluttered for the common
              "name + cron + prompt" workflow. */}
          <details className="rounded border border-zinc-700/60 bg-zinc-800/30 px-3 py-2">
            <summary className="cursor-pointer text-xs text-zinc-300 select-none">
              Advanced
            </summary>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">Timezone</span>
                <select
                  value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                  className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
                >
                  {/* If the current value isn't in the list (legacy data), include it. */}
                  {!TIMEZONE_OPTIONS.includes(form.timezone) && (
                    <option value={form.timezone}>{form.timezone}</option>
                  )}
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">Overlap policy</span>
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
                <span className="text-xs text-zinc-400">Max retries (0–5, reserved)</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={form.maxRetries}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const clamped = Number.isNaN(n) ? 0 : Math.max(0, Math.min(5, n));
                    setForm({ ...form, maxRetries: clamped });
                  }}
                  className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
                />
                <span className="text-[10px] text-zinc-500">
                  Reserved for future automatic retry support; not yet wired into execution.
                </span>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">Timeout (sec, 0 = none)</span>
                <input
                  type="number"
                  min={0}
                  max={7200}
                  value={form.timeoutSec}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const clamped = Number.isNaN(n) ? 0 : Math.max(0, Math.min(7200, n));
                    setForm({ ...form, timeoutSec: clamped });
                  }}
                  className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700"
                />
              </label>
            </div>

            {!form.id && (
              <label className="mt-3 flex flex-col gap-1">
                <span className="text-xs text-zinc-400">
                  One-shot run at (optional) — auto-pauses after firing once
                </span>
                <input
                  type="datetime-local"
                  value={form.runAt}
                  onChange={(e) => setForm({ ...form, runAt: e.target.value })}
                  className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 border border-zinc-700 focus:border-blue-500 outline-none w-fit"
                />
                <span className="text-[11px] text-zinc-500">
                  Leave empty for a recurring schedule. When set, the cron expression is ignored on the first fire.
                </span>
              </label>
            )}
          </details>

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); setError(null); }}
              disabled={submitting}
              className="rounded bg-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || !formValid}
              title={!formValid ? 'Fix validation errors above to enable' : undefined}
              className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting && <Loader2 size={12} className="animate-spin" />}
              {form.id ? 'Save changes' : 'Create schedule'}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {schedules.length === 0 && !loading && (
          <div className="rounded border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-xs text-zinc-500">
            No scheduled tasks yet. Create one to run prompts on a cron schedule.
          </div>
        )}

        {schedules.map((s) => {
          const isExpanded = expandedId === s.id;
          const isLive = liveTriggers.has(s.id);
          const badge = statusBadge(s.lastStatus);
          const execList = executions[s.id] ?? [];
          return (
            <div key={s.id} className="rounded border border-zinc-700 bg-zinc-900/30">
              <div className="flex items-center gap-3 p-3">
                <button
                  onClick={() => handleExpand(s.id)}
                  className="text-zinc-400 hover:text-zinc-200"
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-zinc-200 truncate">{s.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                      s.status === 'active' ? 'bg-green-900 text-green-300' :
                      s.status === 'paused' ? 'bg-amber-900 text-amber-300' :
                      'bg-zinc-800 text-zinc-400'
                    }`}>
                      {s.status}
                    </span>
                    {isLive && (
                      <span className="rounded px-1.5 py-0.5 text-[10px] bg-blue-700 text-blue-200 animate-pulse">
                        running…
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5 truncate">
                    <span className="font-mono">{s.cronExpr}</span> · {describeLocal(s.cronExpr)} · {s.timezone}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5">
                    Next: {formatTime(s.nextRunAt)} · Last: {formatTime(s.lastRunAt)} · Runs: {s.runCount}
                    {s.lastStatus && <> · <span className={`rounded px-1 ${badge.color}`}>{badge.label}</span></>}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleTrigger(s.id)}
                    title="Run now"
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-blue-400"
                  >
                    <Zap size={14} />
                  </button>
                  {s.status === 'active' ? (
                    <button
                      onClick={() => handlePause(s.id)}
                      title="Pause"
                      className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-amber-400"
                    >
                      <Pause size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleResume(s.id)}
                      title="Resume"
                      className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-green-400"
                    >
                      <Play size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setForm({
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
                      setShowForm(true);
                    }}
                    className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(s.id)}
                    title="Delete"
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-zinc-800 px-3 py-2 flex flex-col gap-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Prompt</div>
                    <div className="text-xs text-zinc-300 whitespace-pre-wrap rounded bg-zinc-950/60 p-2 border border-zinc-800">
                      {s.prompt}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Recent executions</div>
                    {execList.length === 0 ? (
                      <div className="text-xs text-zinc-500 italic">No executions yet.</div>
                    ) : (
                      <div className="flex flex-col divide-y divide-zinc-800 rounded border border-zinc-800">
                        {execList.map((ex) => {
                          const b = statusBadge(ex.status);
                          return (
                            <div key={ex.id} className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                              <span className={`rounded px-1.5 py-0.5 ${b.color}`}>{b.label}</span>
                              <span className="text-zinc-500">{formatTime(ex.startedAt)}</span>
                              {ex.durationSec !== null && (
                                <span className="text-zinc-500">· {ex.durationSec.toFixed(1)}s</span>
                              )}
                              <span className="text-zinc-600">· {ex.triggerType}</span>
                              {ex.error && (
                                <span className="text-red-400 truncate ml-auto" title={ex.error}>{ex.error}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

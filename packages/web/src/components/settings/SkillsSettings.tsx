'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCw, ChevronDown, ChevronRight, AlertCircle, CheckCircle } from 'lucide-react';

interface SkillSettingSchema {
  type: string | string[];
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  default?: string | number | boolean | string[];
  group?: string;
  widget?: string;
  options?: Array<{ label: string; value: string }>;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    enum?: Array<string | number | boolean>;
  };
  order?: number;
  hidden?: boolean;
  dependsOn?: string;
}

interface SkillSettingsBlock {
  type: 'object';
  properties: Record<string, SkillSettingSchema>;
  required?: string[];
}

interface SkillInfo {
  name: string;
  version: string;
  description: string;
  author: string;
  icon?: string;
  enabled: boolean;
  configured: boolean;
  schema?: SkillSettingsBlock;
  settings: Record<string, unknown>;
}

function SkillField({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: SkillSettingSchema;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}) {
  if (schema.hidden) return null;

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const isPassword = types.includes('password') || schema.widget === 'secret';
  const isBoolean = types.includes('boolean');
  const isNumber = types.includes('number');
  const isSelect = types.includes('select');
  const isTextarea = types.includes('textarea') || schema.widget === 'textarea';

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
        {schema.label}
        {schema.required && <span className="text-red-400">*</span>}
      </label>
      {schema.description && (
        <p className="text-[11px] text-zinc-500 leading-relaxed">{schema.description}</p>
      )}
      <div className="mt-1">
        {isBoolean ? (
          <button
            type="button"
            onClick={() => onChange(name, !value)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              value ? 'bg-blue-600' : 'bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                value ? 'translate-x-4' : 'translate-x-1'
              }`}
            />
          </button>
        ) : isSelect && schema.options ? (
          <select
            value={String(value ?? '')}
            onChange={(e) => onChange(name, e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500"
          >
            <option value="">Select...</option>
            {schema.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : isTextarea ? (
          <textarea
            value={String(value ?? '')}
            onChange={(e) => onChange(name, e.target.value)}
            placeholder={schema.placeholder}
            rows={3}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500 resize-y"
          />
        ) : isNumber ? (
          <input
            type="number"
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(name, e.target.value ? Number(e.target.value) : undefined)}
            placeholder={schema.placeholder}
            min={schema.validation?.min}
            max={schema.validation?.max}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500"
          />
        ) : (
          <input
            type={isPassword ? 'password' : 'text'}
            value={String(value ?? '')}
            onChange={(e) => onChange(name, e.target.value)}
            placeholder={schema.placeholder}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500"
          />
        )}
      </div>
    </div>
  );
}

function GoogleOAuthSection({ skillSettings }: { skillSettings: Record<string, unknown> }) {
  const [authStatus, setAuthStatus] = useState<{
    authenticated: boolean;
    email?: string;
    tokenAge?: string;
    reason?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState('');

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/gateway/api/skills/google-workspace/oauth/status');
      if (res.ok) {
        const data = await res.json();
        setAuthStatus(data);
        return data.authenticated;
      }
    } catch {}
    return false;
  }, []);

  useEffect(() => {
    checkStatus().finally(() => setLoading(false));
  }, [checkStatus]);

  const handleAuthenticate = async () => {
    setAuthenticating(true);
    setError('');

    // Open a blank window synchronously within the user gesture context.
    // Browsers block window.open() called after an await (gesture context is lost).
    const popup = window.open('about:blank', '_blank');

    try {
      const res = await fetch('/api/gateway/api/skills/google-workspace/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        popup?.close();
        const body = await res.json().catch(() => ({ error: 'Failed to start OAuth' }));
        throw new Error((body as { error?: string }).error || 'Failed to start OAuth flow');
      }

      const data = await res.json();

      if (data.authUrl) {
        if (popup) {
          popup.location.href = data.authUrl;
        } else {
          window.open(data.authUrl, '_blank');
        }

        let attempts = 0;
        const maxAttempts = 40;
        const pollInterval = setInterval(async () => {
          attempts++;
          const isAuth = await checkStatus();
          if (isAuth || attempts >= maxAttempts) {
            clearInterval(pollInterval);
            setAuthenticating(false);
            if (!isAuth && attempts >= maxAttempts) {
              setError('Authentication timed out. Please try again.');
            }
          }
        }, 3000);
      } else {
        popup?.close();
        throw new Error((data as { error?: string }).error || 'No auth URL returned');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setAuthenticating(false);
    }
  };

  void skillSettings;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Loader2 size={12} className="animate-spin text-zinc-500" />
        <span className="text-[11px] text-zinc-500">Checking auth status...</span>
      </div>
    );
  }

  return (
    <div className="space-y-2 pt-1 border-t border-zinc-800">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Google Authentication
      </h4>

      <div className="flex items-center gap-2">
        {authStatus?.authenticated ? (
          <>
            <CheckCircle size={12} className="text-green-500" />
            <span className="text-[11px] text-green-400">
              Authenticated as {authStatus.email}
            </span>
            {authStatus.tokenAge && (
              <span className="text-[10px] text-zinc-600">({authStatus.tokenAge})</span>
            )}
          </>
        ) : (
          <>
            <AlertCircle size={12} className="text-amber-500" />
            <span className="text-[11px] text-amber-400">Not authenticated</span>
          </>
        )}
      </div>

      {error && (
        <p className="text-[11px] text-red-400">{error}</p>
      )}

      <button
        onClick={handleAuthenticate}
        disabled={authenticating}
        className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {authenticating ? (
          <>
            <Loader2 size={11} className="animate-spin" />
            Waiting for authentication...
          </>
        ) : authStatus?.authenticated ? (
          <>
            <RefreshCw size={11} />
            Re-authenticate
          </>
        ) : (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Authenticate with Google
          </>
        )}
      </button>

      {authenticating && (
        <p className="text-[10px] text-zinc-500">
          A Google sign-in page has been opened in your browser.
          Complete the sign-in there, then this will update automatically.
        </p>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  onSave,
  onToggle,
}: {
  skill: SkillInfo;
  onSave: (name: string, settings: Record<string, unknown>, enabled: boolean) => Promise<void>;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [localSettings, setLocalSettings] = useState<Record<string, unknown>>(skill.settings);
  const [localEnabled, setLocalEnabled] = useState(skill.enabled);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [saveResult, setSaveResult] = useState<'idle' | 'success' | 'error'>('idle');

  useEffect(() => {
    setLocalSettings(skill.settings);
  }, [skill.settings]);

  useEffect(() => {
    setLocalEnabled(skill.enabled);
  }, [skill.enabled]);

  const hasSchema = skill.schema && Object.keys(skill.schema.properties).length > 0;
  const settingsDirty =
    JSON.stringify(localSettings) !== JSON.stringify(skill.settings);

  const handleFieldChange = useCallback((name: string, value: unknown) => {
    setLocalSettings((prev) => ({ ...prev, [name]: value }));
    setSaveResult('idle');
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveResult('idle');
    try {
      await onSave(skill.name, localSettings, localEnabled);
      setSaveResult('success');
      setTimeout(() => setSaveResult('idle'), 2000);
    } catch {
      setSaveResult('error');
    } finally {
      setSaving(false);
    }
  };

  const sortedFields = hasSchema
    ? Object.entries(skill.schema!.properties).sort(([, a], [, b]) => {
        const oa = a.order ?? 999;
        const ob = b.order ?? 999;
        return oa - ob;
      })
    : [];

  const groupedFields = new Map<string, [string, SkillSettingSchema][]>();
  for (const [key, schema] of sortedFields) {
    const group = schema.group ?? 'preferences';
    if (!groupedFields.has(group)) groupedFields.set(group, []);
    groupedFields.get(group)!.push([key, schema]);
  }

  const groupLabels: Record<string, string> = {
    auth: 'Authentication',
    preferences: 'Preferences',
    advanced: 'Advanced',
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        className="flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-left"
      >
        <div className="flex items-center gap-2.5">
          {expanded ? (
            <ChevronDown size={14} className="text-zinc-500" />
          ) : (
            <ChevronRight size={14} className="text-zinc-500" />
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-zinc-200">{skill.name}</span>
              <span className="text-[10px] text-zinc-600">v{skill.version}</span>
            </div>
            <p className="text-[11px] text-zinc-500 leading-snug mt-0.5">{skill.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {skill.configured ? (
            <CheckCircle size={12} className="text-green-500" />
          ) : (
            <AlertCircle size={12} className="text-amber-500" />
          )}
          <button
            type="button"
            disabled={toggling}
            onClick={(e) => {
              e.stopPropagation();
              const newEnabled = !localEnabled;
              setLocalEnabled(newEnabled);
              setSaveResult('idle');
              setToggling(true);
              onToggle(skill.name, newEnabled)
                .then(() => {
                  setSaveResult('success');
                  setTimeout(() => setSaveResult('idle'), 2000);
                })
                .catch(() => {
                  setLocalEnabled(!newEnabled);
                  setSaveResult('error');
                })
                .finally(() => setToggling(false));
            }}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
              localEnabled ? 'bg-blue-600' : 'bg-zinc-700'
            } ${toggling ? 'opacity-50' : ''}`}
          >
            <span
              className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${
                localEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-3 space-y-3">
          {hasSchema ? (
            <>
              {[...groupedFields.entries()].map(([group, fields]) => (
                <div key={group} className="space-y-2">
                  {groupedFields.size > 1 && (
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      {groupLabels[group] ?? group}
                    </h4>
                  )}
                  {fields.map(([key, schema]) => {
                    if (schema.dependsOn && !localSettings[schema.dependsOn]) return null;
                    return (
                      <SkillField
                        key={key}
                        name={key}
                        schema={schema}
                        value={localSettings[key]}
                        onChange={handleFieldChange}
                      />
                    );
                  })}
                </div>
              ))}
            </>
          ) : (
            <p className="text-[11px] text-zinc-500">No configurable settings for this skill.</p>
          )}

          {skill.name === 'google-workspace' && (
            <GoogleOAuthSection skillSettings={localSettings} />
          )}

          {(hasSchema || settingsDirty) && (
            <div className="flex items-center justify-end gap-2 pt-1">
              {saveResult === 'success' && (
                <span className="text-[11px] text-green-400">Saved</span>
              )}
              {saveResult === 'error' && (
                <span className="text-[11px] text-red-400">Save failed</span>
              )}
              <button
                onClick={handleSave}
                disabled={saving || !settingsDirty}
                className="rounded bg-blue-600 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/gateway/api/skills');
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error((body as { error?: string }).error ?? 'Failed to load skills');
      }
      const data = (await res.json()) as { skills: SkillInfo[] };
      setSkills(data.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleToggle = async (name: string, enabled: boolean) => {
    const res = await fetch(`/api/gateway/api/skills/${encodeURIComponent(name)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Toggle failed' }));
      throw new Error((body as { error?: string }).error ?? 'Toggle failed');
    }
    await fetchSkills();
  };

  const handleSave = async (name: string, settings: Record<string, unknown>, enabled: boolean) => {
    const res = await fetch(`/api/gateway/api/skills/${encodeURIComponent(name)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, enabled }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Save failed' }));
      throw new Error((body as { error?: string }).error ?? 'Save failed');
    }
    await fetchSkills();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center">
        <Loader2 size={14} className="animate-spin text-zinc-500" />
        <span className="text-xs text-zinc-500">Loading skills...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-8">
        <div className="flex items-center gap-1.5">
          <AlertCircle size={14} className="text-red-400" />
          <span className="text-xs text-red-400">{error}</span>
        </div>
        <button
          onClick={fetchSkills}
          className="text-[11px] text-zinc-400 hover:text-zinc-200 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Installed Skills
        </h3>
        <button
          onClick={fetchSkills}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>
      {skills.length === 0 ? (
        <p className="text-xs text-zinc-500 py-4 text-center">No skills installed.</p>
      ) : (
        <div className="space-y-1.5">
          {skills.map((skill) => (
            <SkillCard key={skill.name} skill={skill} onSave={handleSave} onToggle={handleToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

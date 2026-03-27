'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Eye, EyeOff, Save, Loader2, CheckCircle, AlertCircle, ChevronDown, ChevronRight, Zap, AlertTriangle, XCircle } from 'lucide-react';

type TabId = 'omegaclaw' | 'memory' | 'skills';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type ConfigData = Record<string, unknown>;

function getNestedValue(obj: ConfigData, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(obj: ConfigData, path: string, value: unknown): ConfigData {
  const keys = path.split('.');
  const result = JSON.parse(JSON.stringify(obj)) as ConfigData;
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return result;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-zinc-600'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[3px]'}`}
      />
    </button>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
      <label className="min-w-[180px] text-xs text-zinc-400 shrink-0">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
    />
  );
}

function NumberInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500 transition-colors"
    />
  );
}

function SelectInput({
  value,
  options,
  onChange,
}: {
  value: string;
  options: (string | { label: string; value: string })[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500 transition-colors"
    >
      {options.map((opt) => {
        const optValue = typeof opt === 'string' ? opt : opt.value;
        const optLabel = typeof opt === 'string' ? opt : opt.label;
        return (
          <option key={optValue} value={optValue}>
            {optLabel}
          </option>
        );
      })}
    </select>
  );
}

function ApiKeyInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const isMasked = value.startsWith('••••');

  if (!editing && isMasked) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 font-mono">
          {value}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        type={revealed ? 'text' : 'password'}
        value={editing && isMasked ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter new API key"
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 pr-8 text-xs text-zinc-100 outline-none focus:border-blue-500 transition-colors"
      />
      <button
        type="button"
        onClick={() => setRevealed(!revealed)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
      >
        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 mt-5 first:mt-0 text-xs font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 pb-2">
      {children}
    </h3>
  );
}

function OmegaClawTab({
  config,
  onChange,
}: {
  config: ConfigData;
  onChange: (path: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-2">
      <SectionTitle>Models</SectionTitle>
      <FormField label="Anthropic API Key">
        <ApiKeyInput
          value={String(getNestedValue(config, 'models.apiKey') ?? '')}
          onChange={(v) => onChange('models.apiKey', v)}
        />
      </FormField>
      <FormField label="Default Model">
        <TextInput
          value={String(getNestedValue(config, 'models.default') ?? '')}
          onChange={(v) => onChange('models.default', v)}
          placeholder="e.g. claude-sonnet-4-20250514"
        />
      </FormField>
      <FormField label="Planner Model">
        <TextInput
          value={String(getNestedValue(config, 'models.planner') ?? '')}
          onChange={(v) => onChange('models.planner', v)}
          placeholder="e.g. claude-sonnet-4-20250514"
        />
      </FormField>
      <FormField label="Cheap Model">
        <TextInput
          value={String(getNestedValue(config, 'models.cheap') ?? '')}
          onChange={(v) => onChange('models.cheap', v)}
          placeholder="e.g. claude-haiku-4-5-20251001"
        />
      </FormField>
      <FormField label="Worker Profiles">
        <TextInput
          value={JSON.stringify(getNestedValue(config, 'models.workers') ?? {})}
          onChange={(v) => {
            try {
              onChange('models.workers', JSON.parse(v));
            } catch { /* ignore invalid JSON */ }
          }}
          placeholder='{"default": "claude-sonnet-4-20250514"}'
        />
      </FormField>

      <SectionTitle>Gateway</SectionTitle>
      <FormField label="Port">
        <NumberInput
          value={Number(getNestedValue(config, 'gateway.port') ?? 8000)}
          onChange={(v) => onChange('gateway.port', v)}
        />
      </FormField>
      <FormField label="Bind Address">
        <TextInput
          value={String(getNestedValue(config, 'gateway.bind') ?? '0.0.0.0')}
          onChange={(v) => onChange('gateway.bind', v)}
        />
      </FormField>
      <FormField label="Auth Mode">
        <SelectInput
          value={String(getNestedValue(config, 'gateway.auth.mode') ?? 'none')}
          options={['none', 'api-key']}
          onChange={(v) => onChange('gateway.auth.mode', v)}
        />
      </FormField>
      <FormField label="CORS Origins">
        <TextInput
          value={((getNestedValue(config, 'gateway.cors.origins') as string[]) ?? []).join(', ')}
          onChange={(v) => onChange('gateway.cors.origins', v.split(',').map((s) => s.trim()).filter(Boolean))}
          placeholder="http://localhost:*, https://*"
        />
      </FormField>

      <SectionTitle>Workspace</SectionTitle>
      <FormField label="Path">
        <TextInput
          value={String(getNestedValue(config, 'workspace.path') ?? '')}
          onChange={(v) => onChange('workspace.path', v)}
        />
      </FormField>
      <FormField label="Max Output Size">
        <TextInput
          value={String(getNestedValue(config, 'workspace.maxOutputSize') ?? '10MB')}
          onChange={(v) => onChange('workspace.maxOutputSize', v)}
        />
      </FormField>

      <SectionTitle>Orchestration</SectionTitle>
      <FormField label="Max Spawn Depth">
        <NumberInput
          value={Number(getNestedValue(config, 'orchestration.maxSpawnDepth') ?? 3)}
          onChange={(v) => onChange('orchestration.maxSpawnDepth', v)}
        />
      </FormField>
      <FormField label="Worker Timeout (s)">
        <NumberInput
          value={Number(getNestedValue(config, 'orchestration.workerTimeout') ?? 300)}
          onChange={(v) => onChange('orchestration.workerTimeout', v)}
        />
      </FormField>
      <FormField label="Max Retries">
        <NumberInput
          value={Number(getNestedValue(config, 'orchestration.maxRetries') ?? 2)}
          onChange={(v) => onChange('orchestration.maxRetries', v)}
        />
      </FormField>
      <FormField label="Plan First">
        <Toggle
          checked={Boolean(getNestedValue(config, 'orchestration.planFirst'))}
          onChange={(v) => onChange('orchestration.planFirst', v)}
        />
      </FormField>
      <FormField label="Checkpoint Interval (s)">
        <NumberInput
          value={Number(getNestedValue(config, 'orchestration.checkpointInterval') ?? 30)}
          onChange={(v) => onChange('orchestration.checkpointInterval', v)}
        />
      </FormField>
      <FormField label="TUI Batch Interval (ms)">
        <NumberInput
          value={Number(getNestedValue(config, 'orchestration.eventBatching.tuiIntervalMs') ?? 250)}
          onChange={(v) => onChange('orchestration.eventBatching.tuiIntervalMs', v)}
        />
      </FormField>
      <FormField label="Web Batch Interval (ms)">
        <NumberInput
          value={Number(getNestedValue(config, 'orchestration.eventBatching.webIntervalMs') ?? 1000)}
          onChange={(v) => onChange('orchestration.eventBatching.webIntervalMs', v)}
        />
      </FormField>
      <FormField label="Immediate Event Types">
        <TextInput
          value={((getNestedValue(config, 'orchestration.eventBatching.immediateTypes') as string[]) ?? []).join(', ')}
          onChange={(v) => onChange('orchestration.eventBatching.immediateTypes', v.split(',').map((s) => s.trim()).filter(Boolean))}
          placeholder="error, done, finding"
        />
      </FormField>

      <SectionTitle>Logging</SectionTitle>
      <FormField label="Level">
        <SelectInput
          value={String(getNestedValue(config, 'logging.level') ?? 'info')}
          options={['error', 'warn', 'info', 'verbose', 'debug']}
          onChange={(v) => onChange('logging.level', v)}
        />
      </FormField>
      <FormField label="File Path">
        <TextInput
          value={String(getNestedValue(config, 'logging.file') ?? '')}
          onChange={(v) => onChange('logging.file', v)}
        />
      </FormField>
      <FormField label="Max Size">
        <TextInput
          value={String(getNestedValue(config, 'logging.maxSize') ?? '50MB')}
          onChange={(v) => onChange('logging.maxSize', v)}
        />
      </FormField>
      <FormField label="Max Files">
        <NumberInput
          value={Number(getNestedValue(config, 'logging.maxFiles') ?? 5)}
          onChange={(v) => onChange('logging.maxFiles', v)}
        />
      </FormField>
      <FormField label="Console Output">
        <Toggle
          checked={Boolean(getNestedValue(config, 'logging.console'))}
          onChange={(v) => onChange('logging.console', v)}
        />
      </FormField>

      <SectionTitle>Autonomous</SectionTitle>
      <FormField label="Enabled">
        <Toggle
          checked={Boolean(getNestedValue(config, 'autonomous.enabled'))}
          onChange={(v) => onChange('autonomous.enabled', v)}
        />
      </FormField>
      <FormField label="Max Budget (USD)">
        <NumberInput
          value={Number(getNestedValue(config, 'autonomous.maxBudgetUsd') ?? 50)}
          onChange={(v) => onChange('autonomous.maxBudgetUsd', v)}
        />
      </FormField>
      <FormField label="Max Duration (min)">
        <NumberInput
          value={Number(getNestedValue(config, 'autonomous.maxDurationMinutes') ?? 360)}
          onChange={(v) => onChange('autonomous.maxDurationMinutes', v)}
        />
      </FormField>
      <FormField label="Progress Interval (min)">
        <NumberInput
          value={Number(getNestedValue(config, 'autonomous.progressIntervalMinutes') ?? 15)}
          onChange={(v) => onChange('autonomous.progressIntervalMinutes', v)}
        />
      </FormField>
      <FormField label="Human Gates">
        <TextInput
          value={((getNestedValue(config, 'autonomous.humanGates') as string[]) ?? []).join(', ')}
          onChange={(v) => onChange('autonomous.humanGates', v.split(',').map((s) => s.trim()).filter(Boolean))}
          placeholder="deploy, merge, delete"
        />
      </FormField>
      <FormField label="Auto-Advance">
        <Toggle
          checked={Boolean(getNestedValue(config, 'autonomous.autoAdvance'))}
          onChange={(v) => onChange('autonomous.autoAdvance', v)}
        />
      </FormField>

      <SectionTitle>Agent SDK</SectionTitle>
      <FormField label="Enabled">
        <Toggle
          checked={Boolean(getNestedValue(config, 'agentSdk.enabled'))}
          onChange={(v) => onChange('agentSdk.enabled', v)}
        />
      </FormField>
      <FormField label="Permission Mode">
        <SelectInput
          value={String(getNestedValue(config, 'agentSdk.permissionMode') ?? 'acceptEdits')}
          options={['default', 'acceptEdits', 'bypassPermissions']}
          onChange={(v) => onChange('agentSdk.permissionMode', v)}
        />
      </FormField>
      <FormField label="Effort Level">
        <SelectInput
          value={String(getNestedValue(config, 'agentSdk.effort') ?? 'high')}
          options={['low', 'medium', 'high', 'max']}
          onChange={(v) => onChange('agentSdk.effort', v)}
        />
      </FormField>
      <FormField label="Max Budget (USD)">
        <NumberInput
          value={Number(getNestedValue(config, 'agentSdk.maxBudgetUsd') ?? 0)}
          onChange={(v) => onChange('agentSdk.maxBudgetUsd', v)}
        />
      </FormField>
      <FormField label="Max Turns">
        <NumberInput
          value={Number(getNestedValue(config, 'agentSdk.maxTurns') ?? 50)}
          onChange={(v) => onChange('agentSdk.maxTurns', v)}
        />
      </FormField>
      <FormField label="Additional Directories">
        <TextInput
          value={((getNestedValue(config, 'agentSdk.additionalDirectories') as string[]) ?? []).join(', ')}
          onChange={(v) => onChange('agentSdk.additionalDirectories', v.split(',').map((s) => s.trim()).filter(Boolean))}
          placeholder="/path/one, /path/two"
        />
      </FormField>
    </div>
  );
}

function MemoryTab({
  config,
  onChange,
}: {
  config: ConfigData;
  onChange: (path: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-2">
      <SectionTitle>Hindsight Settings</SectionTitle>
      <FormField label="Server URL">
        <TextInput
          value={String(getNestedValue(config, 'hindsight.url') ?? '')}
          onChange={(v) => onChange('hindsight.url', v)}
          placeholder="http://localhost:8888"
        />
      </FormField>
      <FormField label="Default Bank">
        <TextInput
          value={String(getNestedValue(config, 'hindsight.defaultBank') ?? '')}
          onChange={(v) => onChange('hindsight.defaultBank', v)}
        />
      </FormField>
      <FormField label="Retain on Complete">
        <Toggle
          checked={Boolean(getNestedValue(config, 'hindsight.retainOnComplete'))}
          onChange={(v) => onChange('hindsight.retainOnComplete', v)}
        />
      </FormField>
      <FormField label="Retain on Error">
        <Toggle
          checked={Boolean(getNestedValue(config, 'hindsight.retainOnError'))}
          onChange={(v) => onChange('hindsight.retainOnError', v)}
        />
      </FormField>
    </div>
  );
}

interface SkillAuthMethod {
  type: 'oauth' | 'pat' | 'api-key' | 'login' | 'ssh-key' | 'env';
  label: string;
  description?: string;
  tokenUrl?: string;
  envVar?: string;
}

interface SkillSetupField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  label: string;
  description?: string;
  required: boolean;
  default?: string | number | boolean;
  options?: { label: string; value: string }[];
  mask?: boolean;
}

interface SkillManifestData {
  name: string;
  version: string;
  description: string;
  author: string;
  setup?: {
    required: boolean;
    description?: string;
    auth?: { methods: SkillAuthMethod[] };
    fields?: SkillSetupField[];
  };
}

interface SkillConfigData {
  name: string;
  enabled: boolean;
  configured: boolean;
  authMethod?: string;
  configuredAt?: string;
  fields: Record<string, string | number | boolean>;
}

interface SkillEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  manifest: SkillManifestData;
  config: SkillConfigData;
  status: 'configured' | 'needs-setup' | 'disabled' | 'no-setup';
}

function StatusBadge({ status }: { status: SkillEntry['status'] }) {
  const styles: Record<SkillEntry['status'], { bg: string; text: string; label: string; icon: React.ReactNode }> = {
    configured: { bg: 'bg-green-900/30', text: 'text-green-400', label: 'Configured', icon: <CheckCircle size={10} /> },
    'needs-setup': { bg: 'bg-amber-900/30', text: 'text-amber-400', label: 'Needs Setup', icon: <AlertTriangle size={10} /> },
    disabled: { bg: 'bg-zinc-800', text: 'text-zinc-500', label: 'Disabled', icon: <XCircle size={10} /> },
    'no-setup': { bg: 'bg-blue-900/30', text: 'text-blue-400', label: 'Ready', icon: <Zap size={10} /> },
  };
  const s = styles[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${s.bg} ${s.text}`}>
      {s.icon}
      {s.label}
    </span>
  );
}

function getAuthFieldKey(method: SkillAuthMethod): string {
  return method.envVar ?? 'API_KEY';
}

function SkillAuthPanel({
  methods,
  fieldValues,
  selectedMethod,
  onFieldChange,
  onMethodChange,
}: {
  methods: SkillAuthMethod[];
  fieldValues: Record<string, string | number | boolean>;
  selectedMethod: string;
  onFieldChange: (fieldKey: string, value: string) => void;
  onMethodChange: (v: string) => void;
}) {
  const directInputTypes = new Set(['api-key', 'pat']);
  const cliOnlyTypes = new Set(['oauth', 'login', 'ssh-key', 'env']);

  const activeMethod = methods.find((m) => m.type === selectedMethod) ?? methods[0];
  if (!activeMethod) return null;

  const authFieldKey = getAuthFieldKey(activeMethod);
  const credential = String(fieldValues[authFieldKey] ?? '');

  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Authentication</h4>
      {methods.length > 1 && (
        <FormField label="Auth Method">
          <SelectInput
            value={selectedMethod || methods[0]!.type}
            options={methods.map((m) => m.type)}
            onChange={onMethodChange}
          />
        </FormField>
      )}
      {activeMethod.description && (
        <p className="text-[11px] text-zinc-500 pl-0 sm:pl-[196px]">{activeMethod.description}</p>
      )}
      {directInputTypes.has(activeMethod.type) && (
        <FormField label={activeMethod.label || (activeMethod.type === 'api-key' ? 'API Key' : 'Personal Access Token')}>
          <ApiKeyInput
            value={credential}
            onChange={(v) => onFieldChange(authFieldKey, v)}
          />
        </FormField>
      )}
      {activeMethod.tokenUrl && directInputTypes.has(activeMethod.type) && (
        <p className="text-[11px] text-zinc-500 pl-0 sm:pl-[196px]">
          Get a token at:{' '}
          <a href={activeMethod.tokenUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
            {activeMethod.tokenUrl}
          </a>
        </p>
      )}
      {cliOnlyTypes.has(activeMethod.type) && (
        <div className="rounded-md border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-[11px] text-zinc-400 ml-0 sm:ml-[196px]">
          {activeMethod.type === 'env' && activeMethod.envVar
            ? <>This skill uses the environment variable <code className="text-zinc-300">{activeMethod.envVar}</code>. Set it in your shell before starting the gateway.</>
            : <>This auth method ({activeMethod.type}) requires CLI setup. Run <code className="text-zinc-300">orionomega setup skills</code> to configure.</>
          }
        </div>
      )}
    </div>
  );
}

function SkillFieldsPanel({
  fields,
  values,
  onFieldChange,
}: {
  fields: SkillSetupField[];
  values: Record<string, string | number | boolean>;
  onFieldChange: (name: string, value: string | number | boolean) => void;
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Configuration</h4>
      {fields.map((field) => {
        const currentValue = values[field.name] ?? field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : '');

        return (
          <div key={field.name}>
            <FormField label={`${field.label}${field.required ? ' *' : ''}`}>
              {field.type === 'boolean' ? (
                <Toggle
                  checked={Boolean(currentValue)}
                  onChange={(v) => onFieldChange(field.name, v)}
                />
              ) : field.type === 'number' ? (
                <NumberInput
                  value={Number(currentValue)}
                  onChange={(v) => onFieldChange(field.name, v)}
                />
              ) : field.type === 'select' && field.options ? (
                <SelectInput
                  value={String(currentValue)}
                  options={field.options}
                  onChange={(v) => onFieldChange(field.name, v)}
                />
              ) : field.mask ? (
                <ApiKeyInput
                  value={String(currentValue)}
                  onChange={(v) => onFieldChange(field.name, v)}
                />
              ) : (
                <TextInput
                  value={String(currentValue)}
                  onChange={(v) => onFieldChange(field.name, v)}
                  placeholder={field.description}
                />
              )}
            </FormField>
            {field.description && !field.mask && (
              <p className="text-[10px] text-zinc-600 mt-0.5 pl-0 sm:pl-[196px]">{field.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SkillCard({
  skill,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onConfigChange,
}: {
  skill: SkillEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onConfigChange: (skillName: string, field: string, value: string | number | boolean) => void;
}) {
  const hasSetup = skill.manifest.setup && (
    (skill.manifest.setup.auth?.methods && skill.manifest.setup.auth.methods.length > 0) ||
    (skill.manifest.setup.fields && skill.manifest.setup.fields.length > 0)
  );

  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/30 overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button[data-toggle]')) return;
          if (skill.config.enabled && hasSetup) onToggleExpand();
        }}
      >
        {skill.config.enabled && hasSetup ? (
          expanded
            ? <ChevronDown size={14} className="text-zinc-500 shrink-0" />
            : <ChevronRight size={14} className="text-zinc-500 shrink-0" />
        ) : (
          <div className="w-[14px] shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-zinc-200 truncate">{skill.name}</span>
            <span className="text-[10px] text-zinc-600">v{skill.version}</span>
          </div>
          <p className="text-[11px] text-zinc-500 truncate mt-0.5">{skill.description}</p>
        </div>

        <StatusBadge status={skill.config.enabled ? skill.status : 'disabled'} />

        <div data-toggle="true" onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={skill.config.enabled}
            onChange={(v) => onToggleEnabled(v)}
          />
        </div>
      </div>

      {expanded && skill.config.enabled && hasSetup && (
        <div className="border-t border-zinc-700/50 px-4 py-3 space-y-4">
          {skill.manifest.setup?.auth?.methods && skill.manifest.setup.auth.methods.length > 0 && (
            <SkillAuthPanel
              methods={skill.manifest.setup.auth.methods}
              fieldValues={skill.config.fields}
              selectedMethod={skill.config.authMethod || skill.manifest.setup.auth.methods[0]!.type}
              onFieldChange={(fieldKey, v) => onConfigChange(skill.name, fieldKey, v)}
              onMethodChange={(v) => onConfigChange(skill.name, '_authMethod', v)}
            />
          )}
          {skill.manifest.setup?.fields && skill.manifest.setup.fields.length > 0 && (
            <SkillFieldsPanel
              fields={skill.manifest.setup.fields}
              values={skill.config.fields}
              onFieldChange={(name, value) => onConfigChange(skill.name, name, value)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SkillsTab({
  config,
  onChange,
  skills,
  skillsLoading,
  onSkillConfigChange,
  onSkillToggle,
}: {
  config: ConfigData;
  onChange: (path: string, value: unknown) => void;
  skills: SkillEntry[];
  skillsLoading: boolean;
  onSkillConfigChange: (skillName: string, field: string, value: string | number | boolean) => void;
  onSkillToggle: (skillName: string, enabled: boolean) => void;
}) {
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((name: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  return (
    <div className="space-y-4">
      <SectionTitle>Global Settings</SectionTitle>
      <div className="space-y-2">
        <FormField label="Skills Directory">
          <TextInput
            value={String(getNestedValue(config, 'skills.directory') ?? '')}
            onChange={(v) => onChange('skills.directory', v)}
          />
        </FormField>
        <FormField label="Auto-Load">
          <Toggle
            checked={Boolean(getNestedValue(config, 'skills.autoLoad'))}
            onChange={(v) => onChange('skills.autoLoad', v)}
          />
        </FormField>
      </div>

      <SectionTitle>Installed Skills</SectionTitle>
      {skillsLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-zinc-500" />
          <span className="ml-2 text-xs text-zinc-500">Discovering skills...</span>
        </div>
      ) : skills.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-xs text-zinc-500">No skills found in the configured directory.</p>
          <p className="text-[11px] text-zinc-600 mt-1">Set a skills directory above and save to discover skills.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => (
            <SkillCard
              key={skill.name}
              skill={skill}
              expanded={expandedSkills.has(skill.name)}
              onToggleExpand={() => toggleExpand(skill.name)}
              onToggleEnabled={(enabled) => onSkillToggle(skill.name, enabled)}
              onConfigChange={onSkillConfigChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function getTabValidity(config: ConfigData | null, skills: SkillEntry[]): Record<TabId, boolean> {
  if (!config) return { omegaclaw: false, memory: false, skills: false };

  const apiKey = String(getNestedValue(config, 'models.apiKey') ?? '');
  const defaultModel = String(getNestedValue(config, 'models.default') ?? '');
  const port = Number(getNestedValue(config, 'gateway.port') ?? 0);
  const omegaclawValid = (apiKey.length > 0) && (defaultModel.length > 0) && (port > 0 && port <= 65535);

  const hindsightUrl = String(getNestedValue(config, 'hindsight.url') ?? '');
  const defaultBank = String(getNestedValue(config, 'hindsight.defaultBank') ?? '');
  const memoryValid = hindsightUrl.length > 0 && defaultBank.length > 0;

  const skillsDir = String(getNestedValue(config, 'skills.directory') ?? '');
  const allSkillsConfigured = skills.every((s) => s.status !== 'needs-setup');
  const skillsValid = skillsDir.length > 0 && allSkillsConfigured;

  return { omegaclaw: omegaclawValid, memory: memoryValid, skills: skillsValid };
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'omegaclaw', label: 'OmegaClaw' },
  { id: 'memory', label: 'Memory' },
  { id: 'skills', label: 'Skills' },
];

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('omegaclaw');
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [dirtySkills, setDirtySkills] = useState<Map<string, Partial<{ enabled: boolean; authMethod: string; fields: Record<string, string | number | boolean> }>>>(new Map());

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setErrorMsg('');
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch('/api/gateway/api/config');
        const text = await res.text();
        if (!res.ok) {
          let message = 'Failed to fetch config';
          try {
            const data = JSON.parse(text);
            message = (data as { error?: string }).error || message;
          } catch {
            if (text) message = text;
          }
          throw new Error(message);
        }
        const data = JSON.parse(text);
        setConfig(data as ConfigData);
        setLoading(false);
        return;
      } catch (err) {
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load config');
      }
    }
    setLoading(false);
  }, []);

  const fetchSkills = useCallback(async () => {
    setSkillsLoading(true);
    try {
      const res = await fetch('/api/gateway/api/skills');
      if (res.ok) {
        const data = await res.json();
        setSkills((data as { skills: SkillEntry[] }).skills || []);
      }
    } catch {
      // Skills fetch is non-critical
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setConfig(null);
      setSkills([]);
      setDirtySkills(new Map());
      fetchConfig();
      fetchSkills();
      setSaveStatus('idle');
      setErrorMsg('');
    }
  }, [open, fetchConfig, fetchSkills]);

  const handleChange = useCallback((path: string, value: unknown) => {
    setConfig((prev) => setNestedValue(prev ?? {}, path, value));
    setSaveStatus('idle');
  }, []);

  const handleSkillConfigChange = useCallback((skillName: string, field: string, value: string | number | boolean) => {
    setSaveStatus('idle');

    setSkills((prev) => prev.map((s) => {
      if (s.name !== skillName) return s;
      const updated = { ...s, config: { ...s.config, fields: { ...s.config.fields } } };
      if (field === '_authMethod') {
        updated.config.authMethod = String(value);
      } else {
        updated.config.fields[field] = value;
      }
      return updated;
    }));

    setDirtySkills((prev) => {
      const next = new Map(prev);
      const existing = next.get(skillName) || {};
      if (field === '_authMethod') {
        existing.authMethod = String(value);
      } else {
        existing.fields = { ...(existing.fields || {}), [field]: value };
      }
      next.set(skillName, existing);
      return next;
    });
  }, []);

  const handleSkillToggle = useCallback((skillName: string, enabled: boolean) => {
    setSaveStatus('idle');

    setSkills((prev) => prev.map((s) => {
      if (s.name !== skillName) return s;
      return {
        ...s,
        config: { ...s.config, enabled },
        status: enabled ? (s.manifest.setup?.required && !s.config.configured ? 'needs-setup' : s.config.configured ? 'configured' : 'no-setup') : 'disabled',
      };
    }));

    setDirtySkills((prev) => {
      const next = new Map(prev);
      const existing = next.get(skillName) || {};
      existing.enabled = enabled;
      next.set(skillName, existing);
      return next;
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    setErrorMsg('');
    try {
      const res = await fetch('/api/gateway/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config ?? {}),
      });
      const rawText = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(rawText);
      } catch {
        body = { error: rawText || 'Unexpected response' };
      }
      if (!res.ok) {
        throw new Error((body as { error?: string }).error || 'Failed to save');
      }
      setConfig(body as ConfigData);

      const skillErrors: string[] = [];
      for (const [skillName, changes] of dirtySkills.entries()) {
        try {
          const skillRes = await fetch(`/api/gateway/api/skills/${encodeURIComponent(skillName)}/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enabled: changes.enabled,
              authMethod: changes.authMethod,
              fields: changes.fields,
            }),
          });
          if (!skillRes.ok) {
            const errData = await skillRes.json().catch(() => ({ error: 'Unknown error' }));
            skillErrors.push(`${skillName}: ${(errData as { error?: string }).error || 'Failed'}`);
          } else {
            const result = await skillRes.json() as { config: SkillConfigData; status: SkillEntry['status'] };
            setSkills((prev) => prev.map((s) => {
              if (s.name !== skillName) return s;
              return { ...s, config: result.config, status: result.status };
            }));
          }
        } catch (err) {
          skillErrors.push(`${skillName}: ${err instanceof Error ? err.message : 'Network error'}`);
        }
      }

      setDirtySkills(new Map());

      if (skillErrors.length > 0) {
        throw new Error(`Config saved but skill errors: ${skillErrors.join('; ')}`);
      }

      fetchSkills();

      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (err) {
      setSaveStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative flex h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-700 bg-[var(--background)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex border-b border-zinc-800">
          {TABS.map((tab) => {
            const validity = getTabValidity(config, skills);
            const isValid = validity[tab.id];
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-5 py-2.5 text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border-b-2 border-blue-500 text-blue-400'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {config && (
                  isValid
                    ? <CheckCircle size={12} className="text-green-400" />
                    : <AlertCircle size={12} className="text-amber-400" />
                )}
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={20} className="animate-spin text-zinc-500" />
              <span className="ml-2 text-xs text-zinc-500">Loading configuration...</span>
            </div>
          ) : errorMsg && config === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <div className="flex items-center">
                <AlertCircle size={16} className="text-red-400" />
                <span className="ml-2 text-xs text-red-400">{errorMsg}</span>
              </div>
              <button
                onClick={fetchConfig}
                className="rounded bg-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-600 transition-colors"
              >
                Retry
              </button>
            </div>
          ) : (
            config && <>
              {activeTab === 'omegaclaw' && <OmegaClawTab config={config} onChange={handleChange} />}
              {activeTab === 'memory' && <MemoryTab config={config} onChange={handleChange} />}
              {activeTab === 'skills' && (
                <SkillsTab
                  config={config}
                  onChange={handleChange}
                  skills={skills}
                  skillsLoading={skillsLoading}
                  onSkillConfigChange={handleSkillConfigChange}
                  onSkillToggle={handleSkillToggle}
                />
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 px-6 py-3">
          <div className="flex items-center gap-2 text-xs">
            {saveStatus === 'success' && (
              <>
                <CheckCircle size={14} className="text-green-400" />
                <span className="text-green-400">Settings saved</span>
              </>
            )}
            {saveStatus === 'error' && (
              <>
                <AlertCircle size={14} className="text-red-400" />
                <span className="text-red-400">{errorMsg}</span>
              </>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Zap, GitBranch, Code2 } from 'lucide-react';
import { useAgentModeStore, type AgentMode } from '@/stores/agent-mode';

interface AgentModeToggleProps {
  disabled?: boolean;
}

/** Label shown in the toast when switching modes. */
const MODE_LABELS: Record<AgentMode, string> = {
  direct: '⚡ Direct mode',
  orchestrate: '◈ Orchestrate mode',
  code: '🔧 Code mode',
};

export function AgentModeToggle({ disabled }: AgentModeToggleProps) {
  const mode = useAgentModeStore((s) => s.mode);
  const setMode = useAgentModeStore((s) => s.setMode);
  const [showToast, setShowToast] = useState(false);
  const [toastLabel, setToastLabel] = useState('');

  const handleSetMode = useCallback(
    (newMode: AgentMode) => {
      if (newMode === mode || disabled) return;
      setMode(newMode);
      setToastLabel(MODE_LABELS[newMode]);
      setShowToast(true);
    },
    [mode, disabled, setMode],
  );

  // Auto-dismiss toast after 2 seconds
  useEffect(() => {
    if (!showToast) return;
    const timer = setTimeout(() => setShowToast(false), 2000);
    return () => clearTimeout(timer);
  }, [showToast]);

  // Global keyboard shortcut: Ctrl/Cmd + M — cycles through modes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        e.preventDefault();
        useAgentModeStore.getState().toggle();
        const next = useAgentModeStore.getState().mode;
        setToastLabel(MODE_LABELS[next]);
        setShowToast(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="relative flex items-center">
      <div
        role="radiogroup"
        aria-label="Agent execution mode"
        className={`flex items-center rounded-lg border border-zinc-700 bg-zinc-900 p-0.5 ${
          disabled ? 'pointer-events-none opacity-40' : ''
        }`}
      >
        {/* Direct mode button */}
        <button
          role="radio"
          aria-checked={mode === 'direct'}
          aria-label="Direct mode — single agent, streaming response"
          onClick={() => handleSetMode('direct')}
          tabIndex={mode === 'direct' ? 0 : -1}
          title="Direct: single-agent streaming response (Ctrl+M)"
          className={`flex min-h-[32px] items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium
            transition-all duration-150 ease-out
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-zinc-900
            md:min-h-0
            ${
              mode === 'direct'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
        >
          <Zap size={13} aria-hidden="true" />
          <span className="hidden md:inline">Direct</span>
        </button>

        {/* Orchestrate mode button */}
        <button
          role="radio"
          aria-checked={mode === 'orchestrate'}
          aria-label="Orchestrate mode — multi-agent DAG execution"
          onClick={() => handleSetMode('orchestrate')}
          tabIndex={mode === 'orchestrate' ? 0 : -1}
          title="Orchestrate: multi-agent DAG planner + parallel workers (Ctrl+M)"
          className={`flex min-h-[32px] items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium
            transition-all duration-150 ease-out
            focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1 focus:ring-offset-zinc-900
            md:min-h-0
            ${
              mode === 'orchestrate'
                ? 'bg-violet-600 text-white shadow-sm'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
        >
          <GitBranch size={13} aria-hidden="true" />
          <span className="hidden md:inline">Orch</span>
        </button>

        {/* Code mode button */}
        <button
          role="radio"
          aria-checked={mode === 'code'}
          aria-label="Code mode — coding DAG workflow with repo management and architect review"
          onClick={() => handleSetMode('code')}
          tabIndex={mode === 'code' ? 0 : -1}
          title="Code: coding DAG with repo management, implementation loop, and architect review (Ctrl+M)"
          className={`flex min-h-[32px] items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium
            transition-all duration-150 ease-out
            focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1 focus:ring-offset-zinc-900
            md:min-h-0
            ${
              mode === 'code'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
        >
          <Code2 size={13} aria-hidden="true" />
          <span className="hidden md:inline">Code</span>
        </button>
      </div>

      {/* Mode change toast */}
      {showToast && (
        <div
          className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md
            border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 shadow-lg
            animate-mode-toast"
          role="status"
          aria-live="polite"
        >
          {toastLabel}
        </div>
      )}
    </div>
  );
}

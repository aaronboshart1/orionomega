'use client';

import { useCallback, useEffect, useState } from 'react';
import { Zap, GitBranch } from 'lucide-react';
import { useAgentModeStore, type AgentMode } from '@/stores/agent-mode';

interface AgentModeToggleProps {
  disabled?: boolean;
}

export function AgentModeToggle({ disabled }: AgentModeToggleProps) {
  const mode = useAgentModeStore((s) => s.mode);
  const setMode = useAgentModeStore((s) => s.setMode);
  const [showToast, setShowToast] = useState(false);
  const [toastLabel, setToastLabel] = useState('');

  const handleSetMode = useCallback(
    (newMode: AgentMode) => {
      if (newMode === mode || disabled) return;
      setMode(newMode);
      setToastLabel(newMode === 'direct' ? '⚡ Direct mode' : '◈ Orchestrate mode');
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

  // Global keyboard shortcut: Ctrl/Cmd + M
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        e.preventDefault();
        const next = useAgentModeStore.getState().mode === 'orchestrate' ? 'direct' : 'orchestrate';
        useAgentModeStore.getState().toggle();
        setToastLabel(next === 'direct' ? '⚡ Direct mode' : '◈ Orchestrate mode');
        setShowToast(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const isDirect = mode === 'direct';

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
          aria-checked={isDirect}
          aria-label="Direct mode — single agent, streaming response"
          onClick={() => handleSetMode('direct')}
          tabIndex={isDirect ? 0 : -1}
          title="Direct: single-agent streaming response (Ctrl+M)"
          className={`flex min-h-[32px] items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium
            transition-all duration-150 ease-out
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-zinc-900
            md:min-h-0
            ${
              isDirect
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
          aria-checked={!isDirect}
          aria-label="Orchestrate mode — multi-agent DAG execution"
          onClick={() => handleSetMode('orchestrate')}
          tabIndex={!isDirect ? 0 : -1}
          title="Orchestrate: multi-agent DAG planner + parallel workers (Ctrl+M)"
          className={`flex min-h-[32px] items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium
            transition-all duration-150 ease-out
            focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1 focus:ring-offset-zinc-900
            md:min-h-0
            ${
              !isDirect
                ? 'bg-violet-600 text-white shadow-sm'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
        >
          <GitBranch size={13} aria-hidden="true" />
          <span className="hidden md:inline">Orch</span>
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

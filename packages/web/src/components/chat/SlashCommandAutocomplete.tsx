'use client';

import { useEffect, useRef } from 'react';

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/workflows', description: 'List all active workflows' },
  { name: '/status', description: 'Session and system status' },
  { name: '/stop', description: 'Stop the active workflow' },
  { name: '/pause', description: 'Pause before next layer' },
  { name: '/resume', description: 'Resume a paused workflow' },
  { name: '/plan', description: 'Show the current execution plan' },
  { name: '/workers', description: 'List active workers' },
  { name: '/gates', description: 'List pending human approval gates' },
  { name: '/skills', description: 'View, enable/disable, configure skills' },
  { name: '/reset', description: 'Clear history and detach workflow' },
  { name: '/restart', description: 'Restart the gateway service' },
  { name: '/focus', description: 'Focus a workflow by ID' },
  { name: '/hindsight', description: 'Show Hindsight memory status' },
];

interface SlashCommandAutocompleteProps {
  filter: string;
  selectedIndex: number;
  onSelect: (command: string) => void;
}

export function getFilteredCommands(filter: string): SlashCommand[] {
  const lower = filter.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(lower));
}

export function SlashCommandAutocomplete({
  filter,
  selectedIndex,
  onSelect,
}: SlashCommandAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = getFilteredCommands(filter);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-72 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
    >
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd.name);
          }}
          className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs transition-colors ${
            i === selectedIndex
              ? 'bg-blue-600/20 text-blue-300'
              : 'text-zinc-300 hover:bg-zinc-800'
          }`}
        >
          <span className="font-mono text-blue-400">{cmd.name}</span>
          <span className="flex-1 truncate text-zinc-500">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}

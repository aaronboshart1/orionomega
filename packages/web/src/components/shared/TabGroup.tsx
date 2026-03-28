'use client';

import type { ReactNode } from 'react';

export interface TabDef<T extends string = string> {
  key: T;
  label: string;
  badge?: ReactNode;
  icon?: ReactNode;
}

interface TabGroupProps<T extends string = string> {
  tabs: TabDef<T>[];
  active: T;
  onSelect: (key: T) => void;
  variant?: 'pill' | 'underline';
  className?: string;
}

export function TabGroup<T extends string = string>({
  tabs,
  active,
  onSelect,
  variant = 'underline',
  className = '',
}: TabGroupProps<T>) {
  return (
    <div role="tablist" className={`flex ${className}`}>
      {tabs.map((tab) => {
        const isActive = active === tab.key;

        const base =
          variant === 'pill'
            ? `px-3 py-1.5 text-xs font-medium transition-colors rounded-md ${
                isActive
                  ? 'bg-zinc-800 text-zinc-200 ring-1 ring-zinc-600'
                  : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
              }`
            : `px-4 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? 'border-b-2 border-blue-500 text-blue-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`;

        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tab.key)}
            className={base}
          >
            <span className="flex items-center gap-1.5">
              {tab.icon}
              {tab.label}
              {tab.badge}
            </span>
          </button>
        );
      })}
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Check, Loader2 } from 'lucide-react';
import { OmegaSpinner } from './OmegaSpinner';
import type { ThinkingStep } from '@/stores/chat';

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function LiveElapsed({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startedAt);

  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(timer);
  }, [startedAt]);

  return <span className="tabular-nums text-zinc-500">{formatElapsed(elapsed)}</span>;
}

function StepIcon({ status }: { status: ThinkingStep['status'] }) {
  if (status === 'done') {
    return (
      <div className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20">
        <Check size={10} className="text-emerald-400" />
      </div>
    );
  }
  if (status === 'active') {
    return <Loader2 size={14} className="animate-spin text-blue-400" />;
  }
  return <div className="h-2 w-2 rounded-full bg-zinc-600" />;
}

interface ThinkingTimelineProps {
  steps: ThinkingStep[];
  statusText?: string;
}

export function ThinkingTimeline({ steps, statusText }: ThinkingTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  const hasSteps = steps.length > 0;
  const activeStep = [...steps].reverse().find((s) => s.status === 'active');
  const collapsedSteps = expanded ? steps : steps.slice(-3);

  return (
    <div className="my-3 flex justify-start">
      <div className="flex max-w-[85%] items-start gap-3 rounded-2xl bg-zinc-800/50 px-4 py-3">
        <div className="flex items-center pt-0.5">
          <OmegaSpinner size={5} gap={1.5} interval={180} />
        </div>
        <div className="min-w-0 flex-1">
          {statusText && !hasSteps && (
            <p className="text-xs font-medium text-blue-400">{statusText}</p>
          )}

          {hasSteps && (
            <div className="space-y-0">
              {!expanded && steps.length > 3 && (
                <button
                  onClick={() => setExpanded(true)}
                  className="mb-1 flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-400"
                >
                  <ChevronRight size={10} />
                  {steps.length - 3} earlier step{steps.length - 3 !== 1 ? 's' : ''}
                </button>
              )}

              {expanded && steps.length > 3 && (
                <button
                  onClick={() => setExpanded(false)}
                  className="mb-1 flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-400"
                >
                  <ChevronDown size={10} />
                  Collapse
                </button>
              )}

              <div className="space-y-1">
                {collapsedSteps.map((step) => (
                  <div key={step.id} className="flex items-start gap-2">
                    <div className="mt-0.5 flex-shrink-0">
                      <StepIcon status={step.status} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs font-medium ${
                            step.status === 'active'
                              ? 'text-blue-400'
                              : step.status === 'done'
                                ? 'text-zinc-400'
                                : 'text-zinc-500'
                          }`}
                        >
                          {step.name}
                        </span>
                        <span className="text-[10px]">
                          {step.status === 'done' && step.elapsedMs != null && (
                            <span className="text-zinc-500">{formatElapsed(step.elapsedMs)}</span>
                          )}
                          {step.status === 'active' && step.startedAt && (
                            <LiveElapsed startedAt={step.startedAt} />
                          )}
                        </span>
                      </div>
                      {step.detail && (
                        <p className="mt-0.5 text-[10px] text-zinc-500">{step.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!hasSteps && !statusText && (
            <p className="text-xs font-medium text-blue-400">Thinking…</p>
          )}
        </div>
      </div>
    </div>
  );
}

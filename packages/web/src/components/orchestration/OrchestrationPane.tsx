'use client';

import { useOrchestrationStore } from '@/stores/orchestration';
import { useSchedulesStore } from '@/stores/schedules';
import {
  X,
  Play,
  Pause,
  Square,
  FileText,
  Wifi,
  WifiOff,
  ScrollText,
  CalendarClock,
  GitBranch,
  ExternalLink,
} from 'lucide-react';
import { useGateway } from '@/lib/gateway';
import { useFileViewerStore } from '@/stores/file-viewer';
import { useConnectionStore } from '@/stores/connection';
import { OrchPaneBody, type OrchTabKind } from './OrchPaneBody';
import type { InlineDAGStatus } from '@/stores/orchestration';

const statusColors: Record<string, string> = {
  dispatched: 'bg-yellow-500',
  running: 'bg-blue-500',
  complete: 'bg-green-500',
  error: 'bg-red-500',
  stopped: 'bg-zinc-500',
  pending: 'bg-zinc-500',
  planned: 'bg-yellow-500',
  planning: 'bg-yellow-500',
  paused: 'bg-orange-500',
};

function getWorkflowStatus(
  dagStatus?: InlineDAGStatus,
  graphStatus?: string,
): string {
  return dagStatus || graphStatus || 'pending';
}

/** URL the pop-out icon opens in a new browser tab. */
function popoutUrl(kind: OrchTabKind, workflowId?: string): string {
  if (kind === 'workflow' && workflowId) return `/orch/workflow/${encodeURIComponent(workflowId)}`;
  return `/orch/${kind}`;
}

/**
 * Small "open in new tab" icon button rendered inside each tab header.
 * Stops propagation so clicking it does NOT activate or close the tab.
 */
function PopoutButton({
  kind,
  workflowId,
  label,
}: {
  kind: OrchTabKind;
  workflowId?: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (typeof window !== 'undefined') {
          window.open(popoutUrl(kind, workflowId), '_blank', 'noopener');
        }
      }}
      onKeyDown={(e) => {
        // Don't let Enter/Space bubble up and toggle the parent tab.
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
      aria-label={`Open ${label} in new tab`}
      title={`Open ${label} in new tab`}
      className="ml-1 -mr-0.5 inline-flex shrink-0 items-center justify-center rounded p-0.5 text-zinc-500 opacity-70 transition hover:bg-zinc-700 hover:text-zinc-200 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
    >
      <ExternalLink size={10} />
    </button>
  );
}

export function OrchestrationPane() {
  const activeOrchTab = useOrchestrationStore((s) => s.activeOrchTab);
  const setActiveOrchTab = useOrchestrationStore((s) => s.setActiveOrchTab);
  const memoryCount = useOrchestrationStore((s) => s.memoryEvents.length);
  const workflows = useOrchestrationStore((s) => s.workflows);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const setActiveWorkflowId = useOrchestrationStore((s) => s.setActiveWorkflowId);
  const removeWorkflow = useOrchestrationStore((s) => s.removeWorkflow);
  const { sendWorkflowCommand } = useGateway();
  const fileCount = useFileViewerStore((s) => s.openFiles.length);
  const scheduleCount = useSchedulesStore((s) => s.schedules.length);
  const liveSchedules = useSchedulesStore((s) => s.liveTriggers.size);
  const gatewayConnected = useConnectionStore((s) => s.gatewayConnected);
  const hindsightConnected = useConnectionStore((s) => s.hindsightConnected);

  const workflowIds = Object.keys(workflows);

  const activateTab = (tab: OrchTabKind) => setActiveOrchTab(tab);
  const activateWorkflow = (wfId: string) => {
    setActiveWorkflowId(wfId);
    setActiveOrchTab('workflow');
  };

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div role="tablist" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5">
        {/* Connection status indicator */}
        <div
          className="flex items-center gap-1.5 px-2 py-1 mr-1"
          title={`Gateway: ${gatewayConnected ? 'Connected' : 'Disconnected'}${hindsightConnected ? ' | Hindsight: Connected' : ''}`}
        >
          {gatewayConnected ? (
            <Wifi size={12} className="text-green-500" />
          ) : (
            <WifiOff size={12} className="text-red-400 animate-pulse" />
          )}
          <span className={`h-1.5 w-1.5 rounded-full ${gatewayConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
          {hindsightConnected && (
            <span className="h-1.5 w-1.5 rounded-full bg-violet-500" title="Hindsight connected" />
          )}
        </div>

        <div className="h-4 w-px bg-zinc-800 mr-1" />

        <div
          role="tab"
          tabIndex={0}
          aria-selected={activeOrchTab === 'memory'}
          onClick={() => activateTab('memory')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activateTab('memory');
            }
          }}
          className={`flex cursor-pointer items-center gap-1 px-3 py-1.5 text-xs font-medium transition-colors rounded-md ${
            activeOrchTab === 'memory'
              ? 'bg-zinc-800 text-violet-400 ring-1 ring-zinc-600'
              : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
          }`}
        >
          <span>Memory</span>
          {memoryCount > 0 && (
            <span className="text-xs bg-violet-500/20 text-violet-400 rounded-full px-1.5 py-0.5 font-mono">
              {memoryCount}
            </span>
          )}
          <PopoutButton kind="memory" label="Memory" />
        </div>

        <div
          role="tab"
          tabIndex={0}
          aria-selected={activeOrchTab === 'schedules'}
          onClick={() => activateTab('schedules')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activateTab('schedules');
            }
          }}
          className={`flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors rounded-md ${
            activeOrchTab === 'schedules'
              ? 'bg-zinc-800 text-emerald-400 ring-1 ring-zinc-600'
              : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
          }`}
          title="Tasker"
        >
          <CalendarClock size={12} />
          <span>Tasker</span>
          {scheduleCount > 0 && (
            <span className="text-xs bg-emerald-500/20 text-emerald-400 rounded-full px-1.5 py-0.5 font-mono">
              {scheduleCount}
            </span>
          )}
          {liveSchedules > 0 && (
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" title={`${liveSchedules} running now`} />
          )}
          <PopoutButton kind="schedules" label="Tasker" />
        </div>

        <div
          role="tab"
          tabIndex={0}
          aria-selected={activeOrchTab === 'git'}
          onClick={() => activateTab('git')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activateTab('git');
            }
          }}
          className={`flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors rounded-md ${
            activeOrchTab === 'git'
              ? 'bg-zinc-800 text-orange-400 ring-1 ring-zinc-600'
              : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
          }`}
          title="Git: select a repository for this session"
        >
          <GitBranch size={12} />
          <span>Git</span>
          <PopoutButton kind="git" label="Git" />
        </div>

        <div
          role="tab"
          tabIndex={0}
          aria-selected={activeOrchTab === 'logs'}
          onClick={() => activateTab('logs')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activateTab('logs');
            }
          }}
          className={`flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors rounded-md ${
            activeOrchTab === 'logs'
              ? 'bg-zinc-800 text-amber-400 ring-1 ring-zinc-600'
              : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
          }`}
          title="System / gateway logs"
        >
          <ScrollText size={12} />
          <span>Logs</span>
          <PopoutButton kind="logs" label="Logs" />
        </div>

        {fileCount > 0 && (
          <div
            role="tab"
            tabIndex={0}
            aria-selected={activeOrchTab === 'files'}
            onClick={() => activateTab('files')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activateTab('files');
              }
            }}
            className={`flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors rounded-md ${
              activeOrchTab === 'files'
                ? 'bg-zinc-800 text-blue-400 ring-1 ring-zinc-600'
                : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
            }`}
          >
            <FileText size={12} />
            <span>Files</span>
            <span className="text-xs bg-blue-500/20 text-blue-400 rounded-full px-1.5 py-0.5 font-mono">
              {fileCount}
            </span>
            <PopoutButton kind="files" label="Files" />
          </div>
        )}

        {workflowIds.map((wfId) => {
          const dag = inlineDAGs[wfId];
          const graph = workflows[wfId]?.graphState;
          const status = getWorkflowStatus(dag?.status, graph?.status);
          const label = dag?.summary || graph?.name || wfId.slice(0, 8);
          const isDirect = !!dag?.isDirect;
          const isActive = activeOrchTab === 'workflow' && wfId === activeWorkflowId;
          const isTerminal = status === 'complete' || status === 'error' || status === 'stopped';
          const dotColor = statusColors[status] || 'bg-zinc-500';

          const isRunning = status === 'dispatched' || status === 'running';
          const isPaused = status === 'paused';
          const isInterrupted = status === 'interrupted';

          const showPlayResume = isPaused || isInterrupted;
          const showPause = isRunning;
          const showStop = isRunning || isPaused;

          const hoverOnly = isActive ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100';

          return (
            <div
              key={wfId}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              onClick={() => activateWorkflow(wfId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  activateWorkflow(wfId);
                }
              }}
              className={`group flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-zinc-200 ring-1 ring-zinc-600'
                  : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${dotColor} ${
                  status === 'running' ? 'animate-pulse' : ''
                }`}
              />
              <span className="max-w-[140px] truncate">{label}</span>
              {isDirect && (
                <span
                  className="rounded-sm bg-blue-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-blue-300 ring-1 ring-blue-500/30"
                  title="Direct-mode conversation turn (no DAG)"
                >
                  Direct
                </span>
              )}
              <div className="flex items-center gap-0.5">
                {showPlayResume && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      sendWorkflowCommand('resume', wfId);
                    }}
                    className={`rounded p-0.5 transition-all focus-visible:opacity-100 ${hoverOnly} ${
                      isInterrupted
                        ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                        : 'text-green-400 hover:bg-green-500/20'
                    }`}
                    title={isInterrupted ? 'Resume interrupted workflow' : 'Resume'}
                  >
                    <Play size={12} />
                  </button>
                )}
                {showPause && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      sendWorkflowCommand('pause', wfId);
                    }}
                    className={`rounded p-0.5 text-zinc-400 transition-all hover:bg-zinc-700 hover:text-amber-400 focus-visible:opacity-100 ${hoverOnly}`}
                    title="Pause at next layer boundary"
                  >
                    <Pause size={12} />
                  </button>
                )}
                {showStop && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      sendWorkflowCommand('stop', wfId);
                    }}
                    className={`rounded p-0.5 text-zinc-400 transition-all hover:bg-zinc-700 hover:text-red-400 focus-visible:opacity-100 ${hoverOnly}`}
                    title="Stop workflow"
                  >
                    <Square size={12} />
                  </button>
                )}
              </div>
              <PopoutButton kind="workflow" workflowId={wfId} label={label} />
              {isTerminal && (
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeWorkflow(wfId);
                  }}
                  className="ml-0.5 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {activeOrchTab === 'workflow' && workflowIds.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-6">
          <div className="text-sm text-zinc-400">No workflows yet</div>
          <div className="max-w-xs text-xs text-zinc-600">
            Start a workflow by sending a message in the chat. Orchestration graphs, activity, and summaries will appear here.
          </div>
        </div>
      ) : (
        <OrchPaneBody kind={activeOrchTab as OrchTabKind} />
      )}
    </div>
  );
}

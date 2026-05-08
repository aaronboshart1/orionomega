'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useGateway } from '@/lib/gateway';
import { useOrchestrationStore } from '@/stores/orchestration';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { OrchPaneBody, type OrchTabKind } from '@/components/orchestration/OrchPaneBody';

const VALID_KINDS: readonly OrchTabKind[] = [
  'memory',
  'schedules',
  'git',
  'logs',
  'files',
  'workflow',
] as const;

const TITLES: Record<OrchTabKind, string> = {
  memory: 'Memory',
  schedules: 'Tasker',
  git: 'Git',
  logs: 'Logs',
  files: 'Files',
  workflow: 'Workflow',
};

export default function OrchStandalonePage() {
  // Standalone view: mount the WS connection so live updates flow into
  // the same Zustand store that powers the in-app pane.
  useGateway();

  const params = useParams<{ slug?: string[] }>();
  const slugRaw = params?.slug;
  const slug = Array.isArray(slugRaw) ? slugRaw : slugRaw ? [slugRaw] : [];
  const rawKind = (slug[0] ?? 'memory') as OrchTabKind;
  const kind: OrchTabKind = (VALID_KINDS as readonly string[]).includes(rawKind)
    ? rawKind
    : 'memory';
  const workflowId = kind === 'workflow' ? slug[1] : undefined;

  // Mirror the URL into the store so any code that reads `activeOrchTab` /
  // `activeWorkflowId` (DAGVisualization, WorkflowSummary, ActivityFeed,
  // WorkerDetail, etc.) keeps working unchanged in the standalone window.
  //
  // The URL is authoritative: gateway snapshot rehydration also writes to
  // these fields (it picks the latest workflow as active for the in-app
  // view), so we subscribe to the store and re-pin on every change. Without
  // this, opening `/orch/workflow/<old-id>` while a newer workflow is
  // running would silently switch the standalone window to the newer one
  // after the WS snapshot arrives.
  useEffect(() => {
    const store = useOrchestrationStore;
    const enforce = () => {
      const s = store.getState();
      if (s.activeOrchTab !== kind) s.setActiveOrchTab(kind);
      if (kind === 'workflow' && workflowId && s.activeWorkflowId !== workflowId) {
        s.setActiveWorkflowId(workflowId);
      }
    };
    enforce();
    const unsubscribe = store.subscribe(enforce);
    return unsubscribe;
  }, [kind, workflowId]);

  // Update the document title so multiple pop-out tabs are distinguishable.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const suffix = kind === 'workflow' && workflowId ? ` · ${workflowId.slice(0, 8)}` : '';
    document.title = `${TITLES[kind]}${suffix} | OrionOmega`;
  }, [kind, workflowId]);

  return (
    <div
      id="main-content"
      className="fixed inset-0 flex flex-col bg-[var(--background)] text-[var(--foreground)]"
    >
      <ErrorBoundary
        fallback={
          <div className="flex h-full items-center justify-center text-xs text-red-400">
            Pane failed to load. Try refreshing.
          </div>
        }
      >
        <OrchPaneBody kind={kind} workflowId={workflowId} />
      </ErrorBoundary>
    </div>
  );
}

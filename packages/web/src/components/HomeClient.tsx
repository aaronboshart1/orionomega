'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { PanelRightOpen, PanelRightClose, X } from 'lucide-react';
import { ChatPane } from '@/components/chat/ChatPane';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useOrchestrationStore, useOrchHydrated } from '@/stores/orchestration';
import { Z } from '@/lib/z-index';

// Tailwind's `md` breakpoint — orch pane uses `md:block` / `md:relative`
// to switch from mobile fullscreen overlay to desktop split-view.
const MD_BREAKPOINT_PX = 768;

const OrchestrationPane = dynamic(
  () => import('@/components/orchestration/OrchestrationPane').then((m) => m.OrchestrationPane),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Loading orchestration…
      </div>
    ),
  },
);

export function HomeClient() {
  const orchHydrated = useOrchHydrated();
  const orchPaneOpen = useOrchestrationStore((s) => s.orchPaneOpen);
  const setOrchPaneOpen = useOrchestrationStore((s) => s.setOrchPaneOpen);

  // On mobile (< md), the orch pane renders as a fullscreen `fixed inset-0`
  // overlay and the chat container is `hidden md:block`, removing the chat
  // input from the DOM. Combined with the persisted `orchPaneOpen: true`
  // default, that meant a mobile user landing on the app saw the orch pane
  // covering the chat and could not type. Auto-close on first hydrated mount
  // when the viewport is mobile so the chat input is always reachable on
  // load. Desktop split-view (≥ md) is preserved — the pane stays open.
  // Users can still explicitly open it on mobile via the toggle button; the
  // close happens once on mount, not on every resize.
  useEffect(() => {
    if (!orchHydrated) return;
    if (typeof window === 'undefined') return;
    if (window.innerWidth >= MD_BREAKPOINT_PX) return;
    if (useOrchestrationStore.getState().orchPaneOpen) {
      setOrchPaneOpen(false);
    }
  }, [orchHydrated, setOrchPaneOpen]);

  const showOrchPane = orchHydrated && orchPaneOpen;

  return (
    <div id="main-content" className="fixed inset-0 flex">
      <div className={showOrchPane ? 'hidden md:block md:w-1/2' : 'w-full'}>
        <ErrorBoundary
          fallback={
            <div className="flex h-full items-center justify-center text-xs text-red-400">
              Chat failed to load. Try refreshing.
            </div>
          }
        >
          <ChatPane />
        </ErrorBoundary>
      </div>

      <button
        onClick={() => setOrchPaneOpen(!orchPaneOpen)}
        className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/90 px-2.5 py-2 text-zinc-400 shadow-lg backdrop-blur transition-colors hover:border-zinc-600 hover:text-zinc-200 min-h-[44px] min-w-[44px] md:min-h-0"
        style={{ zIndex: Z.orchPaneToggle }}
        title={showOrchPane ? 'Hide detail pane' : 'Show detail pane'}
        aria-label={showOrchPane ? 'Hide detail pane' : 'Show detail pane'}
      >
        {showOrchPane ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        <span className="hidden md:inline text-xs font-medium">
          {showOrchPane ? 'Hide' : 'Detail'}
        </span>
      </button>

      {showOrchPane && (
        <>
          <div className="fixed inset-0 flex flex-col bg-[var(--background)] md:relative md:inset-auto md:z-auto md:w-1/2 md:border-l md:border-zinc-800" style={{ zIndex: Z.orchPaneMobile }}>
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 md:hidden">
              <h2 className="text-sm font-semibold text-zinc-100">Orchestration</h2>
              <button
                onClick={() => setOrchPaneOpen(false)}
                className="rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 min-h-[44px] min-w-[44px] flex items-center justify-center"
                aria-label="Close orchestration pane"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <ErrorBoundary
                fallback={
                  <div className="flex h-full items-center justify-center text-xs text-red-400">
                    Orchestration pane failed to load. Try refreshing.
                  </div>
                }
              >
                <OrchestrationPane />
              </ErrorBoundary>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

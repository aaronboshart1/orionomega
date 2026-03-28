'use client';

import { PanelRightOpen, PanelRightClose } from 'lucide-react';
import { ChatPane } from '@/components/chat/ChatPane';
import { OrchestrationPane } from '@/components/orchestration/OrchestrationPane';
import { useOrchestrationStore, useOrchHydrated } from '@/stores/orchestration';

export default function Home() {
  const orchHydrated = useOrchHydrated();
  const orchPaneOpen = useOrchestrationStore((s) => s.orchPaneOpen);
  const setOrchPaneOpen = useOrchestrationStore((s) => s.setOrchPaneOpen);

  const showOrchPane = orchHydrated && orchPaneOpen;

  return (
    <div className="flex h-screen">
      <div className={showOrchPane ? 'w-1/2 min-w-[400px]' : 'w-full'}>
        <ChatPane />
      </div>

      <button
        onClick={() => setOrchPaneOpen(!orchPaneOpen)}
        className="absolute right-3 top-3 z-10 rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-400 shadow-lg transition-colors hover:border-zinc-600 hover:text-zinc-200"
        title={showOrchPane ? 'Hide detail pane' : 'Show detail pane'}
      >
        {showOrchPane ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>

      {showOrchPane && (
        <div className="w-1/2 border-l border-zinc-800">
          <OrchestrationPane />
        </div>
      )}
    </div>
  );
}

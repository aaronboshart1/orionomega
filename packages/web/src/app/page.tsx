'use client';

import { useState } from 'react';
import { PanelRightOpen, PanelRightClose } from 'lucide-react';
import { ChatPane } from '@/components/chat/ChatPane';
import { OrchestrationPane } from '@/components/orchestration/OrchestrationPane';
import { useOrchestrationStore } from '@/stores/orchestration';

export default function Home() {
  const graphState = useOrchestrationStore((s) => s.graphState);
  const [showOrchPane, setShowOrchPane] = useState(false);

  const canShowPane = !!graphState;

  return (
    <div className="flex h-screen">
      <div className={showOrchPane && canShowPane ? 'w-1/2 min-w-[400px]' : 'w-full'}>
        <ChatPane />
      </div>

      {/* Toggle button for orchestration detail pane */}
      {canShowPane && (
        <button
          onClick={() => setShowOrchPane((v) => !v)}
          className="absolute right-3 top-3 z-10 rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-400 shadow-lg transition-colors hover:border-zinc-600 hover:text-zinc-200"
          title={showOrchPane ? 'Hide detail pane' : 'Show DAG detail'}
        >
          {showOrchPane ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      )}

      {showOrchPane && canShowPane && (
        <div className="w-1/2 border-l border-zinc-800">
          <OrchestrationPane />
        </div>
      )}
    </div>
  );
}

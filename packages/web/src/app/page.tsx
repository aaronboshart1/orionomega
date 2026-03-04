'use client';

import { ChatPane } from '@/components/chat/ChatPane';
import { OrchestrationPane } from '@/components/orchestration/OrchestrationPane';
import { useOrchestrationStore } from '@/stores/orchestration';

export default function Home() {
  const graphState = useOrchestrationStore((s) => s.graphState);

  return (
    <div className="flex h-screen">
      <div className={graphState ? 'w-1/2 min-w-[400px]' : 'w-full'}>
        <ChatPane />
      </div>
      {graphState && (
        <div className="w-1/2 border-l border-zinc-800">
          <OrchestrationPane />
        </div>
      )}
    </div>
  );
}

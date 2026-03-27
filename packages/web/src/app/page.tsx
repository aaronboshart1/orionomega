'use client';

import { useState } from 'react';
import { PanelRightOpen, PanelRightClose } from 'lucide-react';
import { ChatPane } from '@/components/chat/ChatPane';
import { OrchestrationPane } from '@/components/orchestration/OrchestrationPane';
import { useOrchestrationStore } from '@/stores/orchestration';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={() => setShowOrchPane((v) => !v)}
              variant="outline"
              size="icon"
              className="absolute right-3 top-3 z-10 shadow-lg"
              aria-label={showOrchPane ? 'Hide orchestration pane' : 'Show orchestration pane'}
              aria-expanded={showOrchPane}
              aria-controls="orchestration-pane"
            >
              {showOrchPane ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {showOrchPane ? 'Hide detail pane' : 'Show DAG detail'}
          </TooltipContent>
        </Tooltip>
      )}

      {showOrchPane && canShowPane && (
        <div id="orchestration-pane" className="w-1/2 border-l border-zinc-800" role="complementary" aria-label="Workflow orchestration">
          <OrchestrationPane />
        </div>
      )}
    </div>
  );
}

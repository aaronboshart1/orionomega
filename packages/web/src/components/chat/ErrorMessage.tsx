'use client';

import { AlertTriangle, ChevronDown, ChevronRight, RefreshCcw, ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { useChatStore } from '@/stores/chat';
import { useAgentModeStore } from '@/stores/agent-mode';
import { useGateway } from '@/lib/gateway';

interface ErrorMessageProps {
  content: string;
}

/**
 * Render a single short, friendly headline for the error and treat the
 * full content as collapsible technical detail. Provides Retry and
 * Switch-to-Orchestrate recovery CTAs aimed at unblocking direct-mode
 * failures without forcing the user to copy-paste their last prompt.
 */
function deriveHeadline(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim()) || 'Something went wrong';
  // Strip common error prefixes like "Error: " for a friendlier headline.
  const stripped = firstLine.replace(/^(error|exception|failed):?\s*/i, '');
  return stripped.length > 120 ? stripped.slice(0, 117) + '…' : stripped;
}

export function ErrorMessage({ content }: ErrorMessageProps) {
  const [showDetail, setShowDetail] = useState(false);
  const { sendChat } = useGateway();
  const setMode = useAgentModeStore((s) => s.setMode);
  const headline = deriveHeadline(content);
  const hasDetail = content.trim().length > headline.length;

  const handleRetry = () => {
    const messages = useChatStore.getState().messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { void sendChat(messages[i].content); return; }
    }
  };
  const handleSwitchToOrchestrate = () => {
    setMode('orchestrate');
    handleRetry();
  };

  return (
    <div className="my-3 flex justify-start" role="alert" aria-live="polite">
      <div className="max-w-[85%] rounded-xl border border-red-500/30 bg-red-950/30 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-red-200">{headline}</div>
            {hasDetail && (
              <button
                type="button"
                onClick={() => setShowDetail((v) => !v)}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-red-300/80 hover:text-red-200"
                aria-expanded={showDetail}
              >
                {showDetail ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {showDetail ? 'Hide technical detail' : 'Show technical detail'}
              </button>
            )}
            {showDetail && hasDetail && (
              <div className="mt-2 max-h-64 overflow-auto rounded bg-red-950/40 p-2 text-xs leading-relaxed text-red-300/90">
                <MarkdownContent content={content} />
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={handleRetry}
                className="flex items-center gap-1 rounded border border-red-700/50 bg-red-950/60 px-2 py-1 text-[11px] text-red-100 transition-colors hover:bg-red-900/70"
              >
                <RefreshCcw size={10} /> Retry
              </button>
              <button
                type="button"
                onClick={handleSwitchToOrchestrate}
                className="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-800"
                title="Switch to Orchestrate mode and replay your last message"
              >
                <ArrowRightLeft size={10} /> Switch to Orchestrate
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

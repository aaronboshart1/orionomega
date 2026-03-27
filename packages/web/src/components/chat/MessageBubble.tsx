'use client';

import type { ChatMessage } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { InlineDAGCard } from './InlineDAGCard';
import { RunSummaryCard } from './RunSummaryCard';
import { DAGConfirmationCard } from './DAGConfirmationCard';
import { MarkdownContent } from './MarkdownContent';
import { useGateway } from '@/lib/gateway';

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, type, dagId, interrupted } = message;
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const pendingConfirmation = useOrchestrationStore((s) => s.pendingConfirmation);
  const { respondToConfirmation } = useGateway();

  // DAG-dispatched messages render with an inline progress card
  if (type === 'dag-dispatched' && dagId) {
    const dag = inlineDAGs[dagId];
    return (
      <div className="my-3 flex justify-start" role="article" aria-label="Assistant workflow message">
        <div className="max-w-[85%]">
          {dag ? (
            <InlineDAGCard dag={dag} />
          ) : (
            <div className="rounded-2xl bg-zinc-800 px-4 py-3 text-sm text-zinc-100">
              <MarkdownContent content={content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // DAG-confirmation messages render with approval UI
  if (type === 'dag-confirmation' && dagId && pendingConfirmation?.dagId === dagId) {
    return (
      <div className="my-3 flex justify-start" role="article" aria-label="Confirmation required">
        <div className="max-w-[85%]">
          <DAGConfirmationCard
            confirmation={pendingConfirmation}
            onRespond={respondToConfirmation}
          />
        </div>
      </div>
    );
  }

  if (type === 'dag-complete' && dagId) {
    const dag = inlineDAGs[dagId];
    return (
      <div className="my-3 flex justify-start" role="article" aria-label="Workflow complete">
        <div className="max-w-[85%]">
          {dag ? (
            <RunSummaryCard dag={dag} />
          ) : (
            <div className="rounded-2xl bg-zinc-800 px-4 py-3 text-sm leading-relaxed text-zinc-100">
              <MarkdownContent content={content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (role === 'system') {
    return (
      <div className="my-3 flex justify-center" role="article" aria-label="System message">
        <div className="max-w-md rounded-lg bg-zinc-800/50 px-4 py-2 text-center text-xs text-zinc-400">
          {type === 'command-result' && '\u26A1 '}
          <MarkdownContent content={content} />
        </div>
      </div>
    );
  }

  const isUser = role === 'user';

  return (
    <div
      className={`my-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}
      role="article"
      aria-label={isUser ? 'Your message' : 'Assistant message'}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-zinc-800 text-zinc-100'
        } ${interrupted ? 'opacity-70 border border-red-500/30' : ''}`}
      >
        <MarkdownContent content={content} />
        {interrupted && (
          <p className="mt-1 text-xs text-red-400/70">⚠ Response interrupted</p>
        )}
      </div>
    </div>
  );
}

'use client';

import type { ChatMessage } from '@/stores/chat';
import { useChatStore } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { InlineDAGCard } from './InlineDAGCard';
import { RunSummaryCard } from './RunSummaryCard';
import { DAGConfirmationCard } from './DAGConfirmationCard';
import { ToolCallCard } from './ToolCallCard';
import { MarkdownContent } from './MarkdownContent';
import { useGateway } from '@/lib/gateway';

interface MessageBubbleProps {
  message: ChatMessage;
}

function formatPlainText(content: string) {
  const parts: (string | JSX.Element)[] = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) parts.push(<br key={`br-${i}`} />);
    parts.push(line);
  });
  return parts;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, type, dagId } = message;
  const isStreaming = useChatStore((s) => s.isStreaming);
  const messages = useChatStore((s) => s.messages);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const pendingConfirmation = useOrchestrationStore((s) => s.pendingConfirmation);
  const { respondToConfirmation } = useGateway();

  const isLastMessage = messages.length > 0 && messages[messages.length - 1].id === message.id;
  const isActivelyStreaming = isStreaming && isLastMessage && role === 'assistant';

  if (type === 'dag-dispatched' && dagId) {
    const dag = inlineDAGs[dagId];
    return (
      <div className="my-3 flex justify-start">
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

  if (type === 'dag-confirmation' && dagId && pendingConfirmation?.dagId === dagId) {
    return (
      <div className="my-3 flex justify-start">
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
      <div className="my-3 flex justify-start">
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

  if (type === 'tool-call' && message.toolCall) {
    return (
      <div className="my-1 flex justify-start">
        <div className="max-w-[85%] w-full">
          <ToolCallCard toolCall={message.toolCall} />
        </div>
      </div>
    );
  }

  if (role === 'system') {
    return (
      <div className="my-3 flex justify-center">
        <div className="max-w-md rounded-lg bg-zinc-800/50 px-4 py-2 text-center text-xs text-zinc-400">
          {type === 'command-result' && '\u26A1 '}
          <MarkdownContent content={content} />
        </div>
      </div>
    );
  }

  const isUser = role === 'user';

  return (
    <div className={`my-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-zinc-800 text-zinc-100'
        }`}
      >
        {isUser ? formatPlainText(content) : <MarkdownContent content={content} isStreaming={isActivelyStreaming} />}
      </div>
    </div>
  );
}

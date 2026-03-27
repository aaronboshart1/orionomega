'use client';

import type { ChatMessage } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { InlineDAGCard } from './InlineDAGCard';
import { RunSummaryCard } from './RunSummaryCard';
import { DAGConfirmationCard } from './DAGConfirmationCard';
import { ToolCallCard } from './ToolCallCard';
import { useGateway } from '@/lib/gateway';

interface MessageBubbleProps {
  message: ChatMessage;
}

/** Simple inline formatting: backtick code, bold, and newlines */
function formatContent(content: string) {
  const parts: (string | JSX.Element)[] = [];
  const segments = content.split(/(```[\s\S]*?```|`[^`]+`|\*\*[^*]+\*\*)/g);

  segments.forEach((seg, i) => {
    if (seg.startsWith('```') && seg.endsWith('```')) {
      const code = seg.slice(3, -3).replace(/^\w+\n/, '');
      parts.push(
        <pre
          key={i}
          className="my-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-300"
        >
          <code>{code}</code>
        </pre>,
      );
    } else if (seg.startsWith('`') && seg.endsWith('`')) {
      parts.push(
        <code
          key={i}
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-blue-400"
        >
          {seg.slice(1, -1)}
        </code>,
      );
    } else if (seg.startsWith('**') && seg.endsWith('**')) {
      parts.push(
        <strong key={i} className="font-semibold">
          {seg.slice(2, -2)}
        </strong>,
      );
    } else {
      const lines = seg.split('\n');
      lines.forEach((line, li) => {
        if (li > 0) parts.push(<br key={`${i}-br-${li}`} />);
        parts.push(line);
      });
    }
  });

  return parts;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, type, dagId } = message;
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const pendingConfirmation = useOrchestrationStore((s) => s.pendingConfirmation);
  const { respondToConfirmation } = useGateway();

  // DAG-dispatched messages render with an inline progress card
  if (type === 'dag-dispatched' && dagId) {
    const dag = inlineDAGs[dagId];
    return (
      <div className="my-3 flex justify-start">
        <div className="max-w-[85%]">
          {dag ? (
            <InlineDAGCard dag={dag} />
          ) : (
            <div className="rounded-2xl bg-zinc-800 px-4 py-3 text-sm text-zinc-100">
              {formatContent(content)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // DAG-confirmation messages render with approval UI
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
              {formatContent(content)}
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
          {formatContent(content)}
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
        {formatContent(content)}
      </div>
    </div>
  );
}

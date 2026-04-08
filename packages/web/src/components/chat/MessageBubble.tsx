'use client';

import dynamic from 'next/dynamic';
import type { ChatMessage, MessageAttachment } from '@/stores/chat';
import { useChatStore } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { InlineDAGCard } from './InlineDAGCard';
import { RunSummaryCard } from './RunSummaryCard';
import { DAGConfirmationCard } from './DAGConfirmationCard';
import { ToolCallCard } from './ToolCallCard';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useGateway } from '@/lib/gateway';
import { Reply, FileText } from 'lucide-react';
import { formatBytes } from '@/utils/format';

// Dynamically import MarkdownContent — it pulls in react-markdown, remark-gfm,
// rehype-highlight, rehype-sanitize, and highlight.js (~150KB+ of JS/CSS).
// Deferred loading prevents this from blocking the initial chat render.
const MarkdownContent = dynamic(
  () => import('./MarkdownContent').then((m) => m.MarkdownContent),
  {
    loading: () => <span className="text-xs text-zinc-500">Loading…</span>,
  },
);

interface MessageBubbleProps {
  message: ChatMessage;
  onScrollToMessage?: (messageId: string) => void;
}

function truncateContent(text: string, maxLen = 80): string {
  const single = text.replace(/\n/g, ' ').trim();
  return single.length > maxLen ? single.slice(0, maxLen) + '…' : single;
}

function AttachmentDisplay({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((att) => {
        const isImage = att.type.startsWith('image/');
        if (isImage && att.dataUrl) {
          return (
            <div key={`${att.name}-${att.size}`} className="overflow-hidden rounded-lg border border-white/10">
              <img
                src={att.dataUrl}
                alt={att.name}
                className="max-h-48 max-w-[280px] object-contain"
                loading="lazy"
                decoding="async"
                width={280}
                height={192}
              />
              <div className="bg-black/50 px-2 py-1 text-xs text-white/50">
                {att.name} ({formatBytes(att.size)})
              </div>
            </div>
          );
        }
        return (
          <div
            key={`${att.name}-${att.size}`}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2"
          >
            <FileText size={16} className="shrink-0 text-white/50" />
            <div className="min-w-0">
              <div className="truncate text-xs text-white/80">{att.name}</div>
              <div className="text-xs text-white/40">{formatBytes(att.size)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="absolute -bottom-1 right-0 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-700 text-zinc-300 opacity-100 shadow transition-all hover:bg-zinc-600 hover:text-white md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
      aria-label="Reply to this message"
    >
      <Reply size={12} />
    </button>
  );
}

export function MessageBubble({ message, onScrollToMessage }: MessageBubbleProps) {
  const { role, content, type, dagId, replyTo, attachments } = message;
  const isStreaming = useChatStore((s) => s.isStreaming);
  const messages = useChatStore((s) => s.messages);
  const setReplyTarget = useChatStore((s) => s.setReplyTarget);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const pendingConfirmation = useOrchestrationStore((s) => s.pendingConfirmation);
  const { respondToConfirmation } = useGateway();

  const handleReply = () => {
    setReplyTarget({
      messageId: message.id,
      content: message.content,
      role: message.role,
      dagId: message.dagId,
    });
  };

  const isLastMessage = messages.length > 0 && messages[messages.length - 1].id === message.id;
  const isActivelyStreaming = isStreaming && isLastMessage && role === 'assistant';

  if (type === 'dag-dispatched' && dagId) {
    const dag = inlineDAGs[dagId];
    return (
      <div className="group my-3 flex justify-start">
        <div className="relative max-w-[95%] md:max-w-[85%]">
          {dag ? (
            <InlineDAGCard dag={dag} />
          ) : content ? (
            <div className="rounded-2xl bg-zinc-800 px-4 py-3 text-sm text-zinc-100">
              <ErrorBoundary><MarkdownContent content={content} /></ErrorBoundary>
            </div>
          ) : null}
          <ReplyButton onClick={handleReply} />
        </div>
      </div>
    );
  }

  if (type === 'dag-confirmation' && dagId && pendingConfirmation?.dagId === dagId) {
    return (
      <div className="my-3 flex justify-start">
        <div className="max-w-[95%] md:max-w-[85%]">
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
      <div className="group my-3 flex justify-start">
        <div className="relative max-w-[95%] md:max-w-[85%]">
          {dag ? (
            <RunSummaryCard dag={dag} />
          ) : content ? (
            <div className="rounded-2xl bg-zinc-800 px-4 py-3 text-sm leading-relaxed text-zinc-100">
              <ErrorBoundary><MarkdownContent content={content} /></ErrorBoundary>
            </div>
          ) : null}
          <ReplyButton onClick={handleReply} />
        </div>
      </div>
    );
  }

  if (type === 'tool-call' && message.toolCall) {
    return (
      <div className="my-1 flex justify-start">
        <div className="max-w-[95%] md:max-w-[85%] w-full">
          <ToolCallCard toolCall={message.toolCall} />
        </div>
      </div>
    );
  }

  if (role === 'system') {
    return (
      <div className="group my-3 flex justify-center">
        <div className="relative max-w-md rounded-lg bg-zinc-800/50 px-4 py-2 text-center text-xs text-zinc-400">
          {type === 'command-result' && '\u26A1 '}
          <ErrorBoundary><MarkdownContent content={content} /></ErrorBoundary>
          <ReplyButton onClick={handleReply} />
        </div>
      </div>
    );
  }

  const isUser = role === 'user';

  const replyQuote = replyTo ? (
    <button
      onClick={() => onScrollToMessage?.(replyTo.messageId)}
      className="mb-1.5 flex w-full cursor-pointer items-start gap-1.5 rounded-lg border-l-2 border-zinc-500 bg-zinc-700/40 px-2.5 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-700/60"
    >
      <Reply size={12} className="mt-0.5 shrink-0 rotate-180" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-zinc-300">
          {replyTo.role === 'user' ? 'You' : 'Assistant'}
        </span>
        {' · '}
        {truncateContent(replyTo.content)}
      </span>
    </button>
  ) : null;

  return (
    <div className={`group my-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="relative max-w-[92%] md:max-w-[80%]">
        {replyQuote}
        {message.isBackground && (
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-amber-500/70">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500/60" />
            Background
            {message.workflowId && (
              <span className="font-mono text-amber-500/50">{message.workflowId.slice(0, 12)}</span>
            )}
          </div>
        )}
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'bg-blue-600 text-white'
              : message.isBackground
                ? 'border border-amber-500/20 bg-zinc-800/80 text-zinc-100'
                : 'bg-zinc-800 text-zinc-100'
          }`}
        >
          {isUser ? content.split('\n').flatMap((line, i) => i > 0 ? [<br key={`br-${i}`} />, line] : [line]) : <ErrorBoundary><MarkdownContent content={content} isStreaming={isActivelyStreaming} /></ErrorBoundary>}
          {isUser && attachments && attachments.length > 0 && (
            <AttachmentDisplay attachments={attachments} />
          )}
        </div>
        <ReplyButton onClick={handleReply} />
      </div>
    </div>
  );
}

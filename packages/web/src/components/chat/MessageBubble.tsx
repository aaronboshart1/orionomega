'use client';

import dynamic from 'next/dynamic';
import type { ChatMessage, MessageAttachment } from '@/stores/chat';
import { useChatStore } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { InlineDAGCard } from './InlineDAGCard';
import { RunSummaryCard } from './RunSummaryCard';
import { DAGConfirmationCard } from './DAGConfirmationCard';
import { GateApprovalCard } from './GateApprovalCard';
import { ToolCallCard } from './ToolCallCard';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useGateway } from '@/lib/gateway';
import { Reply, FileText, Copy, Check, RefreshCcw, Pencil, ThumbsUp, ThumbsDown, ArrowRight } from 'lucide-react';
import { formatBytes } from '@/utils/format';
import { copyToClipboard } from '@/utils/clipboard';
import { useCallback, useState } from 'react';

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

function MessageActionButton({
  onClick,
  label,
  children,
  className = '',
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-6 items-center gap-1 rounded-md bg-zinc-800/80 px-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 ${className}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function MessageActionBar({
  align,
  onCopy,
  copied,
  extras,
}: {
  align: 'left' | 'right';
  onCopy: () => void;
  copied: boolean;
  extras?: React.ReactNode;
}) {
  return (
    <div
      className={`mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
        align === 'right' ? 'justify-end' : 'justify-start'
      }`}
    >
      <MessageActionButton onClick={onCopy} label={copied ? 'Copied' : 'Copy message'}>
        {copied ? <Check size={10} /> : <Copy size={10} />}
        {copied ? 'Copied' : 'Copy'}
      </MessageActionButton>
      {extras}
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
  const truncateAfter = useChatStore((s) => s.truncateAfter);
  const setDraftInput = useChatStore((s) => s.setDraftInput);
  const setMessageFeedback = useChatStore((s) => s.setMessageFeedback);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const pendingConfirmation = useOrchestrationStore((s) => s.pendingConfirmation);
  const pendingGates = useOrchestrationStore((s) => s.pendingGates);
  const { respondToConfirmation, respondToGate, sendChat, sendFeedback } = useGateway();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!content) return;
    copyToClipboard(content).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return;
    // Walk backwards from this assistant message to find the user message that produced it.
    const idx = messages.findIndex((m) => m.id === message.id);
    if (idx < 0) return;
    let userIdx = -1;
    for (let i = idx; i >= 0; i--) {
      if (messages[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const userMsg = messages[userIdx];
    truncateAfter(userMsg.id);
    void sendChat(userMsg.content);
  }, [isStreaming, messages, message.id, truncateAfter, sendChat]);

  const handleEdit = useCallback(() => {
    if (isStreaming || message.role !== 'user') return;
    // Edit semantics: remove the original user message AND everything
    // after it from the thread, then prefill the composer with the
    // original content. The user's submit re-sends from that point as
    // a fresh user message — leaving no stale duplicate of the
    // pre-edit text in the conversation history.
    truncateAfter(message.id);
    setDraftInput(content);
  }, [isStreaming, message.id, message.role, content, truncateAfter, setDraftInput]);

  const handleContinue = useCallback(() => {
    if (isStreaming) return;
    void sendChat('Please continue from where you left off.');
  }, [isStreaming, sendChat]);

  const handleFeedback = useCallback((value: 'good' | 'bad') => {
    const next = message.feedback === value ? null : value;
    setMessageFeedback(message.id, next);
    // Emit a lightweight feedback event over the gateway socket so the
    // backend can record/forward telemetry. Non-persistent on the
    // server side — see websocket.ts case 'feedback'.
    sendFeedback(message.id, next);
  }, [message.id, message.feedback, setMessageFeedback, sendFeedback]);

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

  if (type === 'gate-request' && dagId) {
    const gate = pendingGates[dagId];
    // Only render the actionable Allow/Deny card when the server still
    // has the gate as pending. Historical gate-request messages from a
    // previous run/reload should not surface stale approval buttons.
    if (gate) {
      return (
        <div className="my-3 flex justify-start">
          <div className="max-w-[95%] md:max-w-[85%]">
            <GateApprovalCard
              gate={gate}
              resolved={gate.resolved ?? null}
              onRespond={respondToGate}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="my-3 flex justify-start">
        <div className="max-w-[95%] rounded-2xl bg-zinc-800 px-4 py-2 text-xs text-zinc-400 md:max-w-[85%]">
          {content.replace(/^Approval needed:\s*/, 'Approval was needed: ')} (resolved)
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
    // Allow retrying a failed tool call by replaying the prior user turn
    // (only meaningful for direct-mode tool cards inline in chat).
    const handleToolRetry = () => {
      if (isStreaming) return;
      const idx = messages.findIndex((m) => m.id === message.id);
      if (idx < 0) return;
      let userIdx = -1;
      for (let i = idx; i >= 0; i--) {
        if (messages[i].role === 'user') { userIdx = i; break; }
      }
      if (userIdx < 0) return;
      const userMsg = messages[userIdx];
      truncateAfter(userMsg.id);
      void sendChat(userMsg.content);
    };
    return (
      <div className="my-1 flex justify-start">
        <div className="max-w-[95%] md:max-w-[85%] w-full">
          <ToolCallCard toolCall={message.toolCall} onRetry={handleToolRetry} workflowId={message.dagId} />
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
        {!isActivelyStreaming && content && (
          <MessageActionBar
            align={isUser ? 'right' : 'left'}
            onCopy={handleCopy}
            copied={copied}
            extras={
              isUser ? (
                <MessageActionButton onClick={handleEdit} label="Edit and resend">
                  <Pencil size={10} />
                  Edit
                </MessageActionButton>
              ) : (
                <>
                  <MessageActionButton onClick={handleRegenerate} label="Regenerate response">
                    <RefreshCcw size={10} />
                    Retry
                  </MessageActionButton>
                  {message.interrupted && (
                    <MessageActionButton onClick={handleContinue} label="Continue this response">
                      <ArrowRight size={10} />
                      Continue
                    </MessageActionButton>
                  )}
                  <MessageActionButton
                    onClick={() => handleFeedback('good')}
                    label="Mark as helpful"
                    className={message.feedback === 'good' ? '!text-emerald-300 !bg-emerald-900/40' : ''}
                  >
                    <ThumbsUp size={10} />
                  </MessageActionButton>
                  <MessageActionButton
                    onClick={() => handleFeedback('bad')}
                    label="Mark as unhelpful"
                    className={message.feedback === 'bad' ? '!text-red-300 !bg-red-900/40' : ''}
                  >
                    <ThumbsDown size={10} />
                  </MessageActionButton>
                </>
              )
            }
          />
        )}
        <ReplyButton onClick={handleReply} />
      </div>
    </div>
  );
}

'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { Settings2, ArrowDown, AlertOctagon } from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useGateway } from '@/lib/gateway';
import { MessageBubble } from './MessageBubble';
import { ToolCallGroup } from './ToolCallCard';
import { ChatInput } from './ChatInput';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ErrorMessage } from './ErrorMessage';
import { PlanCard } from './PlanCard';
import { BackgroundTaskIndicator } from './BackgroundTaskIndicator';
import type { ChatMessage } from '@/stores/chat';

export function ChatPane() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const thinkingContent = useChatStore((s) => s.thinkingContent);
  const streamingStatus = useChatStore((s) => s.streamingStatus);
  const activePlan = useOrchestrationStore((s) => s.activePlan);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const { sendChat, sendCommand, respondToPlan } = useGateway();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showAdvancedPlan, setShowAdvancedPlan] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const prevTickRef = useRef(0);

  const contentTick = messages.length + (messages.length > 0 ? messages[messages.length - 1].content.length : 0) + thinkingContent.length;

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setAutoScroll(true);
    setShowNewMessages(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) {
      setAutoScroll(true);
      setShowNewMessages(false);
    } else {
      setAutoScroll(false);
    }
  }, []);

  useEffect(() => {
    const changed = contentTick !== prevTickRef.current;
    prevTickRef.current = contentTick;

    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (changed) {
      setShowNewMessages(true);
    }
  }, [contentTick, autoScroll]);

  const hasActiveDAGs = Object.values(inlineDAGs).some(
    (d) => d.status === 'dispatched' || d.status === 'running',
  );
  const inputDisabled = isStreaming && !hasActiveDAGs;

  const handleSend = (text: string) => {
    if (text.startsWith('/')) {
      sendCommand(text.slice(1));
    } else {
      sendChat(text);
    }
  };

  const renderMessages = () => {
    const elements: React.ReactNode[] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];

      if (msg.type === 'error') {
        elements.push(<ErrorMessage key={msg.id} content={msg.content} />);
        i++;
        continue;
      }

      if (msg.type === 'tool-call' && msg.toolCall) {
        const groupNodeId = msg.toolCall.nodeId;
        const groupLabel = msg.toolCall.nodeLabel || groupNodeId || 'Worker';
        const group: { id: string; toolCall: NonNullable<ChatMessage['toolCall']> }[] = [];
        if (groupNodeId) {
          while (
            i < messages.length &&
            messages[i].type === 'tool-call' &&
            messages[i].toolCall &&
            messages[i].toolCall!.nodeId === groupNodeId
          ) {
            group.push({ id: messages[i].id, toolCall: messages[i].toolCall! });
            i++;
          }
        } else {
          group.push({ id: messages[i].id, toolCall: messages[i].toolCall! });
          i++;
        }
        if (group.length > 1) {
          elements.push(
            <ToolCallGroup
              key={`group-${group[0].id}`}
              nodeLabel={groupLabel}
              toolCalls={group}
            />,
          );
        } else {
          elements.push(
            <MessageBubble key={group[0].id} message={messages[i - 1]} />,
          );
        }
        continue;
      }

      elements.push(
        <div key={msg.id}>
          <MessageBubble message={msg} />
          {msg.interrupted && (
            <div className="mb-2 ml-1 flex items-center gap-1.5 text-xs text-amber-400/80">
              <AlertOctagon size={12} />
              <span>Response interrupted</span>
            </div>
          )}
        </div>,
      );
      i++;
    }
    return elements;
  };

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold">
          &Omega;
        </div>
        <div className="flex-1">
          <h1 className="text-sm font-semibold text-zinc-100">OrionOmega</h1>
          <p className="text-xs text-zinc-500">AI Orchestration</p>
        </div>
        <BackgroundTaskIndicator />
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto px-6 py-4"
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-zinc-600">
            <div className="mb-3 text-4xl">&Omega;</div>
            <p className="text-sm">Send a message to begin</p>
            <p className="mt-1 text-xs text-zinc-700">
              Ask anything — I&apos;ll handle the orchestration
            </p>
          </div>
        )}

        {renderMessages()}

        {activePlan && showAdvancedPlan && (
          <div className="my-4">
            <PlanCard plan={activePlan} onRespond={respondToPlan} />
          </div>
        )}

        {activePlan && !showAdvancedPlan && (
          <div className="my-3 flex justify-start">
            <button
              onClick={() => setShowAdvancedPlan(true)}
              className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800/60 px-4 py-2 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-300"
            >
              <Settings2 size={12} />
              Plan available — click to review
            </button>
          </div>
        )}

        {(thinkingContent || isStreaming) && (
          <ThinkingIndicator
            content={thinkingContent || undefined}
            statusText={streamingStatus || undefined}
          />
        )}

        <div ref={bottomRef} />
      </div>

      {showNewMessages && !autoScroll && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute -top-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-xs text-zinc-300 shadow-lg transition-colors hover:border-blue-500 hover:text-blue-400"
          >
            <ArrowDown size={12} />
            New messages
          </button>
        </div>
      )}

      <ChatInput onSend={handleSend} disabled={inputDisabled} />
    </div>
  );
}

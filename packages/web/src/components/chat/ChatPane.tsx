'use client';

import { useRef, useState, useCallback, useMemo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
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

type RenderItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'error'; message: ChatMessage }
  | { kind: 'tool-group'; nodeLabel: string; toolCalls: { id: string; toolCall: NonNullable<ChatMessage['toolCall']> }[] };

function buildRenderItems(messages: ChatMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.type === 'error') {
      items.push({ kind: 'error', message: msg });
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
        items.push({ kind: 'tool-group', nodeLabel: groupLabel, toolCalls: group });
      } else {
        items.push({ kind: 'message', message: messages[i - 1] });
      }
    } else {
      items.push({ kind: 'message', message: msg });
      i++;
    }
  }
  return items;
}

export function ChatPane() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const thinkingContent = useChatStore((s) => s.thinkingContent);
  const streamingStatus = useChatStore((s) => s.streamingStatus);
  const activePlan = useOrchestrationStore((s) => s.activePlan);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const { sendChat, sendCommand, respondToPlan } = useGateway();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showAdvancedPlan, setShowAdvancedPlan] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  const hasActiveDAGs = Object.values(inlineDAGs).some(
    (d) => d.status === 'dispatched' || d.status === 'running',
  );
  const inputDisabled = isStreaming && !hasActiveDAGs;

  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);

  const handleSend = (text: string) => {
    if (text.startsWith('/')) {
      sendCommand(text.slice(1));
    } else {
      sendChat(text);
    }
  };

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      behavior: 'smooth',
      align: 'end',
    });
  }, []);

  const itemContent = useCallback(
    (index: number) => {
      const item = renderItems[index];
      if (!item) return null;
      if (item.kind === 'error') {
        return (
          <div className="px-6">
            <ErrorMessage key={item.message.id} content={item.message.content} />
          </div>
        );
      }
      if (item.kind === 'tool-group') {
        return (
          <div className="px-6">
            <ToolCallGroup
              key={`group-${item.toolCalls[0].id}`}
              nodeLabel={item.nodeLabel}
              toolCalls={item.toolCalls}
            />
          </div>
        );
      }
      return (
        <div className="px-6">
          <MessageBubble key={item.message.id} message={item.message} />
          {item.message.interrupted && (
            <div className="mb-2 ml-1 flex items-center gap-1.5 text-xs text-amber-400/80">
              <AlertOctagon size={12} />
              <span>Response interrupted</span>
            </div>
          )}
        </div>
      );
    },
    [renderItems],
  );

  const Footer = useCallback(() => {
    return (
      <>
        {activePlan && showAdvancedPlan && (
          <div className="my-4 px-6">
            <PlanCard plan={activePlan} onRespond={respondToPlan} />
          </div>
        )}

        {activePlan && !showAdvancedPlan && (
          <div className="my-3 flex justify-start px-6">
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
          <div className="px-6">
            <ThinkingIndicator
              content={thinkingContent || undefined}
              statusText={streamingStatus || undefined}
            />
          </div>
        )}
      </>
    );
  }, [activePlan, showAdvancedPlan, respondToPlan, thinkingContent, isStreaming, streamingStatus]);

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

      <div className="relative flex-1">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-zinc-600">
            <div className="mb-3 text-4xl">&Omega;</div>
            <p className="text-sm">Send a message to begin</p>
            <p className="mt-1 text-xs text-zinc-700">
              Ask anything — I&apos;ll handle the orchestration
            </p>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={renderItems.length}
            itemContent={itemContent}
            followOutput="smooth"
            atBottomStateChange={setAtBottom}
            atBottomThreshold={50}
            overscan={400}
            className="h-full"
            style={{ height: '100%' }}
            components={{
              Footer,
              Header: () => <div className="pt-4" />,
            }}
          />
        )}

        {!atBottom && messages.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/90 px-3 py-1.5 text-xs text-zinc-300 shadow-lg backdrop-blur transition-colors hover:border-zinc-600 hover:text-zinc-100"
          >
            <ArrowDown size={12} />
            New messages
          </button>
        )}
      </div>

      <ChatInput onSend={handleSend} disabled={inputDisabled} />
    </div>
  );
}

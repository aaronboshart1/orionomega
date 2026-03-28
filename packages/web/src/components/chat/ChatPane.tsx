'use client';

import { useRef, useState, useCallback, useMemo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { Settings2, ArrowDown, AlertOctagon, Settings } from 'lucide-react';
import { useChatStore, useChatHydrated } from '@/stores/chat';
import { useOrchestrationStore, useOrchHydrated } from '@/stores/orchestration';
import { useGateway } from '@/lib/gateway';
import { MessageBubble } from './MessageBubble';
import { ToolCallGroup } from './ToolCallCard';
import { ChatInput } from './ChatInput';
import type { FileAttachment } from './ChatInput';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ThinkingTimeline } from './ThinkingTimeline';
import { ErrorMessage } from './ErrorMessage';
import { PlanCard } from './PlanCard';
import { BackgroundTaskIndicator } from './BackgroundTaskIndicator';
import { ConnectionStatus } from './ConnectionStatus';
import { SettingsModal } from '../settings/SettingsModal';
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
  const chatHydrated = useChatHydrated();
  const orchHydrated = useOrchHydrated();
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const thinkingContent = useChatStore((s) => s.thinkingContent);
  const streamingStatus = useChatStore((s) => s.streamingStatus);
  const thinkingSteps = useChatStore((s) => s.thinkingSteps);
  const activePlan = useOrchestrationStore((s) => s.activePlan);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const { sendChat, sendCommand, respondToPlan } = useGateway();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showAdvancedPlan, setShowAdvancedPlan] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hydrated = chatHydrated && orchHydrated;

  const hasActiveDAGs = Object.values(inlineDAGs).some(
    (d) => d.status === 'dispatched' || d.status === 'running',
  );
  const inputDisabled = isStreaming && !hasActiveDAGs;

  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);

  const handleSend = (text: string, replyToId?: string, attachments?: FileAttachment[]) => {
    if (text.startsWith('/')) {
      sendCommand(text.slice(1));
    } else {
      sendChat(text, replyToId, attachments);
    }
  };

  const scrollToMessage = useCallback((messageId: string) => {
    const idx = renderItems.findIndex(
      (item) => item.kind === 'message' && item.message.id === messageId,
    );
    if (idx >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: idx, behavior: 'smooth', align: 'center' });
    }
  }, [renderItems]);

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
          <MessageBubble key={item.message.id} message={item.message} onScrollToMessage={scrollToMessage} />
          {item.message.interrupted && (
            <div className="mb-2 ml-1 flex items-center gap-1.5 text-xs text-amber-400/80">
              <AlertOctagon size={12} />
              <span>Response interrupted</span>
            </div>
          )}
        </div>
      );
    },
    [renderItems, scrollToMessage],
  );

  const Footer = useCallback(() => {
    return (
      <div className="pb-6">
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
            {thinkingSteps.length > 0 ? (
              <ThinkingTimeline
                steps={thinkingSteps}
                statusText={streamingStatus || undefined}
              />
            ) : (
              <ThinkingIndicator
                content={thinkingContent || undefined}
                statusText={streamingStatus || undefined}
              />
            )}
          </div>
        )}
      </div>
    );
  }, [activePlan, showAdvancedPlan, respondToPlan, thinkingContent, isStreaming, streamingStatus, thinkingSteps]);

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <img src="/omegaclaw-logo.png" alt="OmegaClaw" className="h-8 w-8 rounded-lg" />
        <div className="flex-1">
          <h1 className="text-sm font-semibold text-zinc-100">OmegaClaw</h1>
          <p className="text-[10px] leading-tight text-zinc-500">
            v{process.env.NEXT_PUBLIC_APP_VERSION} ({process.env.NEXT_PUBLIC_GIT_HASH})
          </p>
        </div>
        <ConnectionStatus />
        <BackgroundTaskIndicator />
        <button
          onClick={() => setSettingsOpen(true)}
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          title="Settings"
        >
          <Settings size={16} />
        </button>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <div className="relative flex-1">
        {!hydrated ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-zinc-600">
            <img src="/omegaclaw-logo.png" alt="OmegaClaw" className="mb-3 h-12 w-12" />
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

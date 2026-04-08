'use client';

import { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { Settings2, ArrowDown, AlertOctagon, Settings, Users } from 'lucide-react';
import { useChatStore, useChatHydrated } from '@/stores/chat';
import { useOrchestrationStore, useOrchHydrated } from '@/stores/orchestration';
import { useConnectionStore } from '@/stores/connection';
import { useGateway } from '@/lib/gateway';
import { SessionSwitcher } from './SessionSwitcher';
import { MessageBubble } from './MessageBubble';
import { ToolCallGroup } from './ToolCallCard';
import { ChatInput } from './ChatInput';
import type { FileAttachment } from './ChatInput';
import { AgentModeToggle } from './AgentModeToggle';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ThinkingTimeline } from './ThinkingTimeline';
import { ErrorMessage } from './ErrorMessage';
import { PlanCard } from './PlanCard';
import { BackgroundTaskIndicator } from './BackgroundTaskIndicator';
import { ConnectionStatus } from './ConnectionStatus';
import { SessionCostBar } from './SessionCostBar';
import type { ChatMessage } from '@/stores/chat';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { Z } from '@/lib/z-index';

const SettingsModal = dynamic(
  () => import('../settings/SettingsModal').then((m) => m.SettingsModal),
  { ssr: false },
);

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
        const singleMsg = messages[i - 1];
        if (singleMsg) items.push({ kind: 'message', message: singleMsg });
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
  const hasOlderMessages = useConnectionStore((s) => s.hasOlderMessages);
  const setHasOlderMessages = useConnectionStore((s) => s.setHasOlderMessages);
  const presenceCount = useConnectionStore((s) => s.presenceCount);
  const { sendChat, sendCommand, respondToPlan } = useGateway();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showAdvancedPlan, setShowAdvancedPlan] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const hydrated = chatHydrated && orchHydrated;


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

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !hasOlderMessages) return;
    const sessionId = useConnectionStore.getState().sessionId;
    if (!sessionId) return;
    const currentMessages = useChatStore.getState().messages;
    const oldestSeq = (currentMessages[0] as { seq?: number })?.seq ?? 0;
    setLoadingOlder(true);
    try {
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages?before_seq=${oldestSeq}&limit=50`,
      );
      if (resp.ok) {
        const { messages: olderMessages } = await resp.json() as { messages?: import('@/stores/chat').ChatMessage[] };
        if (olderMessages && olderMessages.length > 0) {
          useChatStore.getState().prependMessages(olderMessages);
        } else {
          setHasOlderMessages(false);
        }
      }
    } catch { /* ignore */ }
    finally { setLoadingOlder(false); }
  }, [loadingOlder, hasOlderMessages, setHasOlderMessages]);

  const scrollToDagId = useOrchestrationStore((s) => s.scrollToDagId);
  const clearScrollToDagId = useOrchestrationStore((s) => s.clearScrollToDagId);

  useEffect(() => {
    if (!scrollToDagId) return;
    const idx = renderItems.findIndex(
      (item) => item.kind === 'message' && item.message.type === 'dag-dispatched' && item.message.dagId === scrollToDagId,
    );
    if (idx >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: idx, behavior: 'smooth', align: 'center' });
      clearScrollToDagId();
    }
  }, [scrollToDagId, renderItems, clearScrollToDagId]);

  const itemContent = useCallback(
    (index: number) => {
      const item = renderItems[index];
      if (!item) return null;
      if (item.kind === 'error') {
        return (
          <div className="px-3 md:px-6">
            <ErrorMessage key={item.message.id} content={item.message.content} />
          </div>
        );
      }
      if (item.kind === 'tool-group') {
        return (
          <div className="px-3 md:px-6">
            <ToolCallGroup
              key={`group-${item.toolCalls[0].id}`}
              nodeLabel={item.nodeLabel}
              toolCalls={item.toolCalls}
            />
          </div>
        );
      }
      return (
        <div className="px-3 md:px-6">
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
          <div className="my-4 px-3 md:px-6">
            <PlanCard plan={activePlan} onRespond={respondToPlan} />
          </div>
        )}

        {activePlan && !showAdvancedPlan && (
          <div className="my-3 flex justify-start px-3 md:px-6">
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
          <div className="px-3 md:px-6">
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
      <div className="flex items-center gap-3 px-3 md:px-6 py-4">
        <Image src="/omegaclaw-logo.png" alt="OmegaClaw" width={32} height={32} className="rounded-lg" priority sizes="32px" />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-zinc-100">OmegaClaw</h1>
          <div className="flex items-center gap-2">
            <p className="text-xs leading-tight text-zinc-500">
              v{process.env.NEXT_PUBLIC_APP_VERSION} ({process.env.NEXT_PUBLIC_GIT_HASH})
            </p>
            <SessionSwitcher />
          </div>
        </div>
        {presenceCount > 1 && (
          <div className="flex items-center gap-1 text-[11px] text-zinc-600" title={`${presenceCount} active viewers`}>
            <Users size={11} />
            <span>{presenceCount}</span>
          </div>
        )}
        <ConnectionStatus />
        <BackgroundTaskIndicator />
        <button
          onClick={() => setSettingsOpen(true)}
          className="rounded-md p-2.5 md:px-2.5 md:py-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center gap-1.5"
          title="Settings"
        >
          <Settings size={16} />
          <span className="hidden md:inline text-xs">Settings</span>
        </button>
      </div>
      <ErrorBoundary fallback={null}>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </ErrorBoundary>

      <div className="relative flex-1">
        {!hydrated ? (
          <div className="flex h-full flex-col gap-4 p-6">
            <div className="flex justify-start">
              <div className="h-16 w-3/4 animate-pulse rounded-xl bg-zinc-800/60" />
            </div>
            <div className="flex justify-end">
              <div className="h-10 w-1/2 animate-pulse rounded-xl bg-zinc-800/40" />
            </div>
            <div className="flex justify-start">
              <div className="h-24 w-4/5 animate-pulse rounded-xl bg-zinc-800/60" />
            </div>
            <div className="flex justify-end">
              <div className="h-10 w-2/5 animate-pulse rounded-xl bg-zinc-800/40" />
            </div>
            <div className="flex justify-start">
              <div className="h-16 w-3/5 animate-pulse rounded-xl bg-zinc-800/60" />
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-zinc-600">
            <Image src="/omegaclaw-logo.png" alt="OmegaClaw" width={44} height={44} className="mb-4 opacity-60" sizes="44px" />
            <p className="text-sm font-medium text-zinc-400">Ready</p>
            <p className="mt-1 text-xs text-zinc-600">
              Ask anything — I&apos;ll handle the orchestration
            </p>
            <div className="mt-6 grid grid-cols-1 gap-1.5 w-full max-w-xs">
              {[
                { hint: 'Multi-agent DAG orchestration', detail: 'Orch mode' },
                { hint: 'Direct streaming response', detail: 'Direct mode' },
                { hint: 'Coding workflow with review', detail: 'Code mode' },
                { hint: 'Type / for commands', detail: '/help · /stop · /clear' },
              ].map(({ hint, detail }) => (
                <div key={hint} className="flex items-center gap-2 rounded-lg bg-zinc-900/40 px-3 py-2">
                  <span className="h-1 w-1 flex-shrink-0 rounded-full bg-zinc-700" />
                  <span className="text-xs text-zinc-500">{hint}</span>
                  <span className="ml-auto text-[10px] text-zinc-700 tabular-nums">{detail}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={renderItems.length}
            itemContent={itemContent}
            initialTopMostItemIndex={renderItems.length > 0 ? renderItems.length - 1 : 0}
            followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
            atBottomStateChange={setAtBottom}
            atBottomThreshold={50}
            overscan={400}
            className="h-full"
            style={{ height: '100%', overscrollBehavior: 'none' }}
            startReached={hasOlderMessages ? () => { void loadOlderMessages(); } : undefined}
            components={{
              Footer,
              Header: () => (
                <div className="pt-4">
                  {hasOlderMessages && (
                    <div className="flex justify-center py-2">
                      {loadingOlder ? (
                        <div className="h-4 w-4 animate-spin rounded-full border border-zinc-700 border-t-zinc-400" />
                      ) : (
                        <button
                          onClick={() => { void loadOlderMessages(); }}
                          className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
                        >
                          Load older messages
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ),
            }}
          />
        )}

        {!atBottom && messages.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/90 px-3 py-1.5 text-xs text-zinc-300 shadow-lg backdrop-blur transition-colors hover:border-zinc-600 hover:text-zinc-100"
            style={{ zIndex: Z.scrollToBottom }}
          >
            <ArrowDown size={12} />
            New messages
          </button>
        )}
      </div>

      <SessionCostBar />
      <ChatInput
        onSend={handleSend}
        modeToggle={<AgentModeToggle disabled={isStreaming} variant="inline" />}
      />
    </div>
  );
}

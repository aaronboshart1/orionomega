'use client';

import { useRef, useEffect, useState } from 'react';
import { Settings2, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useGateway } from '@/lib/gateway';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ThinkingIndicator } from './ThinkingIndicator';
import { PlanCard } from './PlanCard';
import { BackgroundTaskIndicator } from './BackgroundTaskIndicator';
import { StatusBar } from './StatusBar';
import { HindsightBanner } from './HindsightBanner';

export function ChatPane() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const thinkingContent = useChatStore((s) => s.thinkingContent);
  const activePlan = useOrchestrationStore((s) => s.activePlan);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const connectionStatus = useOrchestrationStore((s) => s.connectionStatus);
  const { sendChat, sendCommand, respondToPlan } = useGateway();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showAdvancedPlan, setShowAdvancedPlan] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinkingContent]);

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

  const connectionIcon = connectionStatus === 'connected'
    ? <Wifi size={12} className="text-green-400" />
    : connectionStatus === 'reconnecting'
      ? <RefreshCw size={12} className="animate-spin text-yellow-400" />
      : <WifiOff size={12} className="text-red-400" />;

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
        <div className="flex items-center gap-3">
          {connectionIcon}
          <BackgroundTaskIndicator />
        </div>
      </div>

      <HindsightBanner />

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-zinc-600">
            <div className="mb-3 text-4xl">&Omega;</div>
            <p className="text-sm">Send a message to begin</p>
            <p className="mt-1 text-xs text-zinc-700">
              Ask anything — I&apos;ll handle the orchestration
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

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

        {thinkingContent && <ThinkingIndicator content={thinkingContent} />}
        {isStreaming && !thinkingContent && <ThinkingIndicator />}

        <div ref={bottomRef} />
      </div>

      <StatusBar />

      <ChatInput
        onSend={handleSend}
        disabled={inputDisabled}
        pendingPlanId={activePlan?.id ?? null}
        onPlanRespond={respondToPlan}
      />
    </div>
  );
}

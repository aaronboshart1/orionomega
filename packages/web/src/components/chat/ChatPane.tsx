'use client';

import { useRef, useEffect } from 'react';
import { useChatStore } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useGateway } from '@/lib/gateway';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ThinkingIndicator } from './ThinkingIndicator';
import { PlanCard } from './PlanCard';

export function ChatPane() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const thinkingContent = useChatStore((s) => s.thinkingContent);
  const activePlan = useOrchestrationStore((s) => s.activePlan);
  const { sendChat, sendCommand, respondToPlan } = useGateway();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinkingContent]);

  const handleSend = (text: string) => {
    if (text.startsWith('/')) {
      sendCommand(text.slice(1));
    } else {
      sendChat(text);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold">
          Ω
        </div>
        <div>
          <h1 className="text-sm font-semibold text-zinc-100">OrionOmega</h1>
          <p className="text-xs text-zinc-500">AI Orchestration</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-zinc-600">
            <div className="mb-3 text-4xl">Ω</div>
            <p className="text-sm">Send a message to begin</p>
            <p className="mt-1 text-xs text-zinc-700">
              Use /commands for orchestration controls
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {activePlan && (
          <div className="my-4">
            <PlanCard plan={activePlan} onRespond={respondToPlan} />
          </div>
        )}

        {thinkingContent && <ThinkingIndicator content={thinkingContent} />}
        {isStreaming && !thinkingContent && <ThinkingIndicator />}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <ChatInput onSend={handleSend} disabled={isStreaming} />
    </div>
  );
}

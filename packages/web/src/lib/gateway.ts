'use client';

import { useEffect, useRef, useCallback } from 'react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';

// Gateway port matches core config default (7800)
export function useGateway(url: string = 'ws://127.0.0.1:7800/ws') {
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  const orchStore = useOrchestrationStore();
  const chatStore = useChatStore();

  useEffect(() => {
    const ws = new ReconnectingWebSocket(`${url}?client=web`);
    wsRef.current = ws;

    ws.onmessage = (raw) => {
      const msg = JSON.parse(raw.data as string);

      switch (msg.type) {
        case 'text':
          if (msg.streaming) chatStore.appendToLast(msg.content || '');
          if (msg.done) chatStore.setStreaming(false);
          break;
        case 'thinking':
          if (msg.streaming) chatStore.appendThinking(msg.thinking || '');
          if (msg.done) chatStore.setThinking('');
          break;
        case 'plan':
          orchStore.setActivePlan(msg.plan);
          break;
        case 'event':
          if (msg.event) orchStore.addEvent(msg.event);
          if (msg.graphState) orchStore.setGraphState(msg.graphState);
          break;
        case 'status':
          // Gateway status updates (connected, workflow active/idle, etc.)
          if (msg.graphState) orchStore.setGraphState(msg.graphState);
          break;
        case 'command_result':
          chatStore.addMessage({
            id: crypto.randomUUID(),
            role: 'system',
            content: msg.commandResult?.message || msg.message || '',
            timestamp: new Date().toISOString(),
            type: 'command-result',
          });
          break;
        case 'error':
          chatStore.addMessage({
            id: crypto.randomUUID(),
            role: 'system',
            content: `Error: ${msg.message || 'Unknown error'}`,
            timestamp: new Date().toISOString(),
            type: 'command-result',
          });
          chatStore.setStreaming(false);
          break;
        case 'ack':
          // Server acknowledged receipt — no UI action needed
          break;
        default:
          console.debug('[gateway] unhandled message type:', msg.type, msg);
      }
    };

    ws.onerror = (err) => {
      console.error('[gateway] WebSocket error', err);
    };

    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const send = useCallback((data: object) => {
    wsRef.current?.send(JSON.stringify(data));
  }, []);

  const sendChat = useCallback(
    (content: string) => {
      chatStore.addMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      });
      chatStore.setStreaming(true);
      send({ id: crypto.randomUUID(), type: 'chat', content });
    },
    [send, chatStore],
  );

  const sendCommand = useCallback(
    (command: string) => {
      send({ id: crypto.randomUUID(), type: 'command', command });
    },
    [send],
  );

  const respondToPlan = useCallback(
    (planId: string, action: string, modification?: string) => {
      send({ id: crypto.randomUUID(), type: 'plan_response', planId, action, modification });
      orchStore.setActivePlan(null);
    },
    [send, orchStore],
  );

  return { send, sendChat, sendCommand, respondToPlan };
}

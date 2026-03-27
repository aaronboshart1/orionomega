'use client';

import { useEffect, useRef, useCallback } from 'react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { useOrchestrationStore } from '@/stores/orchestration';
import type { GraphState } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';
import type { ChatMessage } from '@/stores/chat';

const SESSION_KEY = 'orionomega_session_id';

function defaultGatewayUrl(): string {
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const savedSession = localStorage.getItem(SESSION_KEY);
    const sessionParam = savedSession ? `&session=${savedSession}` : '';
    return `${proto}//${window.location.hostname}:8000/ws?client=web${sessionParam}`;
  }
  return 'ws://127.0.0.1:8000/ws?client=web';
}

function extractMetricsFromGraphState(gs: GraphState) {
  const nodeValues = Object.values(gs.nodes ?? {});
  return {
    completedLayers: gs.completedLayers ?? 0,
    totalLayers: gs.totalLayers ?? 0,
    elapsed: gs.elapsed ?? 0,
    activeWorkers: nodeValues.filter((n) => n.status === 'running').length,
    completedNodes: nodeValues.filter((n) => n.status === 'complete' || n.status === 'done').length,
    totalNodes: nodeValues.length,
  };
}

export function useGateway(url: string = defaultGatewayUrl()) {
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  const orchStore = useOrchestrationStore();
  const chatStore = useChatStore();

  useEffect(() => {
    const ws = new ReconnectingWebSocket(url);
    wsRef.current = ws;

    const getOrch = useOrchestrationStore.getState;
    const getChat = useChatStore.getState;

    let hasConnectedOnce = false;

    ws.onopen = () => {
      hasConnectedOnce = true;
      getOrch().setConnectionStatus('connected');
    };

    ws.onclose = () => {
      if (hasConnectedOnce) {
        getOrch().setConnectionStatus('reconnecting');
      } else {
        getOrch().setConnectionStatus('disconnected');
      }
    };

    ws.onmessage = (raw) => {
      const msg = JSON.parse(raw.data as string);
      const orch = getOrch();
      const chat = getChat();

      switch (msg.type) {
        case 'text':
          if (msg.streaming) {
            chat.appendToLast(msg.content || '');
          } else if (msg.content) {
            chat.addMessage({
              id: crypto.randomUUID(),
              role: 'assistant',
              content: msg.content,
              timestamp: new Date().toISOString(),
            });
            chat.setStreaming(false);
          }
          if (msg.done) chat.setStreaming(false);
          break;
        case 'thinking':
          if (msg.streaming) chat.appendThinking(msg.thinking || '');
          if (msg.done) chat.setThinking('');
          break;
        case 'plan':
          orch.setActivePlan(msg.plan);
          break;
        case 'dag_dispatched': {
          const d = msg.dagDispatch;
          if (!d) break;
          orch.upsertInlineDAG({
            dagId: d.workflowId,
            summary: d.summary,
            status: 'dispatched',
            nodes: d.nodes.map((n: { id: string; label: string; type: string }) => ({
              ...n, status: 'pending' as const,
            })),
            completedCount: 0,
            totalCount: d.nodeCount,
            elapsed: 0,
          });
          if (!orch.runStartTime) {
            orch.setRunStartTime(Date.now());
          }
          orch.updateSessionMetrics({
            totalNodes: d.nodeCount,
            completedNodes: 0,
          });
          chat.addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: d.summary || 'Working on it...',
            timestamp: new Date().toISOString(),
            type: 'dag-dispatched',
            dagId: d.workflowId,
          });
          chat.setStreaming(false);
          break;
        }
        case 'dag_progress': {
          const p = msg.dagProgress;
          if (!p) break;
          const statusMap: Record<string, 'pending' | 'running' | 'done' | 'error'> = {
            started: 'running', progress: 'running', done: 'done', error: 'error',
          };
          orch.updateDAGNode(p.workflowId, p.nodeId, {
            status: statusMap[p.status] ?? 'running',
            progress: p.progress,
          });
          break;
        }
        case 'dag_complete': {
          const c = msg.dagComplete;
          if (!c) break;
          orch.completeDAG(
            c.workflowId,
            c.output ?? c.summary,
            c.status === 'error' ? c.summary : undefined,
            {
              durationSec: c.durationSec,
              workerCount: c.workerCount,
              totalCostUsd: c.totalCostUsd,
              toolCallCount: c.toolCallCount,
              modelUsage: c.modelUsage,
              nodeOutputPaths: c.nodeOutputPaths,
              stopped: c.status === 'stopped',
            },
          );
          if (c.totalCostUsd != null) {
            orch.updateSessionMetrics({ sessionCostUsd: c.totalCostUsd });
          }
          const freshOrch = getOrch();
          const hasActive = Object.values(freshOrch.inlineDAGs).some(
            (d) => d.dagId !== c.workflowId && (d.status === 'dispatched' || d.status === 'running'),
          );
          if (!hasActive) {
            freshOrch.setRunStartTime(null);
            freshOrch.updateSessionMetrics({ activeWorkers: 0 });
          }
          chat.addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: c.status === 'error'
              ? `Something went wrong: ${c.summary}`
              : c.output || c.summary || 'Done.',
            timestamp: new Date().toISOString(),
            type: 'dag-complete',
            dagId: c.workflowId,
          });
          break;
        }
        case 'dag_confirm': {
          const cf = msg.dagConfirm;
          if (!cf) break;
          orch.setPendingConfirmation({
            dagId: cf.workflowId,
            summary: cf.summary,
            reason: cf.reasoning,
            guardedNodes: cf.guardedActions.map((a: string, i: number) => ({
              id: `guard-${i}`, label: a, risk: 'high',
            })),
          });
          chat.addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: cf.summary,
            timestamp: new Date().toISOString(),
            type: 'dag-confirmation',
            dagId: cf.workflowId,
          });
          break;
        }
        case 'event':
          if (msg.event) orch.addEvent(msg.event);
          if (msg.graphState) {
            const gs = msg.graphState as GraphState;
            orch.setGraphState(gs);
            orch.updateSessionMetrics(extractMetricsFromGraphState(gs));
          }
          break;
        case 'status':
          if (msg.graphState) {
            const gs = msg.graphState as GraphState;
            orch.setGraphState(gs);
            orch.updateSessionMetrics(extractMetricsFromGraphState(gs));
          }
          break;
        case 'session_status':
          if (msg.sessionStatus) {
            orch.updateSessionMetrics({
              model: msg.sessionStatus.model,
              sessionCostUsd: msg.sessionStatus.sessionCostUsd ?? 0,
            });
          }
          break;
        case 'hindsight_status':
          if (msg.hindsightStatus) {
            orch.setHindsight({
              connected: msg.hindsightStatus.connected,
              busy: msg.hindsightStatus.busy,
            });
          }
          break;
        case 'command_result':
          chat.addMessage({
            id: crypto.randomUUID(),
            role: 'system',
            content: msg.commandResult?.message || msg.message || '',
            timestamp: new Date().toISOString(),
            type: 'command-result',
          });
          break;
        case 'error':
          chat.addMessage({
            id: crypto.randomUUID(),
            role: 'system',
            content: `Error: ${msg.message || 'Unknown error'}`,
            timestamp: new Date().toISOString(),
            type: 'command-result',
          });
          chat.setStreaming(false);
          break;
        case 'ack':
          try {
            const ackData = msg.content ? JSON.parse(msg.content) : null;
            if (ackData?.sessionId) {
              localStorage.setItem(SESSION_KEY, ackData.sessionId);
            }
          } catch { /* ignore parse errors */ }
          break;
        case 'history': {
          if (msg.history && Array.isArray(msg.history)) {
            const currentMessages = getChat().messages;
            if (currentMessages.length > 0) break;
            const restored: ChatMessage[] = msg.history
              .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
              .map((m: { id: string; role: string; content: string; timestamp: string; type?: string }) => ({
                id: m.id,
                role: m.role as 'user' | 'assistant',
                content: m.content,
                timestamp: m.timestamp,
                type: m.type as ChatMessage['type'],
              }));
            if (restored.length > 0) {
              getChat().setMessages(restored);
            }
          }
          break;
        }
        default:
          console.debug('[gateway] unhandled message type:', msg.type, msg);
      }
    };

    ws.onerror = (err) => {
      console.error('[gateway] WebSocket error', err);
      getOrch().setConnectionStatus('reconnecting');
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

  const respondToDAG = useCallback(
    (workflowId: string, action: 'approve' | 'reject') => {
      send({ id: crypto.randomUUID(), type: 'dag_response', workflowId, dagAction: action });
      orchStore.setPendingConfirmation(null);
    },
    [send, orchStore],
  );

  const respondToConfirmation = useCallback(
    (dagId: string, approved: boolean) => {
      respondToDAG(dagId, approved ? 'approve' : 'reject');
    },
    [respondToDAG],
  );

  return { send, sendChat, sendCommand, respondToPlan, respondToDAG, respondToConfirmation };
}

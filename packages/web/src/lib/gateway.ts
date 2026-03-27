'use client';

import { useEffect, useCallback } from 'react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';
import type { ChatMessage } from '@/stores/chat';

const SESSION_KEY = 'orionomega_session_id';

function getGatewayUrl(): string {
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const savedSession = localStorage.getItem(SESSION_KEY);
    const sessionParam = savedSession ? `&session=${savedSession}` : '';
    return `${proto}//${window.location.host}/api/gateway/ws?client=web${sessionParam}`;
  }
  return 'ws://127.0.0.1:8000/ws?client=web';
}

function statusFromToolCall(toolName?: string): string {
  if (!toolName) return 'Thinking…';
  const lower = toolName.toLowerCase();
  if (lower.includes('search') || lower.includes('web')) return 'Searching web…';
  if (lower.includes('read') || lower.includes('file')) return 'Reading file…';
  if (lower.includes('code') || lower.includes('exec') || lower.includes('run')) return 'Running code…';
  if (lower.includes('write') || lower.includes('edit')) return 'Writing…';
  if (lower.includes('shell') || lower.includes('bash') || lower.includes('terminal')) return 'Running command…';
  if (lower.includes('image') || lower.includes('generate')) return 'Generating…';
  if (lower.includes('database') || lower.includes('sql') || lower.includes('query')) return 'Querying database…';
  return `Running ${toolName}…`;
}

let singletonWs: ReconnectingWebSocket | null = null;
let boundWs: ReconnectingWebSocket | null = null;

function getOrCreateWs(): ReconnectingWebSocket {
  if (!singletonWs || singletonWs.readyState === WebSocket.CLOSED) {
    boundWs = null;
    singletonWs = new ReconnectingWebSocket(getGatewayUrl, undefined, {
      maxRetries: Infinity,
    });
  }
  return singletonWs;
}

function bindListeners(ws: ReconnectingWebSocket): void {
  if (boundWs === ws) return;
  boundWs = ws;

  const chatStore = useChatStore.getState;
  const orchStore = useOrchestrationStore.getState;

  ws.onmessage = (raw) => {
    const msg = JSON.parse(raw.data as string);
    const chat = chatStore();
    const orch = orchStore();

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
      case 'tool_call':
        chat.setStreamingStatus(statusFromToolCall(msg.toolName || msg.name));
        break;
      case 'tool_result':
        chat.setStreamingStatus('Thinking…');
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

        if (p.tool && p.tool.name) {
          const currentDAGs = useOrchestrationStore.getState().inlineDAGs;
          const dag = currentDAGs[p.workflowId];
          const node = dag?.nodes.find((n: { id: string }) => n.id === p.nodeId);
          const toolStatus: 'running' | 'done' | 'error' =
            p.status === 'done' ? 'done' : p.status === 'error' ? 'error' : 'running';

          const currentMessages = useChatStore.getState().messages;
          const existingMsg = currentMessages.find(
            (m) =>
              m.type === 'tool-call' &&
              m.toolCall &&
              m.toolCall.status === 'running' &&
              m.toolCall.nodeId === p.nodeId &&
              m.toolCall.toolName === p.tool.name &&
              m.toolCall.file === p.tool.file &&
              m.dagId === p.workflowId,
          );

          if (existingMsg) {
            if (toolStatus === 'done' || toolStatus === 'error') {
              chat.updateToolCallStatus(existingMsg.id, toolStatus);
            }
          } else {
            chat.addMessage({
              id: crypto.randomUUID(),
              role: 'assistant',
              content: p.tool.summary || `${p.tool.name}${p.tool.file ? `: ${p.tool.file}` : ''}`,
              timestamp: new Date().toISOString(),
              type: 'tool-call',
              dagId: p.workflowId,
              toolCall: {
                toolName: p.tool.name,
                action: p.tool.action,
                file: p.tool.file,
                summary: p.tool.summary || '',
                status: toolStatus,
                workerId: p.workerId,
                nodeId: p.nodeId,
                nodeLabel: node?.label || p.nodeId,
              },
            });
          }
        }
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
      case 'event': {
        if (msg.event) orch.addEvent(msg.event);
        const evt = msg.event as { type?: string; tool?: { name?: string }; error?: string; message?: string } | undefined;
        if (evt) {
          if (evt.type === 'tool_call' && evt.tool?.name) {
            chat.setStreamingStatus(statusFromToolCall(evt.tool.name));
          } else if (evt.type === 'tool_result') {
            chat.setStreamingStatus('Thinking…');
          } else if (evt.type === 'error') {
            chat.markLastInterrupted();
            chat.addMessage({
              id: crypto.randomUUID(),
              role: 'system',
              content: evt.error || evt.message || 'Worker error',
              timestamp: new Date().toISOString(),
              type: 'error',
            });
          } else if (evt.type === 'status' && evt.message) {
            chat.setStreamingStatus(evt.message);
          }
        }
        if (msg.graphState) orch.setGraphState(msg.graphState);
        break;
      }
      case 'status':
        if (msg.graphState) orch.setGraphState(msg.graphState);
        if (msg.status) chat.setStreamingStatus(msg.status);
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
        chat.markLastInterrupted();
        chat.addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: msg.error || msg.message || 'Unknown error',
          timestamp: new Date().toISOString(),
          type: 'error',
        });
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
            const current = useChatStore.getState().messages;
            if (current.length === 0) {
              chat.setMessages(restored);
            }
          }
        }
        break;
      }
      default:
        console.debug('[gateway] unhandled message type:', msg.type, msg);
    }
  };

  ws.onerror = () => {
    // Don't mark as interrupted on connection errors — ReconnectingWebSocket handles reconnection
  };
}

export function useGateway() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ws = getOrCreateWs();
    bindListeners(ws);
  }, []);

  const send = useCallback((data: object) => {
    const ws = getOrCreateWs();
    bindListeners(ws);
    ws.send(JSON.stringify(data));
  }, []);

  const sendChat = useCallback(
    (content: string) => {
      const chat = useChatStore.getState();
      chat.addMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      });
      chat.setStreaming(true);
      chat.setStreamingStatus('Thinking…');
      send({ id: crypto.randomUUID(), type: 'chat', content });
    },
    [send],
  );

  const sendCommand = useCallback(
    (command: string) => {
      if (command === 'stop') {
        useChatStore.getState().markLastInterrupted();
      }
      send({ id: crypto.randomUUID(), type: 'command', command });
    },
    [send],
  );

  const respondToPlan = useCallback(
    (planId: string, action: string, modification?: string) => {
      send({ id: crypto.randomUUID(), type: 'plan_response', planId, action, modification });
      useOrchestrationStore.getState().setActivePlan(null);
    },
    [send],
  );

  const respondToDAG = useCallback(
    (workflowId: string, action: 'approve' | 'reject') => {
      send({ id: crypto.randomUUID(), type: 'dag_response', workflowId, dagAction: action });
      useOrchestrationStore.getState().setPendingConfirmation(null);
    },
    [send],
  );

  const respondToConfirmation = useCallback(
    (dagId: string, approved: boolean) => {
      respondToDAG(dagId, approved ? 'approve' : 'reject');
    },
    [respondToDAG],
  );

  return { send, sendChat, sendCommand, respondToPlan, respondToDAG, respondToConfirmation };
}

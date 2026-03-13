'use client';
import { useEffect, useRef, useCallback } from 'react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';
// Gateway port matches core config default (7800)
// Auto-detect gateway URL from current browser location
function defaultGatewayUrl() {
    if (typeof window !== 'undefined') {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.hostname}:7800/ws`;
    }
    return 'ws://127.0.0.1:7800/ws';
}
export function useGateway(url = defaultGatewayUrl()) {
    const wsRef = useRef(null);
    const orchStore = useOrchestrationStore();
    const chatStore = useChatStore();
    useEffect(() => {
        const ws = new ReconnectingWebSocket(`${url}?client=web`);
        wsRef.current = ws;
        ws.onmessage = (raw) => {
            const msg = JSON.parse(raw.data);
            switch (msg.type) {
                case 'text':
                    if (msg.streaming)
                        chatStore.appendToLast(msg.content || '');
                    if (msg.done)
                        chatStore.setStreaming(false);
                    break;
                case 'thinking':
                    if (msg.streaming)
                        chatStore.appendThinking(msg.thinking || '');
                    if (msg.done)
                        chatStore.setThinking('');
                    break;
                case 'plan':
                    orchStore.setActivePlan(msg.plan);
                    break;
                case 'dag_dispatched': {
                    const d = msg.dagDispatch;
                    if (!d)
                        break;
                    orchStore.upsertInlineDAG({
                        dagId: d.workflowId,
                        summary: d.summary,
                        status: 'dispatched',
                        nodes: d.nodes.map((n) => ({
                            ...n, status: 'pending',
                        })),
                        completedCount: 0,
                        totalCount: d.nodeCount,
                        elapsed: 0,
                    });
                    chatStore.addMessage({
                        id: crypto.randomUUID(),
                        role: 'assistant',
                        content: d.summary || 'Working on it...',
                        timestamp: new Date().toISOString(),
                        type: 'dag-dispatched',
                        dagId: d.workflowId,
                    });
                    chatStore.setStreaming(false);
                    break;
                }
                case 'dag_progress': {
                    const p = msg.dagProgress;
                    if (!p)
                        break;
                    const statusMap = {
                        started: 'running', progress: 'running', done: 'done', error: 'error',
                    };
                    orchStore.updateDAGNode(p.workflowId, p.nodeId, {
                        status: statusMap[p.status] ?? 'running',
                        progress: p.progress,
                    });
                    break;
                }
                case 'dag_complete': {
                    const c = msg.dagComplete;
                    if (!c)
                        break;
                    orchStore.completeDAG(c.workflowId, c.output ?? c.summary, c.status === 'error' ? c.summary : undefined);
                    chatStore.addMessage({
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
                    if (!cf)
                        break;
                    orchStore.setPendingConfirmation({
                        dagId: cf.workflowId,
                        summary: cf.summary,
                        reason: cf.reasoning,
                        guardedNodes: cf.guardedActions.map((a, i) => ({
                            id: `guard-${i}`, label: a, risk: 'high',
                        })),
                    });
                    chatStore.addMessage({
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
                    if (msg.event)
                        orchStore.addEvent(msg.event);
                    if (msg.graphState)
                        orchStore.setGraphState(msg.graphState);
                    break;
                case 'status':
                    if (msg.graphState)
                        orchStore.setGraphState(msg.graphState);
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
    const send = useCallback((data) => {
        wsRef.current?.send(JSON.stringify(data));
    }, []);
    const sendChat = useCallback((content) => {
        chatStore.addMessage({
            id: crypto.randomUUID(),
            role: 'user',
            content,
            timestamp: new Date().toISOString(),
        });
        chatStore.setStreaming(true);
        send({ id: crypto.randomUUID(), type: 'chat', content });
    }, [send, chatStore]);
    const sendCommand = useCallback((command) => {
        send({ id: crypto.randomUUID(), type: 'command', command });
    }, [send]);
    const respondToPlan = useCallback((planId, action, modification) => {
        send({ id: crypto.randomUUID(), type: 'plan_response', planId, action, modification });
        orchStore.setActivePlan(null);
    }, [send, orchStore]);
    const respondToDAG = useCallback((workflowId, action) => {
        send({ id: crypto.randomUUID(), type: 'dag_response', workflowId, dagAction: action });
        orchStore.setPendingConfirmation(null);
    }, [send, orchStore]);
    const respondToConfirmation = useCallback((dagId, approved) => {
        respondToDAG(dagId, approved ? 'approve' : 'reject');
    }, [respondToDAG]);
    return { send, sendChat, sendCommand, respondToPlan, respondToDAG, respondToConfirmation };
}
//# sourceMappingURL=gateway.js.map
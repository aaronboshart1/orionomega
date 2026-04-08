'use client';

import { useEffect, useCallback } from 'react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';
import { useConnectionStore } from '@/stores/connection';
import { useAgentModeStore } from '@/stores/agent-mode';
import { useCodingModeStore } from '@/stores/coding-mode';
import type { ChatMessage } from '@/stores/chat';
import type { FileAttachment } from '@/components/chat/ChatInput';
import { uuid } from '@/lib/uuid';

const SESSION_KEY = 'orionomega_session_id';
let statusFetchController: AbortController | null = null;

function getGatewayUrl(): string {
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let savedSession: string | null = null;
    try { savedSession = localStorage.getItem(SESSION_KEY); } catch { /* ignore */ }
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
let pendingRestart = false;
let wsReady = false;
const QUEUE_MAX_AGE_MS = 30_000;
const QUEUE_MAX_SIZE = 50;
interface QueuedMessage { data: string; queuedAt: number; }
const pendingMessages: QueuedMessage[] = [];
let healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckId: string | null = null;
let clientStateInterval: ReturnType<typeof setInterval> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fileReadCallbacks = new Map<string, (msg: any) => void>();

export function requestFileRead(path: string): Promise<{ path: string; content?: string; error?: string }> {
  return new Promise((resolve) => {
    const ws = getOrCreateWs();
    const id = uuid();
    const timeout = setTimeout(() => {
      fileReadCallbacks.delete(id);
      resolve({ path, error: 'Request timed out' });
    }, 15000);
    fileReadCallbacks.set(id, (msg) => {
      clearTimeout(timeout);
      if (msg.error) {
        resolve({ path: msg.path ?? path, error: msg.error });
      } else {
        resolve({ path: msg.path ?? path, content: msg.content ?? '' });
      }
    });
    try {
      ws.send(JSON.stringify({ id, type: 'file_read', path }));
    } catch {
      clearTimeout(timeout);
      fileReadCallbacks.delete(id);
      resolve({ path, error: 'WebSocket send failed' });
    }
  });
}

function pruneExpiredMessages(): void {
  const now = Date.now();
  while (pendingMessages.length > 0 && now - pendingMessages[0].queuedAt > QUEUE_MAX_AGE_MS) {
    pendingMessages.shift();
  }
}

let lastDeliveryFailureAt = 0;
function surfaceDeliveryFailure(): void {
  const now = Date.now();
  if (now - lastDeliveryFailureAt < 5000) return;
  lastDeliveryFailureAt = now;
  const chat = useChatStore.getState();
  chat.addMessage({
    id: uuid(),
    role: 'system',
    content: 'Message could not be delivered — the connection was lost. Please try again.',
    timestamp: new Date().toISOString(),
    type: 'error',
  });
}

function flushPendingMessages(ws: ReconnectingWebSocket): void {
  const countBefore = pendingMessages.length;
  pruneExpiredMessages();
  const expired = countBefore - pendingMessages.length;
  if (expired > 0) {
    console.warn(`[gateway] Dropped ${expired} expired queued message(s)`);
    surfaceDeliveryFailure();
  }
  const toFlush = pendingMessages.splice(0);
  for (let i = 0; i < toFlush.length; i++) {
    const entry = toFlush[i];
    if (ws.readyState !== WebSocket.OPEN) {
      pendingMessages.unshift(...toFlush.slice(i));
      console.warn('[gateway] Flush aborted — socket no longer open, requeued remaining');
      return;
    }
    try {
      ws.send(entry.data);
    } catch (err) {
      pendingMessages.unshift(...toFlush.slice(i));
      console.warn('[gateway] Flush send failed, requeued', err);
      return;
    }
  }
}

function safeSend(ws: ReconnectingWebSocket, data: string): boolean {
  if (ws.readyState === WebSocket.OPEN && wsReady) {
    try {
      ws.send(data);
      return true;
    } catch (err) {
      console.warn('[gateway] ws.send() threw', err);
    }
  }
  pruneExpiredMessages();
  if (pendingMessages.length >= QUEUE_MAX_SIZE) {
    console.warn('[gateway] Message queue full, dropping oldest');
    pendingMessages.shift();
    surfaceDeliveryFailure();
  }
  pendingMessages.push({ data, queuedAt: Date.now() });
  if (!wsReady) {
    console.debug('[gateway] Message queued — connection not ready yet');
  }
  return false;
}

interface HistoryMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  type?: string;
  dagId?: string;
  metadata?: {
    workflowId?: string;
    background?: boolean;
    dagDispatch?: {
      workflowId: string;
      summary: string;
      nodeCount: number;
      nodes: { id: string; label: string; type: string }[];
    };
    dagComplete?: {
      workflowId: string;
      status: string;
      summary?: string;
      output?: string;
      durationSec?: number;
      workerCount?: number;
      totalCostUsd?: number;
      toolCallCount?: number;
      modelUsage?: Array<{
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        workerCount: number;
        costUsd: number;
      }>;
      nodeOutputPaths?: Record<string, string[]>;
    };
    dagConfirm?: {
      workflowId: string;
      summary: string;
      reasoning: string;
      guardedActions: string[];
    };
  };
}

function waitForHydration(): Promise<void> {
  // Both stores are non-persisted (no localStorage), so they are always hydrated.
  return Promise.resolve();
}

function processHistoryWhenHydrated(history: HistoryMessage[]): void {
  waitForHydration().then(() => {
    const serverMessages: ChatMessage[] = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        const wfId = m.metadata?.workflowId
          || m.metadata?.dagDispatch?.workflowId
          || m.metadata?.dagComplete?.workflowId
          || m.metadata?.dagConfirm?.workflowId;
        return {
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          timestamp: m.timestamp,
          type: m.type as ChatMessage['type'],
          dagId: m.dagId || wfId,
          workflowId: m.metadata?.workflowId,
          isBackground: m.metadata?.background,
        };
      });

    if (serverMessages.length > 0) {
      const local = useChatStore.getState().messages;
      if (local.length === 0) {
        useChatStore.getState().setMessages(serverMessages);
      } else {
        const localIds = new Set(local.map((m) => m.id));
        const dagTypes = new Set(['dag-dispatched', 'dag-complete', 'dag-confirmation']);
        const localDagKeys = new Set(
          local
            .filter((m) => m.type && dagTypes.has(m.type) && m.dagId)
            .map((m) => `${m.type}:${m.dagId}`),
        );
        const contentDedupTypes = new Set([undefined, 'text']);
        const localContentKeys = new Set(
          local
            .filter((m) => contentDedupTypes.has(m.type))
            .flatMap((m) => {
              const ts = Math.floor(new Date(m.timestamp).getTime() / 3000);
              // Include workflow context so identical-content messages from
              // different workflows produce distinct dedup keys.
              const ctx = m.dagId || m.workflowId || '';
              return [
                `${m.role}:${ctx}:${m.content}:${ts}`,
                `${m.role}:${ctx}:${m.content}:${ts - 1}`,
                `${m.role}:${ctx}:${m.content}:${ts + 1}`,
              ];
            }),
        );
        const missing = serverMessages.filter((m) => {
          if (localIds.has(m.id)) return false;
          if (m.type && dagTypes.has(m.type) && m.dagId && localDagKeys.has(`${m.type}:${m.dagId}`)) return false;
          if (contentDedupTypes.has(m.type)) {
            const ts = Math.floor(new Date(m.timestamp).getTime() / 3000);
            const ctx = m.dagId || m.workflowId || '';
            const contentKey = `${m.role}:${ctx}:${m.content}:${ts}`;
            if (localContentKeys.has(contentKey)) return false;
          }
          return true;
        });
        if (missing.length > 0) {
          const merged = [...local];
          for (const m of missing) {
            const insertIdx = merged.findIndex((lm) => lm.timestamp > m.timestamp);
            if (insertIdx === -1) {
              merged.push(m);
            } else {
              merged.splice(insertIdx, 0, m);
            }
          }
          useChatStore.getState().setMessages(merged);
        }
      }
    }

    // Collect workflow IDs that have a dag-complete in history. Only these
    // should be recreated from messages — active runs are already in the store
    // from the server snapshot, and orphan dag-dispatched entries (ghost runs)
    // must not be resurrected.
    const completedWorkflowIds = new Set(
      history
        .filter((m) => m.type === 'dag-complete' && m.metadata?.dagComplete)
        .map((m) => m.metadata!.dagComplete!.workflowId as string),
    );

    const orch = useOrchestrationStore.getState();
    for (const m of history) {
      if (m.type === 'dag-dispatched' && m.metadata?.dagDispatch) {
        const d = m.metadata.dagDispatch;
        if (!orch.inlineDAGs[d.workflowId] && completedWorkflowIds.has(d.workflowId)) {
          orch.upsertInlineDAG({
            dagId: d.workflowId,
            summary: d.summary,
            status: 'dispatched',
            nodes: d.nodes.map((n) => ({
              ...n, status: 'pending' as const,
            })),
            completedCount: 0,
            totalCount: d.nodeCount,
            elapsed: 0,
          });
        }
      } else if (m.type === 'dag-complete' && m.metadata?.dagComplete) {
        const c = m.metadata.dagComplete;
        const existingDag = useOrchestrationStore.getState().inlineDAGs[c.workflowId];
        if (existingDag && (existingDag.status === 'complete' || existingDag.status === 'error' || existingDag.status === 'stopped')) {
          // eslint-disable-next-line no-continue
          continue;
        }
        if (!existingDag) {
          useOrchestrationStore.getState().upsertInlineDAG({
            dagId: c.workflowId,
            summary: c.summary || c.output || '',
            status: 'dispatched',
            nodes: [],
            completedCount: 0,
            totalCount: 0,
            elapsed: 0,
          });
        }
        useOrchestrationStore.getState().completeDAG(
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
      }
    }
  });
}

/** Track reconnect attempts for exponential backoff status reporting. */
let reconnectAttemptCount = 0;
/** Whether we've received a session snapshot (init protocol completed). */
let initAcked = false;

/**
 * Rehydrate all client stores from a full server-side state snapshot.
 *
 * This is the core of the reconnection protocol — the client becomes a pure
 * view layer driven entirely by the server's authoritative state.
 *
 * Error boundary: each rehydration step is wrapped in try-catch so that a
 * failure in one section (e.g. corrupt DAG data) doesn't prevent other
 * sections from rehydrating. Errors are logged but the UI remains functional.
 *
 * The snapshot may include pagination hints (snapshot.pagination) when the
 * server has truncated the message history. The client can use the REST API
 * (GET /api/sessions/:id/activity) to lazy-load older messages.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rehydrateFromSnapshot(snapshot: any, bufferedEvents?: unknown[]): void {
  waitForHydration().then(() => {
    const rehydrateStart = performance.now();
    let sectionsOk = 0;
    let sectionsFailed = 0;

    const chat = useChatStore.getState();
    const orch = useOrchestrationStore.getState();

    // ── 1. Rehydrate chat messages ──────────────────────────────────────
    try {
      if (snapshot.messages && Array.isArray(snapshot.messages)) {
        processHistoryWhenHydrated(snapshot.messages);
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate chat messages', err);
    }

    // ── 2. Rehydrate memory events ──────────────────────────────────────
    try {
      if (snapshot.memoryEvents && Array.isArray(snapshot.memoryEvents)) {
        const existingIds = new Set(orch.memoryEvents.map((e: { id: string }) => e.id));
        const newEvents = snapshot.memoryEvents.filter((e: { id: string }) => !existingIds.has(e.id));
        for (const e of newEvents) {
          orch.addMemoryEvent(e);
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate memory events', err);
    }

    // ── 3. Rehydrate inline DAGs ────────────────────────────────────────
    try {
      if (snapshot.inlineDAGs && typeof snapshot.inlineDAGs === 'object') {
        for (const [dagId, dagData] of Object.entries(snapshot.inlineDAGs)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dag = dagData as any;
          const existing = orch.inlineDAGs[dagId];
          // Only overwrite if server has newer/more complete data
          if (!existing || (existing.status !== 'complete' && existing.status !== 'error' && existing.status !== 'stopped')) {
            orch.upsertInlineDAG({
              dagId: dag.dagId,
              summary: dag.summary,
              status: dag.status,
              nodes: dag.nodes || [],
              completedCount: dag.completedCount ?? 0,
              totalCount: dag.totalCount ?? 0,
              elapsed: dag.elapsed ?? 0,
            });
            // If the server says it's complete, apply completion stats
            if (dag.status === 'complete' || dag.status === 'error' || dag.status === 'stopped') {
              orch.completeDAG(dagId, dag.result, dag.error, {
                durationSec: dag.durationSec,
                workerCount: dag.workerCount,
                totalCostUsd: dag.totalCostUsd,
                toolCallCount: dag.toolCallCount,
                modelUsage: dag.modelUsage,
                nodeOutputPaths: dag.nodeOutputPaths,
                stopped: dag.status === 'stopped',
              });
            }
          }
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate inline DAGs', err);
    }

    // ── 3b. Replay orchestration events into workflow activity feeds ────
    // These may be partial after a crash (bounded by server-side throttle interval).
    // Events are appended to the workflow's activity feed so the ActivityFeed component
    // renders them. Missing events degrade gracefully — the summary stats (from InlineDAGs)
    // are always available even if the activity stream is incomplete.
    try {
      if (snapshot.orchestrationEvents && Array.isArray(snapshot.orchestrationEvents)) {
        let replayedCount = 0;
        for (const entry of snapshot.orchestrationEvents) {
          // Defensive: skip malformed entries
          if (!entry || typeof entry !== 'object' || !entry.event) continue;
          const evt = entry.event;
          // Validate minimum event shape (must have at least a type)
          if (typeof evt !== 'object' || !evt.type) continue;
          orch.addEvent(evt, entry.workflowId);
          replayedCount++;
        }
        if (replayedCount > 0) {
          console.warn(`[gateway] Rehydrated ${replayedCount} orchestration events`);
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate orchestration events', err);
    }

    // ── 3c. Reconstruct graphState from InlineDAG node data for past runs ──
    // For completed (or crashed) workflows the live graphState is gone, but InlineDAG
    // nodes carry enough info to reconstruct the graph visualization. For legacy data
    // that lacks dependsOn, we fall back to an empty array (renders nodes without edges).
    try {
      const currentOrch = useOrchestrationStore.getState();
      if (snapshot.inlineDAGs && typeof snapshot.inlineDAGs === 'object') {
        for (const [dagId, dagData] of Object.entries(snapshot.inlineDAGs)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dag = dagData as any;
          const nodes = dag.nodes || [];
          // Only synthesize graphState for workflows that have real nodes but no live graphState
          // (direct-mode runs have 0 nodes and don't need a graph)
          if (nodes.length === 0) continue;
          const wf = currentOrch.workflows[dagId];
          if (wf?.graphState) continue; // live graphState takes precedence
          const graphNodes: Record<string, any> = {};
          for (const n of nodes) {
            if (!n || !n.id) continue; // skip malformed nodes
            graphNodes[n.id] = {
              id: n.id,
              type: n.type || 'agent',
              label: n.label || n.id,
              status: n.status || 'pending',
              dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn : [],
            };
          }
          orch.setGraphState({
            workflowId: dagId,
            name: dag.summary || 'Workflow',
            status: dag.status === 'complete' ? 'complete' : dag.status === 'error' ? 'error' : (dag.status || 'complete'),
            elapsed: dag.durationSec ?? dag.elapsed ?? 0,
            nodes: graphNodes,
            recentEvents: [],
            completedLayers: dag.completedCount ?? nodes.length,
            totalLayers: dag.totalCount ?? nodes.length,
          });
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to reconstruct graphState for past runs', err);
    }

    // ── 3d. Switch to workflow tab and select the most recent workflow ────
    // Mirrors the old hydrateFromSnapshot behaviour: show the workflow view
    // by default when there is at least one run to display. Selects the most
    // recently updated workflow (by InlineDAG elapsed/durationSec) as active.
    try {
      const orchForTab = useOrchestrationStore.getState();
      const workflowIds = Object.keys(orchForTab.workflows);
      if (workflowIds.length > 0) {
        orchForTab.setActiveOrchTab('workflow');
        // Pick the most recently active workflow — prefer running over completed,
        // and among completed prefer the one with the longest duration (likely most recent)
        const dagEntries = Object.entries(snapshot.inlineDAGs ?? {});
        if (dagEntries.length > 0) {
          // Sort: running first, then by most recent (reverse insertion order as proxy)
          const running = dagEntries.find(([, d]: [string, any]) => d.status === 'running' || d.status === 'dispatched');
          const bestId = running ? running[0] : dagEntries[dagEntries.length - 1][0];
          if (orchForTab.workflows[bestId]) {
            orchForTab.setActiveWorkflowId(bestId);
          }
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to switch to workflow tab', err);
    }

    // ── 4. Rehydrate session totals ─────────────────────────────────────
    try {
      if (snapshot.sessionTotals) {
        const totals = snapshot.sessionTotals;
        // Server totals are authoritative — replace client-side totals
        chat.setMessages(chat.messages); // no-op to trigger re-render
        // We need to set the session totals directly via the store
        useChatStore.setState({
          sessionTotals: {
            inputTokens: totals.inputTokens ?? 0,
            outputTokens: totals.outputTokens ?? 0,
            cacheReadTokens: totals.cacheReadTokens ?? 0,
            totalCostUsd: totals.totalCostUsd ?? 0,
            messageCount: totals.messageCount ?? 0,
          },
        });
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate session totals', err);
    }

    // ── 5. Rehydrate active plan ────────────────────────────────────────
    try {
      if (snapshot.activePlan !== undefined) {
        orch.setActivePlan(snapshot.activePlan);
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate active plan', err);
    }

    // ── 6. Rehydrate pending confirmation ───────────────────────────────
    try {
      if (snapshot.pendingConfirmation !== undefined) {
        if (snapshot.pendingConfirmation) {
          const cf = snapshot.pendingConfirmation;
          orch.setPendingConfirmation({
            dagId: cf.workflowId,
            summary: cf.summary,
            reason: cf.reasoning,
            guardedNodes: (cf.guardedActions ?? []).map((a: string, i: number) => ({
              id: `guard-${i}`, label: a, risk: 'high',
            })),
          });
        } else {
          orch.setPendingConfirmation(null);
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate pending confirmation', err);
    }

    // ── 7. Rehydrate agent mode ─────────────────────────────────────────
    try {
      if (snapshot.agentMode) {
        const validModes = new Set(['orchestrate', 'direct', 'code']);
        if (validModes.has(snapshot.agentMode)) {
          useAgentModeStore.getState().setMode(snapshot.agentMode);
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate agent mode', err);
    }

    // ── 8. Rehydrate coding session ─────────────────────────────────────
    try {
      if (snapshot.codingSession) {
        const cs = snapshot.codingSession;
        useCodingModeStore.getState().setSession({
          sessionId: cs.sessionId ?? '',
          taskDescription: cs.taskDescription ?? '',
          repoUrl: cs.repoUrl ?? '',
          branch: cs.branch ?? '',
          status: cs.status ?? 'running',
          steps: cs.steps ?? [],
          reviews: cs.reviews ?? [],
          currentIteration: cs.currentIteration ?? 0,
        });
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate coding session', err);
    }

    // ── 9. Rehydrate hindsight status ───────────────────────────────────
    try {
      if (snapshot.hindsightStatus) {
        useConnectionStore.getState().setHindsightStatus(
          !!snapshot.hindsightStatus.connected,
          !!snapshot.hindsightStatus.busy,
        );
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate hindsight status', err);
    }

    // ── 10. Restore persisted client state ─────────────────────────────
    try {
      if (snapshot.clientState) {
        const cs = snapshot.clientState;
        // Restore agent mode from persisted client state (overrides section 7 only
        // if present here — section 7 handles snapshot.agentMode from server runs)
        if (cs.agentMode) {
          const validModes = new Set(['orchestrate', 'direct', 'code']);
          if (validModes.has(cs.agentMode)) {
            useAgentModeStore.getState().setMode(cs.agentMode);
          }
        }
        // Restore orch pane state if present
        if (typeof cs.orchPaneOpen === 'boolean') {
          useOrchestrationStore.getState().setOrchPaneOpen(cs.orchPaneOpen);
        }
        if (cs.activePanel) {
          const validTabs = new Set(['memory', 'workflow', 'files']);
          if (validTabs.has(cs.activePanel)) {
            useOrchestrationStore.getState().setActiveOrchTab(cs.activePanel);
          }
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to restore client state', err);
    }

    // ── 11. Replay buffered events (events that happened while disconnected) ──
    if (bufferedEvents && Array.isArray(bufferedEvents)) {
      for (const rawEvt of bufferedEvents) {
        // Each buffered event is a ServerMessage — replay it through the normal handler
        try {
          const synthetic = new MessageEvent('message', {
            data: JSON.stringify(rawEvt),
          });
          if (singletonWs?.onmessage) {
            singletonWs.onmessage(synthetic);
          }
        } catch (err) {
          console.warn('[gateway] Failed to replay buffered event', err);
        }
      }
    }

    const rehydrateMs = Math.round(performance.now() - rehydrateStart);
    const _pagination = snapshot.pagination;
    // Propagate server pagination hint so the chat pane can offer "load older" UI
    useConnectionStore.getState().setHasOlderMessages(_pagination?.hasOlderMessages ?? false);
    // Use console.warn (allowed by lint) instead of console.info for rehydration diagnostics
    if (sectionsFailed > 0 || rehydrateMs > 500) {
      console.warn('[gateway] State rehydrated from server snapshot', {
        messages: snapshot.messages?.length ?? 0,
        dags: Object.keys(snapshot.inlineDAGs ?? {}).length,
        sectionsOk,
        sectionsFailed,
        rehydrateMs,
        hasOlderMessages: _pagination?.hasOlderMessages ?? false,
      });
    }

    // If rehydration had failures, show a non-blocking warning to the user
    if (sectionsFailed > 0) {
      console.warn(`[gateway] Rehydration completed with ${sectionsFailed} error(s) — some UI state may be incomplete`);
    }
  });
}

/**
 * Dispatch a single persisted event (from REST gap-recovery) to the
 * appropriate Zustand store.  Events use the same shape the server stores
 * in the events table: { seq, event_type, data }.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyEvent(event: any): void {
  if (!event) return;
  const eventType: string = event.event_type || event.type || '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = event.data ?? event;

  switch (eventType) {
    case 'message':
    case 'chat_message': {
      const chat = useChatStore.getState();
      if (data?.id && (data.role === 'user' || data.role === 'assistant')) {
        if (!chat.messages.some((m) => m.id === data.id)) {
          chat.addMessage(data as import('@/stores/chat').ChatMessage);
        }
      }
      break;
    }
    case 'memory_event': {
      const orch = useOrchestrationStore.getState();
      if (data?.id && !orch.memoryEvents.some((e: { id: string }) => e.id === data.id)) {
        orch.addMemoryEvent(data);
      }
      break;
    }
    default:
      break;
  }
}

/** Fetch events between afterSeq and upToSeq from the REST API and apply them. */
async function recoverGap(afterSeq: number, upToSeq: number): Promise<void> {
  const connStore = useConnectionStore.getState();
  const sessionId = connStore.sessionId;
  if (!sessionId) return;
  try {
    const resp = await fetch(
      `/api/events?session_id=${encodeURIComponent(sessionId)}&after_seq=${afterSeq}&limit=500`,
    );
    if (resp.ok) {
      const { events } = (await resp.json()) as { events?: unknown[] };
      if (Array.isArray(events)) {
        for (const event of events) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((event as any)?.seq <= upToSeq) applyEvent(event);
        }
      }
    }
  } catch (err) {
    console.warn('[gateway] Gap recovery failed:', err);
  }
}

function getOrCreateWs(): ReconnectingWebSocket {
  if (!singletonWs || singletonWs.readyState === WebSocket.CLOSED) {
    boundWs = null;
    reconnectAttemptCount = 0;
    initAcked = false;
    singletonWs = new ReconnectingWebSocket(getGatewayUrl, undefined, {
      maxRetries: Infinity,
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 2,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any;
    try {
      // Handle compressed messages (binary frames with 'ZLIB' magic prefix).
      // The gateway compresses messages >64KB to reduce bandwidth.
      if (raw.data instanceof ArrayBuffer || raw.data instanceof Blob) {
        // Binary frame — check for ZLIB compression prefix
        const handleBinary = async (data: ArrayBuffer | Blob) => {
          const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
          const bytes = new Uint8Array(buffer);
          // Check for 'ZLIB' magic prefix (0x5A 0x4C 0x49 0x42)
          if (bytes.length > 4 && bytes[0] === 0x5A && bytes[1] === 0x4C && bytes[2] === 0x49 && bytes[3] === 0x42) {
            // Decompress using DecompressionStream (standard Web API)
            const compressed = bytes.slice(4);
            const ds = new DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(compressed);
            writer.close();
            const reader = ds.readable.getReader();
            const chunks: Uint8Array[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
              result.set(chunk, offset);
              offset += chunk.length;
            }
            const json = new TextDecoder().decode(result);
            // Validate the decompressed data is valid JSON before re-dispatching
            JSON.parse(json);
            // Re-dispatch as a synthetic text message event
            const synthetic = new MessageEvent('message', { data: json });
            if (ws.onmessage) ws.onmessage(synthetic);
            return;
          }
          // Not compressed — try parsing as UTF-8 JSON
          const text = new TextDecoder().decode(bytes);
          JSON.parse(text); // Validate JSON
          const synthetic = new MessageEvent('message', { data: text });
          if (ws.onmessage) ws.onmessage(synthetic);
        };
        handleBinary(raw.data).catch((err) => {
          console.warn('[gateway] Failed to handle binary WebSocket message', err);
        });
        return;
      }

      msg = JSON.parse(raw.data as string);
    } catch {
      console.warn('[gateway] Received non-JSON WebSocket message, ignoring');
      return;
    }
    const chat = chatStore();
    const orch = orchStore();

    // ── Sequence tracking & gap detection ──────────────────────────────
    if (msg.seq !== undefined) {
      const connStore = useConnectionStore.getState();
      const prevSeq = connStore.lastSeenSeq;
      if (msg.seq > prevSeq + 1) {
        // Gap detected — fetch and apply missing events asynchronously
        void recoverGap(prevSeq, msg.seq);
      }
      if (msg.seq > prevSeq) {
        connStore.setLastSeenSeq(msg.seq);
      }
    }

    switch (msg.type) {
      case 'text': {
        // Extract per-message metadata (model, tokens, cost) if present
        const textMeta = msg.metadata ? {
          model: msg.metadata.model,
          inputTokens: msg.metadata.inputTokens,
          outputTokens: msg.metadata.outputTokens,
          cacheReadTokens: msg.metadata.cacheReadTokens,
          costUsd: msg.metadata.costUsd,
        } : undefined;

        if (msg.workflowId && msg.workflowId.startsWith('conv-')) {
          if (msg.streaming && !msg.done && msg.content) {
            chat.appendToBackground(msg.workflowId, msg.content, msg.id);
          } else if (!msg.streaming && msg.content) {
            chat.addMessage({
              id: msg.id || uuid(),
              role: 'assistant',
              content: msg.content,
              timestamp: new Date().toISOString(),
              workflowId: msg.workflowId,
              isBackground: true,
              metadata: textMeta,
            });
          }
        } else {
          if (msg.streaming && !msg.done && msg.content) {
            chat.appendToLast(msg.content, msg.id);
          } else if (!msg.streaming && msg.content) {
            chat.addMessage({
              id: msg.id || uuid(),
              role: 'assistant',
              content: msg.content,
              timestamp: new Date().toISOString(),
              metadata: textMeta,
              ...(msg.workflowId ? { workflowId: msg.workflowId, dagId: msg.workflowId } : {}),
            });
            chat.setStreaming(false);
          }
          if (msg.done) {
            chat.setStreaming(false);
            // Accumulate session token totals when a non-streaming message completes with metadata
            if (textMeta && (textMeta.inputTokens || textMeta.outputTokens)) {
              chat.accumulateTokens(textMeta);
            }
          }
        }
        break;
      }
      case 'thinking':
        if (msg.streaming) chat.appendThinking(msg.thinking || '');
        if (msg.done) {
          chat.setThinking('');
          chat.markThinkingStepsDone();
        }
        break;
      case 'thinking_step':
        if (msg.step) chat.upsertThinkingStep(msg.step);
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
          nodes: d.nodes.map((n: { id: string; label: string; type: string; dependsOn?: string[] }) => ({
            ...n, status: 'pending' as const,
          })),
          completedCount: 0,
          totalCount: d.nodeCount,
          elapsed: 0,
        });
        chat.addMessage({
          id: msg.id || uuid(),
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

        // Also feed dag_progress events into the activity feed
        const progressEventType = p.tool?.name
          ? (p.status === 'done' || p.status === 'error' ? 'tool_result' : 'tool_call')
          : p.status === 'error' ? 'error' : 'status';
        orch.addEvent({
          workerId: p.workerId || p.nodeId,
          nodeId: p.nodeId,
          timestamp: new Date().toISOString(),
          type: progressEventType as import('@/stores/orchestration').WorkerEventType,
          tool: p.tool ? { name: p.tool.name, action: p.tool.action, file: p.tool.file, summary: p.tool.summary || '' } : undefined,
          message: p.message || (p.status === 'started' ? `${p.nodeLabel} started` : p.status === 'done' ? `${p.nodeLabel} completed` : undefined),
          progress: p.progress,
          error: p.status === 'error' ? (p.message || 'Node error') : undefined,
        }, p.workflowId);

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
              id: uuid(),
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
          id: msg.id || uuid(),
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
          id: msg.id || uuid(),
          role: 'assistant',
          content: cf.summary,
          timestamp: new Date().toISOString(),
          type: 'dag-confirmation',
          dagId: cf.workflowId,
        });
        break;
      }
      case 'event': {
        if (msg.event) orch.addEvent(msg.event, msg.workflowId);
        const evt = msg.event as {
          type?: string;
          tool?: { name?: string };
          error?: string;
          message?: string;
          iteration?: number;
          totalIterations?: number;
          fileLock?: { action: string; file: string };
        } | undefined;
        if (evt) {
          if (evt.type === 'tool_call' && evt.tool?.name) {
            chat.setStreamingStatus(statusFromToolCall(evt.tool.name));
          } else if (evt.type === 'tool_result') {
            chat.setStreamingStatus('Thinking\u2026');
          } else if (evt.type === 'error') {
            chat.markLastInterrupted();
            chat.addMessage({
              id: msg.id || uuid(),
              role: 'system',
              content: evt.error || evt.message || 'Worker error',
              timestamp: new Date().toISOString(),
              type: 'error',
            });
          } else if (evt.type === 'status' && evt.message) {
            chat.setStreamingStatus(evt.message);
          } else if (evt.type === 'loop_iteration') {
            const iterLabel = evt.iteration != null
              ? `Loop iteration ${evt.iteration}${evt.totalIterations != null ? `/${evt.totalIterations}` : ''}`
              : 'Loop iteration';
            chat.setStreamingStatus(iterLabel);
          } else if (evt.type === 'replan') {
            chat.setStreamingStatus('Replanning\u2026');
          } else if (evt.type === 'planning') {
            chat.setStreamingStatus('Planning\u2026');
          } else if (evt.type === 'fileLock' && evt.fileLock) {
            if (evt.fileLock.action === 'conflict') {
              chat.setStreamingStatus(`File lock conflict: ${evt.fileLock.file}`);
            }
          } else if (evt.type === 'agent_start') {
            chat.setStreamingStatus(evt.message || 'Starting agent\u2026');
          } else if (evt.type === 'warning') {
            chat.setStreamingStatus(evt.message || 'Warning');
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
        if (msg.commandResult?.command === 'restart' || msg.commandResult?.command === '/update') {
          if (msg.commandResult?.success === false) {
            pendingRestart = false;
          } else {
            pendingRestart = true;
          }
        }
        chat.addMessage({
          id: msg.id || uuid(),
          role: 'system',
          content: msg.commandResult?.message || msg.message || '',
          timestamp: new Date().toISOString(),
          type: 'command-result',
        });
        break;
      case 'error':
        chat.markLastInterrupted();
        chat.addMessage({
          id: msg.id || uuid(),
          role: 'system',
          content: msg.error || msg.message || 'Unknown error',
          timestamp: new Date().toISOString(),
          type: 'error',
        });
        break;
      case 'session': {
        // Full state snapshot from the init protocol — rehydrate everything
        if (msg.sessionId) {
          try { localStorage.setItem(SESSION_KEY, msg.sessionId); } catch { /* ignore */ }
          useConnectionStore.getState().setSessionId(msg.sessionId);
        }
        initAcked = true;
        if (msg.snapshot) {
          // Update lastSeenSeq from the snapshot's authoritative sequence number
          if (msg.snapshot.lastSeq) {
            const connStore = useConnectionStore.getState();
            if (msg.snapshot.lastSeq > connStore.lastSeenSeq) {
              connStore.setLastSeenSeq(msg.snapshot.lastSeq);
            }
          }
          rehydrateFromSnapshot(msg.snapshot, msg.bufferedEvents);
        }
        // Mark gateway as connected now that we have full state
        wsReady = true;
        healthCheckId = null;
        if (healthCheckTimer) { clearTimeout(healthCheckTimer); healthCheckTimer = null; }
        reconnectAttemptCount = 0;
        useConnectionStore.getState().setGatewayConnected(true);
        useConnectionStore.getState().setConnectionStatus('connected');
        useConnectionStore.getState().setReconnectAttempt(0);
        flushPendingMessages(ws);
        break;
      }
      case 'ack':
        try {
          const ackData = msg.content ? JSON.parse(msg.content) : null;
          if (ackData?.sessionId) {
            try {
              localStorage.setItem(SESSION_KEY, ackData.sessionId);
            } catch {
              // Quota exceeded — session ID is non-critical
            }
          }
        } catch { /* ignore parse errors */ }
        break;
      case 'history': {
        if (msg.history && Array.isArray(msg.history)) {
          processHistoryWhenHydrated(msg.history);
        }
        break;
      }
      case 'hindsight_status': {
        const hs = msg.hindsightStatus;
        if (hs) {
          useConnectionStore
            .getState()
            .setHindsightStatus(!!hs.connected, !!hs.busy);
        }
        break;
      }
      case 'memory_event': {
        const me = msg.memoryEvent;
        if (me) {
          const store = useOrchestrationStore.getState();
          if (!store.memoryEvents.some((e: { id: string }) => e.id === me.id)) {
            store.addMemoryEvent(me);
          }
        }
        break;
      }
      case 'memory_history': {
        if (msg.memoryEvents && Array.isArray(msg.memoryEvents)) {
          waitForHydration().then(() => {
            const store = useOrchestrationStore.getState();
            const existingIds = new Set(store.memoryEvents.map((e: { id: string }) => e.id));
            const newEvents = msg.memoryEvents!.filter((e: { id: string }) => !existingIds.has(e.id));
            if (newEvents.length > 0) {
              for (const e of newEvents) {
                store.addMemoryEvent(e);
              }
            }
          });
        }
        break;
      }
      case 'direct_complete': {
        const dc = msg.directComplete;
        if (!dc) break;
        // Create an InlineDAG entry so RunSummaryCard can render
        orch.upsertInlineDAG({
          dagId: dc.runId,
          summary: 'Direct response',
          status: 'dispatched',
          nodes: [],
          completedCount: 0,
          totalCount: 1,
          elapsed: 0,
        });
        orch.completeDAG(dc.runId, undefined, undefined, {
          durationSec: dc.durationSec,
          workerCount: 1,
          totalCostUsd: dc.totalCostUsd,
          modelUsage: dc.modelUsage?.map((m: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; workerCount: number; costUsd: number }) => ({
            model: m.model,
            inputTokens: m.inputTokens,
            outputTokens: m.outputTokens,
            cacheReadTokens: m.cacheReadTokens,
            cacheCreationTokens: m.cacheCreationTokens,
            workerCount: m.workerCount,
            costUsd: m.costUsd,
          })),
        });
        // Add a chat message that renders as RunSummaryCard
        chat.addMessage({
          id: msg.id || uuid(),
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
          type: 'dag-complete',
          dagId: dc.runId,
        });
        break;
      }
      case 'coding_event': {
        const ce = msg.codingEvent;
        if (!ce) break;
        const codingStore = useCodingModeStore.getState();
        switch (ce.type) {
          case 'coding:session:started':
            codingStore.setSession({
              sessionId: ce.payload.sessionId,
              taskDescription: '',
              repoUrl: ce.payload.repoUrl,
              branch: ce.payload.branch,
              status: 'running',
              steps: [],
              reviews: [],
              currentIteration: 0,
            });
            break;
          case 'coding:workflow:started':
            // Steps will be added as they start
            break;
          case 'coding:step:started':
            codingStore.addOrUpdateStep({
              id: ce.payload.nodeId,
              label: ce.payload.label,
              type: (ce.payload.type || 'custom') as import('@/stores/coding-mode').CodingStepType,
              status: 'running',
              startedAt: new Date().toISOString(),
            });
            break;
          case 'coding:step:progress':
            codingStore.updateStep(ce.payload.nodeId, {
              output: ce.payload.message,
            });
            break;
          case 'coding:step:completed':
            codingStore.updateStep(ce.payload.nodeId, {
              status: 'completed',
              completedAt: new Date().toISOString(),
              output: ce.payload.outputSummary,
            });
            break;
          case 'coding:step:failed':
            codingStore.updateStep(ce.payload.nodeId, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error: ce.payload.error,
            });
            break;
          case 'coding:review:started':
            codingStore.addReview({
              iteration: ce.payload.iteration,
              buildStatus: 'pending',
              decision: 'pending',
            });
            break;
          case 'coding:review:completed':
            codingStore.addReview({
              iteration: codingStore.session?.currentIteration ?? 1,
              buildStatus: 'pass',
              decision: ce.payload.decision === 'approve' ? 'approved' : 'retask',
              feedback: ce.payload.feedback,
            });
            break;
          case 'coding:commit:completed':
            codingStore.completeSession({
              commitHash: ce.payload.commitHash,
            });
            break;
          case 'coding:session:completed':
            codingStore.completeSession({
              filesChanged: [...(ce.payload.filesModified ?? []), ...(ce.payload.filesCreated ?? [])],
              totalDurationMs: ce.payload.totalDurationMs,
            });
            break;
        }
        break;
      }
      case 'pong':
        if (healthCheckId && msg.id === healthCheckId) {
          wsReady = true;
          healthCheckId = null;
          if (healthCheckTimer) { clearTimeout(healthCheckTimer); healthCheckTimer = null; }
          useConnectionStore.getState().setGatewayConnected(true);
          flushPendingMessages(ws);
        }
        break;
      case 'file_content': {
        const cb = fileReadCallbacks.get(msg.id);
        if (cb) {
          fileReadCallbacks.delete(msg.id);
          cb(msg);
        }
        break;
      }
      case 'presence': {
        if (typeof msg.count === 'number') {
          useConnectionStore.getState().setPresenceCount(msg.count);
        }
        break;
      }
      default:
        console.debug('[gateway] unhandled message type:', msg.type, msg);
    }
  };

  ws.onopen = () => {
    if (pendingRestart) {
      pendingRestart = false;
      window.location.reload();
    }

    const chat = useChatStore.getState();
    if (chat.isStreaming) {
      chat.setStreaming(false);
      chat.setStreamingStatus('');
    }

    // Reset reconnect tracking
    reconnectAttemptCount = 0;
    initAcked = false;
    wsReady = false;

    // Update connection status — we're connected but awaiting init ack
    useConnectionStore.getState().setReconnectAttempt(0);

    // Send init message with saved session ID for full state rehydration
    let savedSession: string | null = null;
    try { savedSession = localStorage.getItem(SESSION_KEY); } catch { /* ignore */ }
    const initId = uuid();
    try {
      ws.send(JSON.stringify({
        id: initId,
        type: 'init',
        ...(savedSession ? { sessionId: savedSession } : {}),
        lastSeenSeq: useConnectionStore.getState().lastSeenSeq,
      }));
    } catch {
      /* will retry on next reconnect */
    }

    // Set up periodic client state sync (every 5 seconds)
    if (clientStateInterval) clearInterval(clientStateInterval);
    clientStateInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'client_state',
            agentMode: useAgentModeStore.getState().mode,
            lastSeenSeq: useConnectionStore.getState().lastSeenSeq,
            activePanel: useOrchestrationStore.getState().activeOrchTab,
            orchPaneOpen: useOrchestrationStore.getState().orchPaneOpen,
          }));
        } catch { /* ignore */ }
      }
    }, 5000);

    // Also send a ping for backward compat health check
    if (healthCheckTimer) clearTimeout(healthCheckTimer);
    healthCheckId = uuid();
    const pingId = healthCheckId;
    try {
      ws.send(JSON.stringify({ id: pingId, type: 'ping' }));
    } catch {
      /* will retry on next reconnect */
    }
    healthCheckTimer = setTimeout(() => {
      if (!wsReady && healthCheckId === pingId) {
        console.warn('[gateway] Health check timed out — forcing reconnect');
        healthCheckId = null;
        ws.reconnect();
      }
    }, 10000);

    if (statusFetchController) statusFetchController.abort();
    statusFetchController = new AbortController();
    const { signal } = statusFetchController;
    fetch('/api/gateway/api/status', { signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.hindsight && useConnectionStore.getState().gatewayConnected) {
          useConnectionStore
            .getState()
            .setHindsightStatus(!!data.hindsight.connected, !!data.hindsight.busy);
        }
      })
      .catch((err) => { console.warn('[gateway] status fetch error', err); });
  };

  ws.onclose = () => {
    wsReady = false;
    initAcked = false;
    if (healthCheckTimer) { clearTimeout(healthCheckTimer); healthCheckTimer = null; }
    healthCheckId = null;
    if (clientStateInterval) { clearInterval(clientStateInterval); clientStateInterval = null; }
    if (statusFetchController) { statusFetchController.abort(); statusFetchController = null; }
    const connStore = useConnectionStore.getState();
    connStore.setGatewayConnected(false);
    connStore.setHindsightStatus(false, false);

    // Track reconnect attempts and set appropriate status
    reconnectAttemptCount++;
    connStore.setReconnectAttempt(reconnectAttemptCount);
    // First disconnect → 'reconnecting', sustained → stays 'reconnecting'
    // Only set 'disconnected' if we've never connected or after many failures
    connStore.setConnectionStatus(reconnectAttemptCount > 10 ? 'disconnected' : 'reconnecting');

    useChatStore.getState().markLastInterrupted();
    useOrchestrationStore.getState().markAllInterrupted();
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
    safeSend(ws, JSON.stringify(data));
  }, []);

  const sendChat = useCallback(
    async (content: string, replyToId?: string, attachments?: FileAttachment[]) => {
      const chat = useChatStore.getState();
      const replyTarget = chat.replyTarget;
      const msgId = uuid();

      let messageAttachments: import('@/stores/chat').MessageAttachment[] | undefined;
      const payloadAttachments: { name: string; size: number; type: string; data?: string; textContent?: string }[] = [];

      if (attachments && attachments.length > 0) {
        const readResults = await Promise.all(
          attachments.map(async (a) => {
            const isImage = a.type.startsWith('image/');
            if (isImage) {
              const dataUrl = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.readAsDataURL(a.file);
              });
              return { name: a.name, size: a.size, type: a.type, dataUrl, data: dataUrl };
            } else {
              const textContent = await a.file.text();
              return { name: a.name, size: a.size, type: a.type, textContent };
            }
          }),
        );
        messageAttachments = readResults.map((r) => ({
          name: r.name,
          size: r.size,
          type: r.type,
          dataUrl: r.dataUrl,
        }));
        readResults.forEach((r) => {
          payloadAttachments.push({
            name: r.name,
            size: r.size,
            type: r.type,
            data: r.data,
            textContent: r.textContent,
          });
        });
      }

      chat.addMessage({
        id: msgId,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        replyTo: replyTarget ?? undefined,
        attachments: messageAttachments,
      });
      chat.setStreaming(true);
      chat.setStreamingStatus('Thinking…');
      const payload: Record<string, unknown> = {
        id: msgId,
        type: 'chat',
        content,
        agentMode: useAgentModeStore.getState().mode,
      };
      if (replyToId && replyTarget) {
        payload.replyToId = replyToId;
        payload.replyToContent = replyTarget.content;
        payload.replyToRole = replyTarget.role;
        if (replyTarget.dagId) payload.replyToDagId = replyTarget.dagId;
      }
      if (payloadAttachments.length > 0) {
        payload.attachments = payloadAttachments;
      }
      send(payload);
    },
    [send],
  );

  const sendCommand = useCallback(
    (command: string) => {
      if (command === 'stop') {
        useChatStore.getState().markLastInterrupted();
      }
      if (command === 'restart' || command === 'update') {
        pendingRestart = true;
      }
      send({ id: uuid(), type: 'command', command });
    },
    [send],
  );

  const sendWorkflowCommand = useCallback(
    (command: 'pause' | 'resume' | 'stop', workflowId: string) => {
      if (command === 'stop') {
        useOrchestrationStore.getState().stopDAG(workflowId);
      } else if (command === 'pause') {
        useOrchestrationStore.getState().pauseDAG(workflowId);
      } else if (command === 'resume') {
        useOrchestrationStore.getState().resumeDAG(workflowId);
      }
      send({ id: uuid(), type: 'command', command: `/${command}`, workflowId });
    },
    [send],
  );

  const respondToPlan = useCallback(
    (planId: string, action: string, modification?: string) => {
      send({ id: uuid(), type: 'plan_response', planId, action, modification });
      useOrchestrationStore.getState().setActivePlan(null);
    },
    [send],
  );

  const respondToDAG = useCallback(
    (workflowId: string, action: 'approve' | 'reject') => {
      send({ id: uuid(), type: 'dag_response', workflowId, dagAction: action });
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

  return { send, sendChat, sendCommand, sendWorkflowCommand, respondToPlan, respondToDAG, respondToConfirmation };
}

/**
 * Switch to a different session without a full page reload.
 * Clears all client stores, updates the stored session ID, and forces a
 * WebSocket reconnect so the server sends a fresh state snapshot.
 */
export function switchToSession(newSessionId: string): void {
  // Clear all stores
  useChatStore.getState().clearMessages();
  useOrchestrationStore.getState().reset();
  useAgentModeStore.getState().setMode('orchestrate');
  // Update the stored session and reset seq tracking
  try { localStorage.setItem(SESSION_KEY, newSessionId); } catch { /* ignore */ }
  useConnectionStore.getState().setSessionId(newSessionId);
  useConnectionStore.getState().setLastSeenSeq(0);
  useConnectionStore.getState().setHasOlderMessages(false);
  // Reconnect — onopen will send init with the new sessionId
  wsReady = false;
  initAcked = false;
  if (singletonWs) {
    singletonWs.reconnect();
  }
}

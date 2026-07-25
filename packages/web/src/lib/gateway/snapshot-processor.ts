'use client';

/**
 * @module gateway/snapshot-processor
 * Pure(ish) state-reconciliation logic driven by the gateway's persisted
 * history and reconnection snapshots. These functions read the Zustand stores
 * and apply server-authoritative state to them; they do NOT touch the
 * WebSocket singleton. Buffered-event replay is delegated to a caller-provided
 * `replay` callback so this module stays decoupled from the socket lifecycle.
 */

import { useOrchestrationStore } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';
import { useConnectionStore } from '@/stores/connection';
import { useAgentModeStore } from '@/stores/agent-mode';
import { useCodingModeStore } from '@/stores/coding-mode';
import type { ChatMessage, BurnRateSnapshot } from '@/stores/chat';
import type { SessionSnapshot } from '@orionomega/shared/ws-contract';

/**
 * Local, richer shape of a persisted history message. The shared contract's
 * `HistoryMessage` types `metadata` loosely (`Record<string, unknown>`); this
 * interface narrows the metadata fields the reconciliation logic reads.
 */
export interface HistoryMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  type?: string;
  dagId?: string;
  metadata?: {
    workflowId?: string;
    gateId?: string;
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

export function waitForHydration(): Promise<void> {
  // Both stores are non-persisted (no localStorage), so they are always hydrated.
  return Promise.resolve();
}

export function processHistoryWhenHydrated(history: HistoryMessage[]): void {
  waitForHydration().then(() => {
    const serverMessages: ChatMessage[] = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        const wfId = m.metadata?.workflowId
          || m.metadata?.dagDispatch?.workflowId
          || m.metadata?.dagComplete?.workflowId
          || m.metadata?.dagConfirm?.workflowId;
        // Gate-request cards are keyed by gateId, not workflowId — preserve
        // that so MessageBubble can look up pendingGates[dagId] correctly
        // after a reload.
        const dagId = m.type === 'gate-request'
          ? (m.metadata?.gateId || m.dagId || wfId || undefined)
          : (m.dagId || wfId || undefined);
        return {
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content ?? '',
          timestamp: m.timestamp,
          type: m.type as ChatMessage['type'],
          dagId,
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
            nodes: (d.nodes ?? []).map((n) => ({
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
        if (existingDag && (existingDag.status === 'complete' || existingDag.status === 'error' || existingDag.status === 'stopped' || existingDag.status === 'superseded')) {
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

/**
 * Dispatch a single persisted event (from REST gap-recovery) to the
 * appropriate Zustand store.  Events use the same shape the server stores
 * in the events table: { seq, event_type, data }.
 */
function applyEvent(event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const e = event as { event_type?: string; type?: string; data?: unknown };
  const eventType: string = e.event_type || e.type || '';
  const data = (e.data ?? event) as { id?: string; role?: string } & Record<string, unknown>;

  switch (eventType) {
    case 'message':
    case 'chat_message': {
      const chat = useChatStore.getState();
      if (data?.id && (data.role === 'user' || data.role === 'assistant')) {
        if (!chat.messages.some((m) => m.id === data.id)) {
          chat.addMessage(data as unknown as ChatMessage);
        }
      }
      break;
    }
    case 'memory_event': {
      const orch = useOrchestrationStore.getState();
      if (data?.id && !orch.memoryEvents.some((ev: { id: string }) => ev.id === data.id)) {
        orch.addMemoryEvent(data as unknown as Parameters<typeof orch.addMemoryEvent>[0]);
      }
      break;
    }
    default:
      break;
  }
}

/** Fetch events between afterSeq and upToSeq from the REST API and apply them. */
export async function recoverGap(afterSeq: number, upToSeq: number): Promise<void> {
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
          if ((event as { seq?: number })?.seq != null && (event as { seq: number }).seq <= upToSeq) {
            applyEvent(event);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[gateway] Gap recovery failed:', err);
  }
}

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
 *
 * Buffered events (received while disconnected) are replayed through the
 * caller-provided `replay` callback, which re-dispatches them through the live
 * socket's message handler.
 */
export function rehydrateFromSnapshot(
  snapshot: SessionSnapshot,
  bufferedEvents?: unknown[],
  replay?: (ev: MessageEvent) => void,
): void {
  waitForHydration().then(() => {
    const rehydrateStart = performance.now();
    let sectionsOk = 0;
    let sectionsFailed = 0;

    const chat = useChatStore.getState();
    const orch = useOrchestrationStore.getState();

    // ── 1. Rehydrate chat messages ──────────────────────────────────────
    try {
      if (snapshot.messages && Array.isArray(snapshot.messages)) {
        processHistoryWhenHydrated(snapshot.messages as unknown as HistoryMessage[]);
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
          orch.addMemoryEvent(e as unknown as Parameters<typeof orch.addMemoryEvent>[0]);
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
          if (!existing || (existing.status !== 'complete' && existing.status !== 'error' && existing.status !== 'stopped' && existing.status !== 'superseded')) {
            orch.upsertInlineDAG({
              dagId: dag.dagId,
              summary: dag.summary,
              status: dag.status,
              nodes: dag.nodes || [],
              completedCount: dag.completedCount ?? 0,
              totalCount: dag.totalCount ?? 0,
              elapsed: dag.elapsed ?? 0,
              // Forward direct-mode flag so the orchestration pane's
              // "Direct" badge and any direct-mode rendering survive
              // a page reload.
              isDirect: dag.isDirect,
            });
            // If the server says it's complete, apply completion stats
            if (dag.status === 'complete' || dag.status === 'error' || dag.status === 'stopped' || dag.status === 'superseded') {
              orch.completeDAG(dagId, dag.result, dag.error, {
                durationSec: dag.durationSec,
                workerCount: dag.workerCount,
                totalCostUsd: dag.totalCostUsd,
                toolCallCount: dag.toolCallCount,
                modelUsage: dag.modelUsage,
                nodeOutputPaths: dag.nodeOutputPaths,
                stopped: dag.status === 'stopped',
                supersededBy: dag.supersededBy,
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
          const evt = entry.event as { type?: unknown } & Record<string, unknown>;
          // Validate minimum event shape (must have at least a type)
          if (typeof evt !== 'object' || !evt.type) continue;
          orch.addEvent(evt as unknown as Parameters<typeof orch.addEvent>[0], entry.workflowId);
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // ── 3e. Rehydrate live burn-rate snapshot (Task #245) ───────────────
    // `burnRate` rides on the snapshot via the contract's `.passthrough()`,
    // so it isn't on the inferred `SessionSnapshot` type — read it defensively.
    try {
      const burnRate = (snapshot as { burnRate?: BurnRateSnapshot | null }).burnRate;
      chat.setBurnRate(burnRate ?? null);
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate burn rate', err);
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
        orch.setActivePlan(snapshot.activePlan as Parameters<typeof orch.setActivePlan>[0]);
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate active plan', err);
    }

    // ── 6a. Rehydrate pending human-gate approvals ──────────────────────
    // Persisted server-side so the structured Allow/Deny card survives
    // page reloads while the backend gate is still waiting on a response.
    try {
      if (snapshot.pendingGates && typeof snapshot.pendingGates === 'object') {
        for (const gate of Object.values(snapshot.pendingGates) as Array<{
          gateId: string;
          workflowId: string;
          workflowName: string;
          action: string;
          description: string;
          timestamp: string;
        }>) {
          if (!gate || !gate.gateId) continue;
          orch.setPendingGate({
            gateId: gate.gateId,
            workflowId: gate.workflowId,
            workflowName: gate.workflowName,
            action: gate.action,
            description: gate.description,
            timestamp: gate.timestamp,
          });
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate pending gates', err);
    }

    // ── 6b. Rehydrate pending manual-intervention requests (Task #234) ───
    // Persisted server-side so the WorkerDetail input panel survives page
    // reloads while the worker is still blocked awaiting human input.
    try {
      if (snapshot.pendingInterventions && typeof snapshot.pendingInterventions === 'object') {
        for (const iv of Object.values(snapshot.pendingInterventions) as Array<{
          interventionId: string;
          workflowId: string;
          workflowName: string;
          nodeId: string;
          nodeLabel: string;
          prompt: string;
          timestamp: string;
        }>) {
          if (!iv || !iv.interventionId || !iv.nodeId) continue;
          orch.setPendingIntervention({
            interventionId: iv.interventionId,
            workflowId: iv.workflowId,
            workflowName: iv.workflowName,
            nodeId: iv.nodeId,
            nodeLabel: iv.nodeLabel,
            prompt: iv.prompt,
            timestamp: iv.timestamp,
          });
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate pending interventions', err);
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
          useAgentModeStore.getState().setMode(snapshot.agentMode as 'orchestrate' | 'direct' | 'code');
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
        const cs = snapshot.codingSession as {
          sessionId?: string;
          taskDescription?: string;
          repoUrl?: string;
          branch?: string;
          status?: string;
          steps?: unknown[];
          reviews?: unknown[];
          currentIteration?: number;
        };
        useCodingModeStore.getState().setSession({
          sessionId: cs.sessionId ?? '',
          taskDescription: cs.taskDescription ?? '',
          repoUrl: cs.repoUrl ?? '',
          branch: cs.branch ?? '',
          status: (cs.status ?? 'running') as Parameters<ReturnType<typeof useCodingModeStore.getState>['setSession']>[0]['status'],
          steps: (cs.steps ?? []) as Parameters<ReturnType<typeof useCodingModeStore.getState>['setSession']>[0]['steps'],
          reviews: (cs.reviews ?? []) as Parameters<ReturnType<typeof useCodingModeStore.getState>['setSession']>[0]['reviews'],
          currentIteration: cs.currentIteration ?? 0,
        });
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate coding session', err);
    }

    // ── 9. Rehydrate memory activity ────────────────────────────────────
    try {
      if (snapshot.memoryActivity) {
        const activity = snapshot.memoryActivity;
        useConnectionStore.getState().setMemoryActivity({
          busy: !!activity.busy,
          health: activity.health,
          pct: activity.pct,
          reason: activity.reason,
          op: activity.op,
          count: activity.count,
        });
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to rehydrate memory activity', err);
    }

    // ── 10. Restore persisted client state ─────────────────────────────
    try {
      if (snapshot.clientState) {
        const cs = snapshot.clientState as {
          agentMode?: string;
          orchPaneOpen?: boolean;
          activePanel?: string;
        };
        // Restore agent mode from persisted client state (overrides section 7 only
        // if present here — section 7 handles snapshot.agentMode from server runs)
        if (cs.agentMode) {
          const validModes = new Set(['orchestrate', 'direct', 'code']);
          if (validModes.has(cs.agentMode)) {
            useAgentModeStore.getState().setMode(cs.agentMode as 'orchestrate' | 'direct' | 'code');
          }
        }
        // Restore orch pane state if present.
        //
        // Mobile guard: on a < md (768px) viewport the orch pane renders as a
        // fullscreen `fixed inset-0` overlay and the chat container is
        // `hidden md:block`, which removes the chat input from the DOM
        // entirely. Re-applying a server-saved `orchPaneOpen: true` (commonly
        // persisted from a desktop session) on mobile would silently hide the
        // chat input and leave the user unable to type. Only ever auto-CLOSE
        // the pane on mobile from a server snapshot; never auto-open it.
        // Desktop and explicit user toggles via the in-app button are
        // unaffected. Companion: HomeClient also auto-closes on mount.
        if (typeof cs.orchPaneOpen === 'boolean') {
          const isMobile =
            typeof window !== 'undefined' && window.innerWidth < 768;
          if (!(isMobile && cs.orchPaneOpen)) {
            useOrchestrationStore.getState().setOrchPaneOpen(cs.orchPaneOpen);
          }
        }
        if (cs.activePanel) {
          const validTabs = new Set(['memory', 'workflow', 'files', 'logs', 'schedules']);
          if (validTabs.has(cs.activePanel)) {
            useOrchestrationStore.getState().setActiveOrchTab(cs.activePanel as Parameters<ReturnType<typeof useOrchestrationStore.getState>['setActiveOrchTab']>[0]);
          }
        }
      }
      sectionsOk++;
    } catch (err) {
      sectionsFailed++;
      console.error('[gateway] Failed to restore client state', err);
    }

    // ── 11. Replay buffered events (events that happened while disconnected) ──
    if (bufferedEvents && Array.isArray(bufferedEvents) && replay) {
      for (const rawEvt of bufferedEvents) {
        // Each buffered event is a ServerMessage — replay it through the normal handler
        try {
          const synthetic = new MessageEvent('message', {
            data: JSON.stringify(rawEvt),
          });
          replay(synthetic);
        } catch (err) {
          console.warn('[gateway] Failed to replay buffered event', err);
        }
      }
    }

    const rehydrateMs = Math.round(performance.now() - rehydrateStart);
    const _pagination = snapshot.pagination as { hasOlderMessages?: boolean } | undefined;
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

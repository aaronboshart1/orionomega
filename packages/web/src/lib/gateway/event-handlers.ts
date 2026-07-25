'use client';

/**
 * @module gateway/event-handlers
 * The server → client message handler. `handleServerMessage` performs sequence
 * tracking + gap recovery and dispatches each `ServerMessage` to the relevant
 * Zustand store. It is decoupled from the WebSocket singleton via a
 * `MessageHandlerContext` that exposes the few mutable connection-state setters
 * and side effects (flush, health-check, restart flag, buffered-event replay)
 * owned by the WS client module.
 */

import { useOrchestrationStore } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';
import type { BurnRateSnapshot } from '@/stores/chat';
import { useConnectionStore } from '@/stores/connection';
import { useAgentModeStore } from '@/stores/agent-mode';
import { useCodingModeStore } from '@/stores/coding-mode';
import { useSchedulesStore } from '@/stores/schedules';
import { uuid } from '@/lib/uuid';
import type { ServerMessage } from '@orionomega/shared/ws-contract';
import { SESSION_KEY, statusFromToolCall } from '@/lib/gateway/connection-utils';
import {
  processHistoryWhenHydrated,
  rehydrateFromSnapshot,
  recoverGap,
  waitForHydration,
  type HistoryMessage,
} from '@/lib/gateway/snapshot-processor';

/**
 * Hooks the message handler needs back into the WS client module: mutable
 * connection-state setters and side effects that live alongside the socket
 * singleton.
 */
export interface MessageHandlerContext {
  /** Flush any queued outbound messages over the (now-ready) socket. */
  flush: () => void;
  /** Mark the socket as ready (init/pong acked). */
  setWsReady: (v: boolean) => void;
  /** Record that the init protocol has been acked. */
  setInitAcked: (v: boolean) => void;
  /** Reset the reconnect attempt counter to zero. */
  resetReconnectCount: () => void;
  /** Read the in-flight health-check ping id (for pong matching). */
  getHealthCheckId: () => string | null;
  /** Clear the in-flight health-check ping id + its timeout. */
  clearHealthCheck: () => void;
  /** Set/clear the "reload on next reconnect" flag. */
  setPendingRestart: (v: boolean) => void;
  /** Pending file-read callbacks keyed by request id. */
  fileReadCallbacks: Map<string, (msg: ServerMessage) => void>;
  /** Re-dispatch a synthetic message event through the live socket handler. */
  replay: (ev: MessageEvent) => void;
}

/**
 * Apply a parsed server message to the client stores. Performs sequence
 * tracking + gap recovery first, then dispatches by `msg.type`.
 */
export function handleServerMessage(msg: ServerMessage, ctx: MessageHandlerContext): void {
  const chat = useChatStore.getState();
  const orch = useOrchestrationStore.getState();

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
      orch.setActivePlan(msg.plan as Parameters<typeof orch.setActivePlan>[0]);
      break;
    case 'dag_dispatched': {
      const d = msg.dagDispatch;
      if (!d || !d.workflowId) break;
      orch.upsertInlineDAG({
        dagId: d.workflowId,
        summary: d.summary,
        status: 'dispatched',
        nodes: (d.nodes ?? []).map((n: { id: string; label: string; type: string; dependsOn?: string[] }) => ({
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
            m.toolCall.toolName === p.tool!.name &&
            m.toolCall.file === p.tool!.file &&
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
      if (!c || !c.workflowId) break;
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
    case 'gate_resolved': {
      const gr = msg.gateResolved;
      if (!gr) break;
      // Mark the card as resolved (approved/denied/expired) so it
      // visibly reflects its final state and can no longer be acted on.
      // Using resolvePendingGate (rather than removePendingGate) keeps
      // the card mounted with a clear status badge instead of vanishing.
      orch.resolvePendingGate(gr.gateId, gr.resolution);
      break;
    }
    case 'gate_request': {
      const gr = msg.gateRequest;
      if (!gr) break;
      orch.setPendingGate({
        gateId: gr.gateId,
        workflowId: gr.workflowId,
        workflowName: gr.workflowName,
        action: gr.action,
        description: gr.description,
        timestamp: gr.timestamp,
      });
      // Avoid creating duplicate chat entries when the same gate_request
      // arrives via both the live socket and a buffered/replayed event.
      const gateMsgId = `gate-${gr.gateId}`;
      if (!useChatStore.getState().messages.some((m) => m.id === gateMsgId)) {
        chat.addMessage({
          id: gateMsgId,
          role: 'assistant',
          content: `Approval needed: ${gr.action}`,
          timestamp: gr.timestamp || new Date().toISOString(),
          type: 'gate-request',
          dagId: gr.gateId,
          workflowId: gr.workflowId,
        });
      }
      break;
    }
    case 'intervention_request': {
      const ir = msg.interventionRequest;
      if (!ir) break;
      // Surface a free-text input panel keyed by nodeId in WorkerDetail.
      orch.setPendingIntervention({
        interventionId: ir.interventionId,
        workflowId: ir.workflowId,
        workflowName: ir.workflowName,
        nodeId: ir.nodeId,
        nodeLabel: ir.nodeLabel,
        prompt: ir.prompt,
        timestamp: ir.timestamp,
      });
      break;
    }
    case 'intervention_resolved': {
      const ir = msg.interventionResolved;
      if (!ir) break;
      // Mark the panel resolved (keeps it briefly mounted with status) then drop.
      orch.resolvePendingIntervention(ir.nodeId);
      orch.removePendingIntervention(ir.nodeId);
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
      if (msg.event) orch.addEvent(msg.event as Parameters<typeof orch.addEvent>[0], msg.workflowId);

      // ── Direct-mode tool transparency ─────────────────────────
      // When a Direct-mode turn invokes a tool, surface it inline in
      // chat as a ToolCallCard (mirroring the dag_progress branch
      // above). Direct-mode events are tagged with a `direct-…`
      // workflowId by main-agent.respondConversationally.
      const isDirectEvt = !!msg.workflowId && msg.workflowId.startsWith('direct-');
      const directEvt = msg.event as {
        type?: string;
        tool?: { id?: string; name: string; summary?: string; file?: string; action?: string; params?: Record<string, unknown> };
        message?: string;
        error?: string;
        durationMs?: number;
      } | undefined;
      if (isDirectEvt && directEvt?.tool?.name && (directEvt.type === 'tool_call' || directEvt.type === 'tool_result')) {
        const t = directEvt.tool;
        const isResult = directEvt.type === 'tool_result';
        const isErrorResult = isResult && (!!directEvt.error || (directEvt.message ?? '').startsWith('Error:'));
        const currentMessages = useChatStore.getState().messages;
        // Prefer matching by stable tool_use id so repeated calls with the
        // same tool/file pair (e.g. two read_file calls) are not merged.
        // Fall back to the older heuristic for legacy events that lack id.
        const existing = [...currentMessages].reverse().find((m) => {
          if (m.type !== 'tool-call' || m.dagId !== msg.workflowId) return false;
          if (t.id && m.toolCall?.toolCallId) return m.toolCall.toolCallId === t.id;
          return (
            m.toolCall?.toolName === t.name &&
            m.toolCall?.file === t.file &&
            m.toolCall?.status === 'running'
          );
        });
        if (existing && isResult) {
          chat.updateToolCall(existing.id, {
            status: isErrorResult ? 'error' : 'done',
            result: directEvt.message,
            isError: isErrorResult,
            durationMs: directEvt.durationMs,
          });
        } else if (!existing && !isResult) {
          chat.addMessage({
            id: uuid(),
            role: 'assistant',
            content: t.summary || `${t.name}${t.file ? `: ${t.file}` : ''}`,
            timestamp: new Date().toISOString(),
            type: 'tool-call',
            dagId: msg.workflowId,
            toolCall: {
              toolName: t.name,
              action: t.action,
              file: t.file,
              summary: t.summary || '',
              status: 'running',
              params: t.params,
              workerId: 'direct',
              nodeId: 'direct',
              nodeLabel: 'Direct response',
              toolCallId: t.id,
            },
          });
        } else if (!existing && isResult) {
          // Result arrived without a matching start (e.g. after a reload) — render it directly.
          chat.addMessage({
            id: uuid(),
            role: 'assistant',
            content: t.summary || t.name,
            timestamp: new Date().toISOString(),
            type: 'tool-call',
            dagId: msg.workflowId,
            toolCall: {
              toolName: t.name,
              action: t.action,
              file: t.file,
              summary: t.summary || '',
              status: isErrorResult ? 'error' : 'done',
              result: directEvt.message,
              isError: isErrorResult,
              durationMs: directEvt.durationMs,
              workerId: 'direct',
              nodeId: 'direct',
              nodeLabel: 'Direct response',
              toolCallId: t.id,
            },
          });
        }
      }

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
        } else if (evt.type === 'context_updated') {
          chat.setStreamingStatus('Context updated\u2026');
        }
      }
      if (msg.graphState) orch.setGraphState(msg.graphState as Parameters<typeof orch.setGraphState>[0]);
      break;
    }
    case 'status':
      if (msg.graphState) orch.setGraphState(msg.graphState as Parameters<typeof orch.setGraphState>[0]);
      if (msg.status) chat.setStreamingStatus(msg.status as string);
      break;
    case 'command_result':
      if (msg.commandResult?.command === 'restart' || msg.commandResult?.command === '/update') {
        if (msg.commandResult?.success === false) {
          ctx.setPendingRestart(false);
        } else {
          ctx.setPendingRestart(true);
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
        // Reflect the server-assigned session ID in the URL (replaceState — no back-nav entry)
        try {
          const url = new URL(window.location.href);
          if (url.searchParams.get('session') !== msg.sessionId) {
            url.searchParams.set('session', msg.sessionId);
            history.replaceState(null, '', url.toString());
          }
        } catch { /* ignore */ }
        useConnectionStore.getState().setSessionId(msg.sessionId);
      }
      ctx.setInitAcked(true);
      if (msg.snapshot) {
        // Update lastSeenSeq from the snapshot's authoritative sequence number
        if (msg.snapshot.lastSeq) {
          const connStore = useConnectionStore.getState();
          if (msg.snapshot.lastSeq > connStore.lastSeenSeq) {
            connStore.setLastSeenSeq(msg.snapshot.lastSeq);
          }
        }
        rehydrateFromSnapshot(msg.snapshot, msg.bufferedEvents, ctx.replay);
      }
      // Mark gateway as connected now that we have full state
      ctx.setWsReady(true);
      ctx.clearHealthCheck();
      ctx.resetReconnectCount();
      useConnectionStore.getState().setGatewayConnected(true);
      useConnectionStore.getState().setConnectionStatus('connected');
      useConnectionStore.getState().setReconnectAttempt(0);
      ctx.flush();
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
        processHistoryWhenHydrated(msg.history as unknown as HistoryMessage[]);
      }
      break;
    }
    case 'memory_activity': {
      const activity = msg.memoryActivity;
      if (activity) {
        useConnectionStore.getState().setMemoryActivity({
          busy: !!activity.busy,
          health: activity.health,
          pct: activity.pct,
          reason: activity.reason,
          op: activity.op,
          count: activity.count,
        });
      }
      break;
    }
    case 'memory_event': {
      const me = msg.memoryEvent;
      if (me) {
        const store = useOrchestrationStore.getState();
        if (!store.memoryEvents.some((e: { id: string }) => e.id === me.id)) {
          store.addMemoryEvent(me as unknown as Parameters<typeof store.addMemoryEvent>[0]);
        }
      }
      break;
    }
    case 'memory_history': {
      if (msg.memoryEvents && Array.isArray(msg.memoryEvents)) {
        const events = msg.memoryEvents;
        waitForHydration().then(() => {
          const store = useOrchestrationStore.getState();
          const existingIds = new Set(store.memoryEvents.map((e: { id: string }) => e.id));
          const newEvents = events.filter((e: { id: string }) => !existingIds.has(e.id));
          if (newEvents.length > 0) {
            for (const e of newEvents) {
              store.addMemoryEvent(e as unknown as Parameters<typeof store.addMemoryEvent>[0]);
            }
          }
        });
      }
      break;
    }
    case 'direct_started': {
      const ds = msg.directStart;
      if (!ds) break;
      // Open an inline run summary card and orchestration-pane workflow
      // tab as soon as a Direct-mode turn starts so tool calls have a
      // home before the final completion event arrives.
      orch.upsertInlineDAG({
        dagId: ds.runId,
        summary: ds.userMessage || 'Direct response',
        status: 'running',
        nodes: [{ id: 'direct', label: 'Direct response', type: 'AGENT', status: 'running' }],
        completedCount: 0,
        totalCount: 1,
        elapsed: 0,
        isDirect: true,
      });
      break;
    }
    case 'direct_complete': {
      const dc = msg.directComplete;
      if (!dc) break;
      // Create an InlineDAG entry so RunSummaryCard can render. Pass an
      // empty summary + nodes so the merge logic in upsertInlineDAG
      // preserves the identity (isDirect, original summary, original
      // nodes) seeded by the earlier direct_started event.
      orch.upsertInlineDAG({
        dagId: dc.runId,
        summary: '',
        status: 'dispatched',
        nodes: [],
        completedCount: 0,
        totalCount: 1,
        elapsed: 0,
        isDirect: true,
      });
      orch.completeDAG(dc.runId, dc.error ? 'error' : undefined, dc.error, {
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
        supersededBy: (dc as { supersededBy?: string }).supersededBy,
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
    case 'schedule_triggered': {
      const t = msg.scheduleTriggered;
      if (t) {
        const store = useSchedulesStore.getState();
        store.markTriggered(t.taskId, t.executionId);
        store.prependExecution(t.taskId, {
          id: t.executionId,
          taskId: t.taskId,
          status: 'running',
          startedAt: t.firedAt,
          completedAt: null,
          durationSec: null,
          error: null,
          // Use the trigger source from the gateway. Older payloads
          // without this field fall back to 'cron'.
          triggerType: t.triggerType ?? 'cron',
        });
      }
      break;
    }
    case 'schedule_execution_complete': {
      const c = msg.scheduleExecutionComplete;
      if (c) {
        const store = useSchedulesStore.getState();
        store.clearTriggered(c.taskId, c.executionId);
        store.updateExecution(c.taskId, c.executionId, {
          status: c.status,
          durationSec: c.durationSec,
          error: c.error,
          completedAt: c.completedAt,
        });
        // Refresh schedule list metadata (lastRunAt, lastStatus, runCount,
        // nextRunAt, status) when the gateway includes the updated row.
        if (c.task) store.upsertSchedule(c.task as unknown as Parameters<typeof store.upsertSchedule>[0]);
      }
      break;
    }
    case 'pong':
      if (ctx.getHealthCheckId() && msg.id === ctx.getHealthCheckId()) {
        ctx.setWsReady(true);
        ctx.clearHealthCheck();
        useConnectionStore.getState().setGatewayConnected(true);
        ctx.flush();
      }
      break;
    case 'file_content': {
      const cb = ctx.fileReadCallbacks.get(msg.id);
      if (cb) {
        ctx.fileReadCallbacks.delete(msg.id);
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
    case 'session_status': {
      // Live burn-rate snapshot ($/hr + spend series + cap status) — Task #245.
      // `burnRate` rides on the message via the contract's `.passthrough()`, so
      // it isn't on the inferred `ServerMessage` type — read it defensively.
      const burnRate = (msg as { burnRate?: BurnRateSnapshot | null }).burnRate;
      if (burnRate !== undefined) {
        useChatStore.getState().setBurnRate(burnRate ?? null);
      }
      break;
    }
    default:
      console.debug('[gateway] unhandled message type:', msg.type, msg);
  }
}

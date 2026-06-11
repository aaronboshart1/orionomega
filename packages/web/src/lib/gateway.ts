'use client';

/**
 * @module gateway
 * Thin WebSocket client orchestrator for the gateway connection. Owns the
 * singleton socket lifecycle (connect, reconnect, init/ping handshake, outbound
 * send queue) and the React `useGateway` hook. The heavy lifting lives in
 * focused sibling modules:
 *   - `gateway/connection-utils`   — URL builder + small pure helpers
 *   - `gateway/event-handlers`     — server → client message dispatch
 *   - `gateway/snapshot-processor` — history/snapshot state reconciliation
 *   - `gateway/logs-client`        — typed /api/logs wrappers (re-exported here)
 */

import { useEffect, useCallback } from 'react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import type { ServerMessage } from '@orionomega/shared/ws-contract';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';
import { useConnectionStore } from '@/stores/connection';
import { useAgentModeStore } from '@/stores/agent-mode';
import type { FileAttachment } from '@/components/chat/ChatInput';
import { uuid } from '@/lib/uuid';
import { isImageType, isBinaryDocument } from '@/lib/file-types';
import { SESSION_KEY, getGatewayUrl } from '@/lib/gateway/connection-utils';
import { recoverGap } from '@/lib/gateway/snapshot-processor';
import { handleServerMessage, type MessageHandlerContext } from '@/lib/gateway/event-handlers';

// Re-export the logs client as part of the public `@/lib/gateway` API so the
// Logs pane and other consumers keep importing from one place.
export * from '@/lib/gateway/logs-client';

let statusFetchController: AbortController | null = null;

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

/** Track reconnect attempts for exponential backoff status reporting. */
let reconnectAttemptCount = 0;
/** Whether we've received a session snapshot (init protocol completed). */
let initAcked = false;

const fileReadCallbacks = new Map<string, (msg: ServerMessage) => void>();

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
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(entry.data);
      } catch (err) {
        console.warn('[gateway] Failed to flush queued message', err);
        // Re-queue the unsent remainder (including this one) and bail.
        pendingMessages.unshift(...toFlush.slice(i));
        surfaceDeliveryFailure();
        return;
      }
    } else {
      // Socket closed mid-flush — re-queue the remainder.
      pendingMessages.unshift(...toFlush.slice(i));
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

  // Mutable connection-state bridge handed to the message handler so it can
  // drive the singleton's lifecycle without owning it.
  const ctx: MessageHandlerContext = {
    flush: () => flushPendingMessages(ws),
    setWsReady: (v) => { wsReady = v; },
    setInitAcked: (v) => { initAcked = v; },
    resetReconnectCount: () => { reconnectAttemptCount = 0; },
    getHealthCheckId: () => healthCheckId,
    clearHealthCheck: () => {
      healthCheckId = null;
      if (healthCheckTimer) { clearTimeout(healthCheckTimer); healthCheckTimer = null; }
    },
    setPendingRestart: (v) => { pendingRestart = v; },
    fileReadCallbacks,
    replay: (ev) => { if (ws.onmessage) ws.onmessage(ev); },
  };

  ws.onmessage = (raw) => {
    let msg: ServerMessage;
    try {
      // Handle compressed messages (binary frames with 'ZLIB' magic prefix).
      // The gateway compresses messages >64KB to reduce bandwidth.
      if (raw.data instanceof ArrayBuffer || raw.data instanceof Blob) {
        // Binary frame — check for ZLIB compression prefix
        const decompress = async (
          compressed: Uint8Array,
          format: 'deflate-raw' | 'deflate',
        ): Promise<string> => {
          const ds = new DecompressionStream(format);
          // Drain the readable side CONCURRENTLY with feeding the writable
          // side. If we awaited write() before starting to read, web-streams
          // backpressure could stall write() forever on large (>64KB) frames
          // — the gateway compresses messages above that threshold, so the
          // common case would deadlock. Starting the read first lets data
          // flow through.
          const textPromise = new Response(ds.readable).text();
          const writer = ds.writable.getWriter();
          const writePromise = (async () => {
            await writer.write(compressed as BufferSource);
            await writer.close();
          })();
          // Promise.all attaches handlers to BOTH promises before either can
          // reject, so neither becomes an unhandled rejection — which would
          // otherwise propagate up and (in some browsers) tear down the WS.
          const [, text] = await Promise.all([writePromise, textPromise]);
          return text;
        };

        const handleBinary = async (data: ArrayBuffer | Blob) => {
          const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
          const bytes = new Uint8Array(buffer);
          // Check for 'ZLIB' magic prefix (0x5A 0x4C 0x49 0x42)
          if (bytes.length > 4 && bytes[0] === 0x5A && bytes[1] === 0x4C && bytes[2] === 0x49 && bytes[3] === 0x42) {
            // Try `deflate-raw` first (current gateway format — RFC 1951, no
            // zlib header). Fall back to `deflate` (RFC 1950, zlib-wrapped)
            // for resilience against gateway/web version mismatch where the
            // gateway is still running the older `deflateSync` build.
            // `deflate-raw` is what avoids Safari's "Extra bytes past the end"
            // bug on the zlib trailer; the fallback is just a safety net.
            const compressed = bytes.slice(4);
            let json: string;
            try {
              json = await decompress(compressed, 'deflate-raw');
            } catch (rawErr) {
              try {
                json = await decompress(compressed, 'deflate');
                console.warn('[gateway] WS binary frame used legacy zlib format — gateway and web bundle versions may be out of sync. Run `orionomega update --clean` and hard-refresh.');
              } catch (zlibErr) {
                const head = Array.from(compressed.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
                console.error('[gateway] Failed to decompress WS binary frame in either format', {
                  rawError: rawErr instanceof Error ? rawErr.message : String(rawErr),
                  zlibError: zlibErr instanceof Error ? zlibErr.message : String(zlibErr),
                  byteLength: compressed.length,
                  head,
                });
                return; // Drop this frame but keep the WS alive.
              }
            }
            // Validate JSON, then re-dispatch as a synthetic text event.
            try {
              JSON.parse(json);
            } catch (parseErr) {
              console.error('[gateway] Decompressed WS frame is not valid JSON', parseErr);
              return;
            }
            const synthetic = new MessageEvent('message', { data: json });
            if (ws.onmessage) ws.onmessage(synthetic);
            return;
          }
          // Not compressed — try parsing as UTF-8 JSON
          const text = new TextDecoder().decode(bytes);
          try {
            JSON.parse(text);
          } catch (parseErr) {
            console.warn('[gateway] Received non-JSON binary WS frame, ignoring', parseErr);
            return;
          }
          const synthetic = new MessageEvent('message', { data: text });
          if (ws.onmessage) ws.onmessage(synthetic);
        };
        handleBinary(raw.data).catch((err) => {
          console.warn('[gateway] Failed to handle binary WebSocket message', err);
        });
        return;
      }

      msg = JSON.parse(raw.data as string) as ServerMessage;
    } catch {
      console.warn('[gateway] Received non-JSON WebSocket message, ignoring');
      return;
    }

    handleServerMessage(msg, ctx);
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
            id: uuid(),
            type: 'client_state',
            clientState: {
              agentMode: useAgentModeStore.getState().mode,
              lastSeenSeq: useConnectionStore.getState().lastSeenSeq,
              activePanel: useOrchestrationStore.getState().activeOrchTab,
            },
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
        // Surface stale-build status from the gateway so the header can show
        // a "rebuild required" indicator. We pull the short-commit fields
        // defensively because older gateway builds (pre this fix) won't emit
        // the `build` block at all. Note: this is intentionally NOT gated on
        // `gatewayConnected` — the WS session ack may not have landed yet
        // when /api/status returns (we kicked it off in `onopen`), and
        // dropping a stale-build payload here means the badge would never
        // appear until the next reconnect. The /status data is authoritative
        // about the gateway we just reached, so always apply it.
        if (data?.build) {
          const b = data.build as {
            isStale?: boolean;
            reason?: string;
            builtDirty?: boolean;
            gateway?: { shortCommit?: string };
            core?: { shortCommit?: string };
            sourceShortCommit?: string | null;
          };
          useConnectionStore.getState().setStaleBuild({
            isStale: !!b.isStale,
            reason: b.reason ?? '',
            builtDirty: !!b.builtDirty,
            gatewayShortCommit: b.gateway?.shortCommit,
            coreShortCommit: b.core?.shortCommit,
            sourceShortCommit: b.sourceShortCommit ?? null,
          });
        } else if (data) {
          // Mixed-version deployment: the gateway responded successfully but
          // doesn't yet emit the `build` block (i.e. it predates this fix).
          // Clear any prior stale-build state so a leftover badge from an
          // earlier session doesn't stick around forever — we have no way to
          // verify staleness here, so the safer default is "unknown / OK".
          useConnectionStore.getState().setStaleBuild({
            isStale: false,
            reason: '',
            builtDirty: false,
            sourceShortCommit: null,
          });
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

  // Handle browser back/forward navigation — switch session when URL ?session param changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handlePopState = () => {
      const urlParams = new URLSearchParams(window.location.search);
      const sessionFromUrl = urlParams.get('session');
      const currentSession = useConnectionStore.getState().sessionId;
      if (sessionFromUrl && sessionFromUrl !== currentSession) {
        switchToSession(sessionFromUrl);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
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
            // Binary formats (images + PDF/DOCX/XLSX/PPTX) are sent as base64 DataURLs.
            // Text-based files are sent as UTF-8 text.
            if (isImageType(a.type) || isBinaryDocument(a.type)) {
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

  const respondToGate = useCallback(
    (gateId: string, approved: boolean) => {
      send({
        id: uuid(),
        type: 'gate_response',
        gateId,
        gateAction: approved ? 'approve' : 'deny',
      });
      useOrchestrationStore.getState().resolvePendingGate(gateId, approved ? 'approved' : 'denied');
    },
    [send],
  );

  const submitIntervention = useCallback(
    (interventionId: string, nodeId: string, input: string) => {
      send({
        id: uuid(),
        type: 'intervention_response',
        interventionId,
        interventionInput: input,
      });
      // Optimistically mark resolved so the panel reflects submission immediately.
      useOrchestrationStore.getState().resolvePendingIntervention(nodeId);
    },
    [send],
  );

  const sendFeedback = useCallback(
    (messageId: string, value: 'good' | 'bad' | null) => {
      send({ id: uuid(), type: 'feedback', feedbackPayload: { messageId, value } });
    },
    [send],
  );

  return { send, sendChat, sendCommand, sendWorkflowCommand, sendFeedback, respondToPlan, respondToDAG, respondToConfirmation, respondToGate, submitIntervention };
}

/**
 * Switch to a different session.
 *
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
  // Reflect the session in the URL so it's bookmarkable
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('session', newSessionId);
    history.pushState(null, '', url.toString());
  } catch { /* ignore */ }
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

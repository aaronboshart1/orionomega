/**
 * @module coding-events
 * Emitter functions for Coding Mode WebSocket lifecycle events.
 *
 * Usage:
 *   1. Call `setCodingEventStreamer(streamer)` once during server startup.
 *   2. Call the typed `emitCoding*` functions from the DAG engine, orchestrator,
 *      or any other module that drives a coding session.
 *
 * Each emitter sends a `coding_event` ServerMessage immediately to all connected
 * clients (never batched), scoped to `sessionId` when provided so clients that
 * have subscribed to a specific workflow receive the right events.
 */

import { randomBytes } from 'node:crypto';
import type { EventStreamer } from './events.js';
import type {
  CodingSessionStartedPayload,
  CodingWorkflowStartedPayload,
  CodingStepStartedPayload,
  CodingStepProgressPayload,
  CodingStepCompletedPayload,
  CodingStepFailedPayload,
  CodingReviewStartedPayload,
  CodingReviewCompletedPayload,
  CodingCommitCompletedPayload,
  CodingSessionCompletedPayload,
  CodingEventPayload,
} from './types.js';

// ── Streamer registry ─────────────────────────────────────────────────────────

let _streamer: EventStreamer | null = null;

/**
 * Register the EventStreamer instance that coding events should be sent through.
 * Must be called before any `emitCoding*` function is used.
 *
 * @param streamer - The gateway EventStreamer.
 */
export function setCodingEventStreamer(streamer: EventStreamer): void {
  _streamer = streamer;
}

// ── Internal helper ───────────────────────────────────────────────────────────

/**
 * Coding-session-id → gateway-session-id binding map.
 *
 * The legacy `CodingOrchestrator` mints its own internal `sessionId` (UUID)
 * which is *not* the same as the gateway session that originated the
 * request. Without an explicit binding the streamer cannot scope subsequent
 * step/review/commit events to the correct gateway session, so they leak
 * across sessions.
 *
 * Callers (gateway server) populate this map at coding-session start via
 * {@link bindCodingSessionToGatewaySession} and threadthe coding sessionId
 * through every emit call so the resolver works correctly even with
 * concurrent coding sessions across gateway sessions.
 */
const codingSessionToGatewaySession = new Map<string, string>();

/**
 * Bind a coding-orchestrator sessionId to the originating gateway sessionId.
 * Should be called by the gateway when a coding session is dispatched, so
 * subsequent legacy `coding:*` events can be filtered per-session.
 */
export function bindCodingSessionToGatewaySession(
  codingSessionId: string,
  gatewaySessionId: string,
): void {
  codingSessionToGatewaySession.set(codingSessionId, gatewaySessionId);
}

/** Drop a coding-session binding (call on session completion/failure). */
export function unbindCodingSession(codingSessionId: string): void {
  codingSessionToGatewaySession.delete(codingSessionId);
}

/**
 * Resolve the gateway sessionId for a coding event. Prefers explicit
 * codingSessionId threading via the binding map, then payload-derived
 * coding sessionId for events that carry one. Returns undefined if no
 * mapping is found — callers MUST always pass a codingSessionId for
 * concurrent-correct routing.
 */
function resolveGatewaySession(
  codingEvent: CodingEventPayload,
  codingSessionId?: string,
): string | undefined {
  // Explicit threading wins (correct under concurrent coding sessions).
  if (codingSessionId) {
    const bound = codingSessionToGatewaySession.get(codingSessionId);
    if (bound) return bound;
  }
  // Fallback: payload-carried coding sessionId for the two events that
  // carry one. Other event types must always supply codingSessionId
  // explicitly via the emit caller; otherwise we return undefined and
  // the streamer will not deliver to any per-session client.
  if (codingEvent.type === 'coding:session:started') {
    const bound = codingSessionToGatewaySession.get(codingEvent.payload.sessionId);
    if (bound) return bound;
  }
  if (codingEvent.type === 'coding:workflow:started') {
    const bound = codingSessionToGatewaySession.get(codingEvent.payload.workflowId);
    if (bound) return bound;
  }
  return undefined;
}

/**
 * Extract a real workflowId from the coding event payload when one exists.
 * Only `coding:workflow:started` carries an explicit `workflowId`; other
 * events are scoped to the originating session via the resolver above.
 */
function extractWorkflowId(codingEvent: CodingEventPayload): string | undefined {
  if (codingEvent.type === 'coding:workflow:started') {
    return codingEvent.payload.workflowId;
  }
  return undefined;
}

function emit(codingEvent: CodingEventPayload, codingSessionId?: string): void {
  if (!_streamer) return;
  _streamer.emitDAGMessage(
    {
      id: randomBytes(8).toString('hex'),
      type: 'coding_event',
      workflowId: extractWorkflowId(codingEvent),
      codingEvent,
    },
    resolveGatewaySession(codingEvent, codingSessionId),
  );
}

// ── Public emitter functions ──────────────────────────────────────────────────

/**
 * NOTE on the second `codingSessionId` argument:
 * Pass the CodingOrchestrator's internal sessionId (the UUID it minted
 * in `run()`/`start()`). The gateway sessionId is resolved by looking
 * the codingSessionId up in the binding map populated by
 * {@link bindCodingSessionToGatewaySession}. Threading codingSessionId
 * through every emit call is REQUIRED for correct routing under
 * concurrent coding sessions across gateway sessions.
 */

/** Emit `coding:session:started` — when a coding session begins. */
export function emitCodingSessionStarted(
  payload: CodingSessionStartedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:session:started', payload }, codingSessionId);
}

/** Emit `coding:workflow:started` — when the DAG workflow starts executing. */
export function emitCodingWorkflowStarted(
  payload: CodingWorkflowStartedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:workflow:started', payload }, codingSessionId);
}

/** Emit `coding:step:started` — when a workflow node begins execution. */
export function emitCodingStepStarted(
  payload: CodingStepStartedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:step:started', payload }, codingSessionId);
}

/** Emit `coding:step:progress` — progress update during step execution. */
export function emitCodingStepProgress(
  payload: CodingStepProgressPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:step:progress', payload }, codingSessionId);
}

/** Emit `coding:step:completed` — when a step finishes successfully. */
export function emitCodingStepCompleted(
  payload: CodingStepCompletedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:step:completed', payload }, codingSessionId);
}

/** Emit `coding:step:failed` — when a step fails. */
export function emitCodingStepFailed(
  payload: CodingStepFailedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:step:failed', payload }, codingSessionId);
}

/** Emit `coding:review:started` — when architect review begins. */
export function emitCodingReviewStarted(
  payload: CodingReviewStartedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:review:started', payload }, codingSessionId);
}

/** Emit `coding:review:completed` — with architect review results. */
export function emitCodingReviewCompleted(
  payload: CodingReviewCompletedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:review:completed', payload }, codingSessionId);
}

/** Emit `coding:commit:completed` — when code is committed and pushed. */
export function emitCodingCommitCompleted(
  payload: CodingCommitCompletedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:commit:completed', payload }, codingSessionId);
}

/** Emit `coding:session:completed` — when the entire coding session finishes. */
export function emitCodingSessionCompleted(
  payload: CodingSessionCompletedPayload,
  codingSessionId?: string,
): void {
  emit({ type: 'coding:session:completed', payload }, codingSessionId);
}

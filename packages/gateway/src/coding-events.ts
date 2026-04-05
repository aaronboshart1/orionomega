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

function emit(codingEvent: CodingEventPayload, sessionId?: string): void {
  if (!_streamer) return;
  _streamer.emitDAGMessage({
    id: randomBytes(8).toString('hex'),
    type: 'coding_event',
    workflowId: sessionId,
    codingEvent,
  });
}

// ── Public emitter functions ──────────────────────────────────────────────────

/**
 * Emit `coding:session:started` — when a coding session begins.
 *
 * @param payload - Repo URL, branch, and session ID.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingSessionStarted(
  payload: CodingSessionStartedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:session:started', payload }, sessionId);
}

/**
 * Emit `coding:workflow:started` — when the DAG workflow starts executing.
 *
 * @param payload - Workflow ID, template name, and node count.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingWorkflowStarted(
  payload: CodingWorkflowStartedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:workflow:started', payload }, sessionId);
}

/**
 * Emit `coding:step:started` — when a workflow node begins execution.
 *
 * @param payload - Node ID, label, and coding role type.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingStepStarted(
  payload: CodingStepStartedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:step:started', payload }, sessionId);
}

/**
 * Emit `coding:step:progress` — progress update during step execution.
 *
 * @param payload - Node ID, message, and 0–100 percentage.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingStepProgress(
  payload: CodingStepProgressPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:step:progress', payload }, sessionId);
}

/**
 * Emit `coding:step:completed` — when a step finishes successfully.
 *
 * @param payload - Node ID, status, and output summary.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingStepCompleted(
  payload: CodingStepCompletedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:step:completed', payload }, sessionId);
}

/**
 * Emit `coding:step:failed` — when a step fails.
 *
 * @param payload - Node ID and error message.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingStepFailed(
  payload: CodingStepFailedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:step:failed', payload }, sessionId);
}

/**
 * Emit `coding:review:started` — when architect review begins.
 *
 * @param payload - 1-indexed iteration number.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingReviewStarted(
  payload: CodingReviewStartedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:review:started', payload }, sessionId);
}

/**
 * Emit `coding:review:completed` — with architect review results.
 *
 * @param payload - Decision, feedback text, and optional metrics.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingReviewCompleted(
  payload: CodingReviewCompletedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:review:completed', payload }, sessionId);
}

/**
 * Emit `coding:commit:completed` — when code is committed and pushed.
 *
 * @param payload - Commit hash and branch name.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingCommitCompleted(
  payload: CodingCommitCompletedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:commit:completed', payload }, sessionId);
}

/**
 * Emit `coding:session:completed` — when the entire coding session finishes.
 *
 * @param payload - Summary, modified/created file lists, and total duration.
 * @param sessionId - Optional workflow/session ID to scope delivery.
 */
export function emitCodingSessionCompleted(
  payload: CodingSessionCompletedPayload,
  sessionId?: string,
): void {
  emit({ type: 'coding:session:completed', payload }, sessionId);
}

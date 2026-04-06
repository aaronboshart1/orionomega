/**
 * @module @orionomega/gateway
 * Re-exports for programmatic use of the gateway package.
 */

// Types
export type {
  ClientConnection,
  ClientMessage,
  ServerMessage,
  SystemStatus,
  WorkflowSummary,
  CommandResult,
  GatewayConfig,
  // Coding Mode event types
  CodingEventType,
  CodingEventPayload,
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
} from './types.js';

// Sessions
export { SessionManager } from './sessions.js';
export type { Session, Message } from './sessions.js';

// Auth
export { generateToken, validateToken, hashPassword, verifyPassword } from './auth.js';

// Events
export { EventStreamer } from './events.js';

// Coding Mode event emitters
export {
  setCodingEventStreamer,
  emitCodingSessionStarted,
  emitCodingWorkflowStarted,
  emitCodingStepStarted,
  emitCodingStepProgress,
  emitCodingStepCompleted,
  emitCodingStepFailed,
  emitCodingReviewStarted,
  emitCodingReviewCompleted,
  emitCodingCommitCompleted,
  emitCodingSessionCompleted,
} from './coding-events.js';

// Commands
export { CommandHandler } from './commands.js';

// WebSocket
export { WebSocketHandler } from './websocket.js';

// Server-side state store (SQLite-backed)
export { ServerSessionStore } from './state-store.js';
export type {
  StateEvent,
  StateEventType,
  StateEventQuery,
  PaginatedResult,
  DAGState,
  DAGNodeState,
  SessionCosts,
  PendingAction,
  CodingSessionState,
  StateSnapshot,
} from './state-types.js';

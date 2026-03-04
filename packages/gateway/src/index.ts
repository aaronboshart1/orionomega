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
} from './types.js';

// Sessions
export { SessionManager } from './sessions.js';
export type { Session, Message } from './sessions.js';

// Auth
export { generateToken, validateToken, hashPassword, verifyPassword } from './auth.js';

// Events
export { EventStreamer } from './events.js';

// Commands
export { CommandHandler } from './commands.js';

// WebSocket
export { WebSocketHandler } from './websocket.js';

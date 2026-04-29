/**
 * @module db
 * Public API for the Coding Mode database layer.
 *
 * Usage:
 *   import { getDb, closeDb } from '@orionomega/core/db';
 *   import type { CodingSession, NewCodingSession } from '@orionomega/core/db';
 */

// Schema (Drizzle table definitions — needed for query building)
export {
  architectReviews,
  clientState,
  codingSessions,
  events,
  memoryEvents,
  messages,
  runHistory,
  scheduledTasks,
  sessions,
  taskExecutions,
  workflowEvents,
  workflowExecutions,
  workflows,
  workflowSteps,
} from './schema.js';

// Model types
export type {
  ArchitectReview,
  BuildTestStatus,
  ClientState,
  CodingSession,
  CodingSessionStatus,
  CodingSessionWithExecutions,
  Event,
  ExecutionStatus,
  ExecutionTriggerType,
  MemoryEvent,
  Message,
  NewArchitectReview,
  NewClientState,
  NewCodingSession,
  NewEvent,
  NewMemoryEvent,
  NewMessage,
  NewRunHistory,
  NewScheduledTask,
  NewSession,
  NewTaskExecution,
  NewWorkflow,
  NewWorkflowEvent,
  NewWorkflowExecution,
  NewWorkflowStep,
  OverlapPolicy,
  ReviewDecision,
  RunHistory,
  ScheduleAgentMode,
  ScheduleStatus,
  ScheduledTask,
  Session,
  TaskExecution,
  Workflow,
  WorkflowEvent,
  WorkflowExecution,
  WorkflowExecutionStatus,
  WorkflowExecutionWithSteps,
  WorkflowStep,
  WorkflowStepStatus,
} from './models.js';

// Database client
export type { CodingDb } from './client.js';
export { closeDb, getDb } from './client.js';

// Migration runner (exposed for CLI/test usage)
export { runMigrations } from './migrate.js';

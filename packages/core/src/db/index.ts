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
  codingSessions,
  workflowExecutions,
  workflowSteps,
} from './schema.js';

// Model types
export type {
  ArchitectReview,
  BuildTestStatus,
  CodingSession,
  CodingSessionStatus,
  CodingSessionWithExecutions,
  NewArchitectReview,
  NewCodingSession,
  NewWorkflowExecution,
  NewWorkflowStep,
  ReviewDecision,
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

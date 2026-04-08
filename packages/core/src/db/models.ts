/**
 * @module db/models
 * TypeScript model types derived from the Drizzle schema.
 *
 * `Select` types represent rows as read from the database.
 * `Insert` types represent rows as written to the database (id/timestamps optional).
 *
 * Re-export the literal union types so callers can reference them without
 * importing from schema directly.
 */

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type {
  architectReviews,
  clientState,
  codingSessions,
  events,
  memoryEvents,
  messages,
  runHistory,
  sessions,
  workflowEvents,
  workflowExecutions,
  workflows,
  workflowSteps,
} from './schema.js';

// ── CodingSession ─────────────────────────────────────────────────────────────

/** Row as returned by SELECT on coding_sessions. */
export type CodingSession = InferSelectModel<typeof codingSessions>;

/** Row shape for INSERT into coding_sessions. */
export type NewCodingSession = InferInsertModel<typeof codingSessions>;

/** Valid values for CodingSession.status. */
export type CodingSessionStatus = 'pending' | 'running' | 'completed' | 'failed';

// ── WorkflowExecution ─────────────────────────────────────────────────────────

/** Row as returned by SELECT on workflow_executions. */
export type WorkflowExecution = InferSelectModel<typeof workflowExecutions>;

/** Row shape for INSERT into workflow_executions. */
export type NewWorkflowExecution = InferInsertModel<typeof workflowExecutions>;

/** Valid values for WorkflowExecution.status. */
export type WorkflowExecutionStatus = 'pending' | 'running' | 'completed' | 'failed';

// ── WorkflowStep ──────────────────────────────────────────────────────────────

/** Row as returned by SELECT on workflow_steps. */
export type WorkflowStep = InferSelectModel<typeof workflowSteps>;

/** Row shape for INSERT into workflow_steps. */
export type NewWorkflowStep = InferInsertModel<typeof workflowSteps>;

/** Valid values for WorkflowStep.status. */
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// ── ArchitectReview ───────────────────────────────────────────────────────────

/** Row as returned by SELECT on architect_reviews. */
export type ArchitectReview = InferSelectModel<typeof architectReviews>;

/** Row shape for INSERT into architect_reviews. */
export type NewArchitectReview = InferInsertModel<typeof architectReviews>;

/** Valid values for ArchitectReview.buildStatus / testStatus. */
export type BuildTestStatus = 'pass' | 'fail' | 'skip';

/** Valid values for ArchitectReview.decision. */
export type ReviewDecision = 'approve' | 'retask';

// ── Unified Persistence Tables ────────────────────────────────────────────────

export type Session = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;

export type Event = InferSelectModel<typeof events>;
export type NewEvent = InferInsertModel<typeof events>;

export type Message = InferSelectModel<typeof messages>;
export type NewMessage = InferInsertModel<typeof messages>;

export type Workflow = InferSelectModel<typeof workflows>;
export type NewWorkflow = InferInsertModel<typeof workflows>;

export type WorkflowEvent = InferSelectModel<typeof workflowEvents>;
export type NewWorkflowEvent = InferInsertModel<typeof workflowEvents>;

export type MemoryEvent = InferSelectModel<typeof memoryEvents>;
export type NewMemoryEvent = InferInsertModel<typeof memoryEvents>;

export type RunHistory = InferSelectModel<typeof runHistory>;
export type NewRunHistory = InferInsertModel<typeof runHistory>;

export type ClientState = InferSelectModel<typeof clientState>;
export type NewClientState = InferInsertModel<typeof clientState>;

// ── Composite helpers ─────────────────────────────────────────────────────────

/** A workflow execution with its steps pre-joined (for display/serialisation). */
export interface WorkflowExecutionWithSteps extends WorkflowExecution {
  steps: WorkflowStep[];
}

/** A coding session with its executions pre-joined. */
export interface CodingSessionWithExecutions extends CodingSession {
  executions: WorkflowExecution[];
}

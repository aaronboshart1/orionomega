/**
 * @module db/schema
 * Drizzle ORM schema definitions for Coding Mode persistence.
 *
 * Four tables track the full lifecycle of a coding session:
 *   coding_sessions       → top-level session (one per user request)
 *   workflow_executions   → DAG execution run (may retry multiple times)
 *   workflow_steps        → individual node execution within a DAG run
 *   architect_reviews     → review gate result after each validation cycle
 */

import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ── CodingSession ─────────────────────────────────────────────────────────────

/**
 * Tracks a Coding Mode session from request to completion.
 * One session is created per user coding request. A session may spawn
 * multiple workflow executions (e.g. on retask/retry).
 */
export const codingSessions = sqliteTable('coding_sessions', {
  /** UUID v4 primary key. */
  id: text('id').primaryKey(),

  /** Gateway conversation ID that spawned this session. */
  conversationId: text('conversation_id').notNull(),

  /** Repository URL (e.g. https://github.com/org/repo or file:///local/path). */
  repoUrl: text('repo_url').notNull(),

  /** Git branch name to check out and work against. */
  branch: text('branch').notNull(),

  /** Absolute path to the on-disk workspace directory for this session. */
  workspacePath: text('workspace_path').notNull(),

  /** Lifecycle status of this session. */
  status: text('status')
    .$type<'pending' | 'running' | 'completed' | 'failed'>()
    .notNull()
    .default('pending'),

  /** ISO 8601 creation timestamp. */
  createdAt: text('created_at').notNull(),

  /** ISO 8601 timestamp of last status change. */
  updatedAt: text('updated_at').notNull(),
});

// ── WorkflowExecution ─────────────────────────────────────────────────────────

/**
 * Tracks a single DAG workflow execution within a coding session.
 * A session may have multiple executions when the architect retasks.
 */
export const workflowExecutions = sqliteTable('workflow_executions', {
  /** UUID v4 primary key. */
  id: text('id').primaryKey(),

  /** Parent coding session. */
  codingSessionId: text('coding_session_id')
    .notNull()
    .references(() => codingSessions.id, { onDelete: 'cascade' }),

  /**
   * Full DAG definition serialised as JSON.
   * Shape: WorkflowGraph (see orchestration/types.ts).
   */
  dagDefinition: text('dag_definition').notNull(),

  /** Execution status. */
  status: text('status')
    .$type<'pending' | 'running' | 'completed' | 'failed'>()
    .notNull()
    .default('pending'),

  /** ISO 8601 timestamp when execution started (null until first step runs). */
  startedAt: text('started_at'),

  /** ISO 8601 timestamp when execution finished (null while running). */
  completedAt: text('completed_at'),

  /** Error message if status='failed', otherwise null. */
  error: text('error'),
});

// ── WorkflowStep ──────────────────────────────────────────────────────────────

/**
 * Tracks execution of a single DAG node within a workflow execution.
 * One row per node per execution run.
 */
export const workflowSteps = sqliteTable('workflow_steps', {
  /** UUID v4 primary key. */
  id: text('id').primaryKey(),

  /** Parent workflow execution. */
  workflowExecutionId: text('workflow_execution_id')
    .notNull()
    .references(() => workflowExecutions.id, { onDelete: 'cascade' }),

  /** Node ID as defined in the DAG definition. */
  nodeId: text('node_id').notNull(),

  /** Node type (e.g. CODING_AGENT, TOOL, ROUTER). */
  nodeType: text('node_type').notNull(),

  /** Human-readable label for this node. */
  label: text('label').notNull(),

  /** Node execution status. */
  status: text('status')
    .$type<'pending' | 'running' | 'completed' | 'failed' | 'skipped'>()
    .notNull()
    .default('pending'),

  /**
   * Input passed to this node, serialised as JSON.
   * Shape depends on nodeType; null if not yet started.
   */
  input: text('input'),

  /**
   * Output produced by this node, serialised as JSON.
   * Shape depends on nodeType; null until completed.
   */
  output: text('output'),

  /** ISO 8601 timestamp when this step started. */
  startedAt: text('started_at'),

  /** ISO 8601 timestamp when this step finished. */
  completedAt: text('completed_at'),

  /** Error message if status='failed', otherwise null. */
  error: text('error'),

  /**
   * Upstream node IDs this step depends on, serialised as a JSON string array.
   * Example: '["scan","architect"]'
   */
  dependsOn: text('depends_on').notNull().default('[]'),
});

// ── ArchitectReview ───────────────────────────────────────────────────────────

/**
 * Records the outcome of an architect review gate.
 * One row is written per review cycle iteration within a workflow execution.
 */
export const architectReviews = sqliteTable('architect_reviews', {
  /** UUID v4 primary key. */
  id: text('id').primaryKey(),

  /** Parent workflow execution. */
  workflowExecutionId: text('workflow_execution_id')
    .notNull()
    .references(() => workflowExecutions.id, { onDelete: 'cascade' }),

  /** Review iteration number (starts at 1, increments on retask). */
  iteration: integer('iteration').notNull(),

  /** Build command outcome for this iteration. */
  buildStatus: text('build_status')
    .$type<'pass' | 'fail' | 'skip'>()
    .notNull(),

  /** Test suite outcome for this iteration. */
  testStatus: text('test_status')
    .$type<'pass' | 'fail' | 'skip'>()
    .notNull(),

  /** Normalised code quality score 0–100 (null if not computed). */
  codeQualityScore: real('code_quality_score'),

  /** Architect's gate decision. 'approve' advances; 'retask' loops back. */
  decision: text('decision')
    .$type<'approve' | 'retask'>()
    .notNull(),

  /** Detailed feedback from the architect, used as retask instructions. */
  feedback: text('feedback').notNull(),

  /** ISO 8601 timestamp when the review was recorded. */
  reviewedAt: text('reviewed_at').notNull(),
});

// ── Unified Persistence Tables ─────────────────────────────────────────────────

/** Gateway session (one per user conversation). */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  name: text('name'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  model: text('model'),
  agentMode: text('agent_mode').$type<'orchestrate' | 'direct' | 'code'>(),
  totalCostUsd: real('total_cost_usd'),
  totalInputTokens: integer('total_input_tokens'),
  totalOutputTokens: integer('total_output_tokens'),
});

/** Ordered event log for a session. seq is auto-incremented by SQLite. */
export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  timestamp: text('timestamp').notNull(),
  eventType: text('event_type').notNull(),
  workflowId: text('workflow_id'),
  payload: text('payload'), // JSON
});

/** Chat messages within a session. */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  metadata: text('metadata'), // JSON
  replyToId: text('reply_to_id'),
  attachments: text('attachments'), // JSON
  status: text('status'),
});

/** DAG workflow runs within a session. */
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  name: text('name'),
  status: text('status'),
  template: text('template'),
  nodeCount: integer('node_count'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  durationSec: real('duration_sec'),
  costUsd: real('cost_usd'),
  summary: text('summary'),
  graphState: text('graph_state'), // JSON
  /** ID of the chat message that triggered this workflow run. */
  triggeringMessageId: text('triggering_message_id'),
});

/** Per-node events emitted during a workflow run. */
export const workflowEvents = sqliteTable('workflow_events', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  eventType: text('event_type').notNull(),
  nodeId: text('node_id'),
  payload: text('payload'), // JSON
});

/** Memory bank operations recorded during a session. */
export const memoryEvents = sqliteTable('memory_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  op: text('op').notNull(),
  detail: text('detail'),
  bank: text('bank'),
  meta: text('meta'), // JSON
});

/** Summary of each agent run (workflow or direct). */
export const runHistory = sqliteTable('run_history', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'cascade' }),
  model: text('model'),
  durationSec: real('duration_sec'),
  costUsd: real('cost_usd'),
  workerCount: integer('worker_count'),
  modelUsage: text('model_usage'), // JSON
  toolCallCount: integer('tool_call_count'),
});

/** Per-client UI state that survives reconnects. */
export const clientState = sqliteTable(
  'client_state',
  {
    clientId: text('client_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentMode: text('agent_mode').$type<'orchestrate' | 'direct' | 'code'>(),
    scrollPosition: integer('scroll_position'),
    activePanel: text('active_panel'),
    lastSeenSeq: integer('last_seen_seq'),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.sessionId] })],
);

// ── Scheduled Tasks ──────────────────────────────────────────────────────────

/**
 * Persisted schedule definitions for recurring/one-time agent task execution.
 * Mounted in-process by the gateway's SchedulerService at startup; survives
 * restarts via this table.
 */
export const scheduledTasks = sqliteTable('scheduled_tasks', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  cronExpr: text('cron_expr').notNull(),
  prompt: text('prompt').notNull(),
  agentMode: text('agent_mode')
    .$type<'orchestrate' | 'direct' | 'code'>()
    .notNull()
    .default('orchestrate'),
  sessionId: text('session_id').notNull().default('default'),
  status: text('status')
    .$type<'active' | 'paused' | 'deleted'>()
    .notNull()
    .default('active'),
  timezone: text('timezone').notNull().default('UTC'),
  overlapPolicy: text('overlap_policy')
    .$type<'skip' | 'queue' | 'allow'>()
    .notNull()
    .default('skip'),
  maxRetries: integer('max_retries').notNull().default(0),
  timeoutSec: integer('timeout_sec').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  lastStatus: text('last_status'),
  runCount: integer('run_count').notNull().default(0),
  runAt: text('run_at'),
});

/** Execution history for scheduled tasks. */
export const taskExecutions = sqliteTable('task_executions', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
  status: text('status')
    .$type<'running' | 'completed' | 'failed' | 'timeout' | 'skipped'>()
    .notNull()
    .default('running'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  durationSec: real('duration_sec'),
  error: text('error'),
  triggerType: text('trigger_type')
    .$type<'cron' | 'manual'>()
    .notNull()
    .default('cron'),
});

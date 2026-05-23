/**
 * @module orchestration/coding/ux-types
 * User Experience Types — Section 9 of the system spec.
 *
 * Covers:
 *  - Progressive disclosure levels (1–4)
 *  - Real-time WebSocket streaming event types
 *  - Interactive approval workflow types
 *  - Undo/rollback session history
 *  - Confidence indicator (re-exported from coding-types.ts)
 *
 * Design principle: hide complexity by default (Level 1: single progress bar)
 * while making every layer inspectable on demand (up to Level 4: full diff).
 */

import type { ApprovalPackage, CodingProgressEvent } from './coding-types.js';

// ── Progressive Disclosure ────────────────────────────────────────────────────

/**
 * Progressive disclosure level — controls how much detail is shown in the UI.
 *
 * Level 1 — Intent Confirmation (always visible):
 *   "Understanding your request: 'Add JWT authentication'"
 *   Complexity: Medium  |  Template: feature-implementation
 *
 * Level 2 — Phase Progress (always visible):
 *   [=========>  ] 56%
 *   Phase: Implementing  |  Agents: 3/4  |  Cost: $1.24
 *
 * Level 3 — Agent Activity (expandable):
 *   > Agent impl-chunk-0 (sonnet): Writing auth middleware...
 *     - Read: src/middleware/index.ts
 *     - Edit: src/middleware/auth.ts
 *
 * Level 4 — Full Diff (collapsible):
 *   Complete unified diff with per-file annotations
 */
export type ProgressDisclosureLevel = 1 | 2 | 3 | 4;

/** Level 1 intent summary payload. */
export interface IntentSummary {
  /** One-line description of what the agent intends to do. */
  description: string;
  /** Complexity tier from intent classification. */
  complexity: 'trivial' | 'small' | 'medium' | 'large' | 'epic';
  /** Selected DAG template. */
  template: string;
  /** Estimated number of files to modify. */
  estimatedFileCount?: number;
}

/** Level 3 agent activity event — one per tool call or step. */
export interface AgentActivityEvent {
  /** Agent node ID (e.g. 'impl-chunk-0'). */
  agentId: string;
  /** Model assigned to this agent (e.g. 'claude-sonnet-4-6'). */
  model: string;
  /**
   * Tool call description:
   * - 'Read: src/middleware/index.ts'
   * - 'Edit: src/middleware/auth.ts (added JWT verification)'
   * - 'Bash: npm run build (success)'
   * - 'Waiting for file lock on src/types.ts...'
   */
  activity: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

// ── Real-Time WebSocket Streaming ─────────────────────────────────────────────

/**
 * Typed wrapper for all events streamed via WebSocket as NDJSON.
 * All events share a common envelope; the payload type is discriminated
 * by `eventType`.
 */
export interface StreamEvent<T = unknown> {
  /** Unique event ID (hex string). */
  id: string;
  /** Event type discriminator. */
  eventType: CodingStreamEventType;
  /** The coding session this event belongs to. */
  sessionId: string;
  /** ISO-8601 server-side timestamp. */
  timestamp: string;
  /** Event-specific payload. */
  data: T;
}

/** All possible coding-session WebSocket event types. */
export type CodingStreamEventType =
  | 'coding:progress'       // Phase progress update (CodingProgressEvent)
  | 'coding:agent:activity' // Level-3 agent tool activity (AgentActivityEvent)
  | 'coding:approval:gate'  // Approval gate triggered (ApprovalGateEvent)
  | 'coding:approval:resolved' // Approval gate resolved (ApprovalResolvedEvent)
  | 'coding:rollback:request'  // Rollback requested by user (RollbackRequestEvent)
  | 'coding:rollback:complete' // Rollback completed (RollbackCompleteEvent)
  | 'coding:escalation'     // Escalation signal (EscalationEvent)
  | 'coding:complete'       // Session completed (SessionCompleteEvent)
  | 'coding:error';         // Non-fatal error (ErrorEvent)

/** Union of all concrete coding stream event shapes. */
export type CodingStreamEvent =
  | StreamEvent<CodingProgressEvent>
  | StreamEvent<AgentActivityEvent>
  | StreamEvent<ApprovalGateEvent>
  | StreamEvent<ApprovalResolvedEvent>
  | StreamEvent<RollbackRequestEvent>
  | StreamEvent<RollbackCompleteEvent>
  | StreamEvent<SessionCompleteEvent>
  | StreamEvent<CodingErrorEvent>;

// ── Approval Workflow ─────────────────────────────────────────────────────────

/**
 * Emitted when the review-gate ROUTER blocks for human approval.
 * Triggers the Diff Review Modal in the frontend.
 */
export interface ApprovalGateEvent {
  /** The full approval package for the modal to display. */
  approvalPackage: ApprovalPackage;
  /** Timeout in seconds before the gate auto-expires (0 = no timeout). */
  timeoutSeconds: number;
}

/**
 * Possible actions a user can take in the Diff Review Modal.
 *
 * approve_all           — Commit and push all changes as-is.
 * approve_with_edits    — User modified specific files; commit the combination.
 * request_changes       — Provide feedback; agent generates targeted fixes.
 * reject                — Roll back all changes.
 */
export type UserApprovalAction =
  | { type: 'approve_all' }
  | { type: 'approve_with_edits'; editedFiles: string[] }
  | { type: 'request_changes'; feedback: string; targetFiles?: string[] }
  | { type: 'reject' };

/**
 * Full state of an interactive approval workflow for a coding session.
 * Persisted until the user resolves it or the session times out.
 */
export interface ApprovalWorkflow {
  /** Unique approval workflow ID. */
  workflowId: string;
  /** The coding session this approval belongs to. */
  sessionId: string;
  /** The approval package shown to the user. */
  package: ApprovalPackage;
  /** Current state of the workflow. */
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'expired';
  /** The action the user took (populated when status is not 'pending'). */
  userAction?: UserApprovalAction;
  /** ISO-8601 timestamp when the approval was requested. */
  requestedAt: string;
  /** ISO-8601 timestamp when the user resolved the workflow. */
  resolvedAt?: string;
  /**
   * Per-file approval overrides.
   * Key: file path. Value: true=accepted, false=rejected.
   * Populated when the user accepts/rejects individual files.
   */
  fileApprovals?: Record<string, boolean>;
  /** Inline comments added by the user for the fix agent. */
  inlineComments?: Array<{
    file: string;
    line: number;
    comment: string;
  }>;
}

/** Emitted when an approval workflow is resolved. */
export interface ApprovalResolvedEvent {
  workflowId: string;
  action: UserApprovalAction;
  resolvedAt: string;
}

// ── Rollback / Undo ───────────────────────────────────────────────────────────

/**
 * A single phase-boundary checkpoint in the session history.
 * Git checkpoints are created at each phase boundary so the user can roll
 * back to any prior state.
 *
 * Example session history:
 *  [1] Codebase scan completed
 *  [2] Architecture plan approved
 *  [3] Implementation chunks completed   ← current
 *  [4] Tests passing (pending approval)
 */
export interface SessionCheckpoint {
  /** 1-indexed position in the session history. */
  index: number;
  /** Human-readable phase label. */
  label: string;
  /** Git commit hash at this checkpoint. */
  commitHash: string;
  /** ISO-8601 timestamp when this checkpoint was created. */
  timestamp: string;
  /** Phase name at this checkpoint. */
  phase: string;
  /** Whether the user has already rolled back past this checkpoint. */
  rolledBack: boolean;
}

/**
 * Full undo/rollback history for a coding session.
 * Displayed as a timeline in the UI; each checkpoint has a "Rollback to here" button.
 */
export interface RollbackSession {
  /** The coding session ID. */
  sessionId: string;
  /** All phase-boundary checkpoints, in chronological order. */
  checkpoints: SessionCheckpoint[];
  /** Index of the checkpoint at the current position (0-based). */
  currentIndex: number;
}

/** Emitted by the client to request rollback to a specific checkpoint. */
export interface RollbackRequestEvent {
  /** Target checkpoint index (1-based, matching SessionCheckpoint.index). */
  targetCheckpointIndex: number;
  /** Specific files to revert (empty = revert all changed files). */
  targetFiles?: string[];
}

/** Emitted by the server after rollback completes. */
export interface RollbackCompleteEvent {
  /** Checkpoint that was restored. */
  restoredCheckpoint: SessionCheckpoint;
  /** Files that were reverted. */
  revertedFiles: string[];
  /** New HEAD commit hash after rollback. */
  newHeadCommit: string;
}

// ── Session Completion ────────────────────────────────────────────────────────

/** Emitted when the coding session reaches a terminal state. */
export interface SessionCompleteEvent {
  /** Final status. */
  status: 'completed' | 'failed' | 'cancelled';
  /** Human-readable summary (from the reporter node output). */
  summary: string;
  /** All files modified during the session. */
  filesModified: string[];
  /** All files created during the session. */
  filesCreated: string[];
  /** Git commit hash of the final commit (when status='completed'). */
  commitHash?: string;
  /** PR URL (when a PR was created via background agent flow). */
  prUrl?: string;
  /** Total wall-clock duration in milliseconds. */
  totalDurationMs: number;
  /** Total cost in USD. */
  totalCostUsd: number;
  /** Error message (when status='failed'). */
  error?: string;
}

/** Emitted when a non-fatal error occurs during session execution. */
export interface CodingErrorEvent {
  /** The DAG node that encountered the error (if applicable). */
  nodeId?: string;
  /** Short error category. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Whether the session can recover and continue. */
  recoverable: boolean;
}

// ── Progressive Disclosure rendering helpers ──────────────────────────────────

/**
 * Format a Level 1 intent confirmation string for terminal display.
 *
 * Output:
 *   Understanding your request: "Add JWT auth to API routes"
 *   Complexity: Medium (5-8 files)  |  Template: feature-implementation
 */
export function formatLevel1(summary: IntentSummary): string {
  const complexity = summary.complexity.charAt(0).toUpperCase() + summary.complexity.slice(1);
  const fileHint = summary.estimatedFileCount !== undefined
    ? ` (${summary.estimatedFileCount} files)`
    : '';
  return [
    `Understanding your request: "${summary.description}"`,
    `Complexity: ${complexity}${fileHint}  |  Template: ${summary.template}`,
  ].join('\n');
}

/**
 * Format a Level 2 phase progress string for terminal display.
 *
 * Output:
 *   [=========>        ] 56%
 *   Phase: Implementing  |  Agents: 3/4 active  |  Cost: $1.24
 */
export function formatLevel2(event: CodingProgressEvent): string {
  const pct = Math.min(100, Math.max(0, event.progress ?? 0));
  const filled = Math.round(pct / 5);
  const bar = '='.repeat(filled) + (filled < 20 ? '>' : '') + ' '.repeat(Math.max(0, 19 - filled));
  const phase = event.phase.charAt(0).toUpperCase() + event.phase.slice(1);
  const agents = event.activeAgents !== undefined && event.totalAgents !== undefined
    ? `  |  Agents: ${event.activeAgents}/${event.totalAgents} active`
    : '';
  const cost = event.costUsd !== undefined ? `  |  Cost: $${event.costUsd.toFixed(2)}` : '';
  return [
    `[${bar}] ${pct.toFixed(0)}%`,
    `Phase: ${phase}${agents}${cost}`,
  ].join('\n');
}

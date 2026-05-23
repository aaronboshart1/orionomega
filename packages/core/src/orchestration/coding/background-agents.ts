/**
 * @module orchestration/coding/background-agents
 * Background Agents — Section 7.1 of the system spec.
 *
 * Async coding agents that work on branches without blocking the user's
 * conversation. Similar to Cursor Background Agents and Devin's async execution.
 *
 * Lifecycle: queued → running → completed | failed | review_pending
 * Branch naming: agent/<task-slug>
 *
 * After completion the orchestrator:
 *  1. Creates a PR (via GitHub skill) with full diff and explanation.
 *  2. Monitors CI status via watchCI().
 *  3. Sends a notification via the configured channel.
 */

import type { ApprovalPackage } from './coding-types.js';

// ── Notification Configuration ────────────────────────────────────────────────

/** Which delivery channels should receive background-session notifications. */
export interface NotificationConfig {
  /** Deliver via WebSocket to connected browser clients. Always enabled. */
  websocket: boolean;
  /** Slack channel name or ID (e.g. '#engineering'). Null = disabled. */
  slackChannel: string | null;
  /** Email address. Null = disabled. */
  email: string | null;
  /** Webhook URL for arbitrary HTTP POST notifications. Null = disabled. */
  webhookUrl: string | null;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  websocket: true,
  slackChannel: null,
  email: null,
  webhookUrl: null,
};

// ── BackgroundCodingSession ───────────────────────────────────────────────────

/**
 * Full state record for an async coding session running on a dedicated branch.
 * Persisted to SQLite so users can poll progress or resume after restart.
 */
export interface BackgroundCodingSession {
  /** UUID minted by the orchestrator when the session is created. */
  sessionId: string;
  /** The original user task description. */
  task: string;
  /** Remote repository URL (e.g. 'github.com/org/repo'). */
  repo: string;
  /**
   * Working branch for this session.
   * Created automatically using the pattern `agent/<task-slug>`.
   */
  branch: string;
  /** Current lifecycle state. */
  status: 'queued' | 'running' | 'completed' | 'failed' | 'review_pending';
  /** ISO-8601 timestamp when the session was enqueued. */
  startedAt: string;
  /** ISO-8601 timestamp when the session reached a terminal state. */
  completedAt?: string;
  /**
   * Structured result bundle produced on successful completion.
   * Populated when status is 'completed' or 'review_pending'.
   */
  result?: ApprovalPackage;
  /** Failure reason when status is 'failed'. */
  errorMessage?: string;
  /** PR URL created by createPullRequest() on completion. */
  prUrl?: string;
  /** Notification delivery configuration. */
  notifications: NotificationConfig;
}

// ── Branch naming ─────────────────────────────────────────────────────────────

/**
 * Derive the agent branch name from a session's task description.
 * Produces: `agent/<task-slug>` where slug is kebab-cased, max 48 chars.
 *
 * @example
 * agentBranchName('Add JWT auth to API routes')
 * // → 'agent/add-jwt-auth-to-api-routes'
 */
export function agentBranchName(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/-$/, '');
  return `agent/${slug}`;
}

// ── CI Result ─────────────────────────────────────────────────────────────────

/** Outcome of a CI pipeline run. */
export interface CIRunResult {
  /** 'passed' | 'failed' | 'timed_out' */
  status: 'passed' | 'failed' | 'timed_out';
  /** Extracted failure logs (present when status is 'failed'). */
  logs?: string;
  /** Total CI run duration in milliseconds. */
  durationMs?: number;
}

// ── PR Creation ───────────────────────────────────────────────────────────────

/**
 * Parameters for the GitHub PR creation call (executed via GitHub skill).
 */
export interface PRCreationParams {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** Head branch (the agent's working branch). */
  headBranch: string;
  /** Base branch to merge into (typically `main` or `master`). */
  baseBranch: string;
  /** PR title — always prefixed with '[OrionOmega]'. */
  title: string;
  /** Full PR description formatted by formatPRDescription(). */
  body: string;
  /** Whether to mark the PR as a draft. Default: false. */
  draft?: boolean;
}

/** Result returned by the GitHub skill after creating a PR. */
export interface PRCreationResult {
  /** Full PR URL, e.g. 'https://github.com/org/repo/pull/42'. */
  url: string;
  /** PR number. */
  number: number;
}

// ── GitHub Skill interface (subset used by background agents) ─────────────────

/**
 * Minimal interface for the GitHub skill methods used by background agents.
 * The real implementation lives in @orionomega/skills-sdk.
 */
export interface GitHubSkill {
  execute(
    tool: 'gh_pr',
    args: {
      action: 'create';
      title: string;
      body: string;
      head: string;
      base: string;
      repo?: string;
      draft?: boolean;
    },
  ): Promise<PRCreationResult>;

  execute(
    tool: 'gh_actions',
    args: {
      action: 'list_workflow_runs';
      branch: string;
      repo?: string;
    },
  ): Promise<WorkflowRun[]>;
}

/** A GitHub Actions workflow run record. */
export interface WorkflowRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null;
  branch: string;
  runUrl: string;
  createdAt: string;
  updatedAt: string;
}

// ── PR Description Formatting ─────────────────────────────────────────────────

/**
 * Format the body of a GitHub PR from a completed BackgroundCodingSession.
 * Includes the task description, file change summary, test results, and risk tier.
 */
export function formatPRDescription(session: BackgroundCodingSession): string {
  const pkg = session.result;
  if (!pkg) {
    return `## Summary\n\nAutomated coding session by OrionOmega.\n\nTask: ${session.task}`;
  }

  const lines: string[] = [
    `## Summary`,
    '',
    pkg.summary,
    '',
    `**Risk Level:** ${pkg.riskLevel.toUpperCase()}`,
    '',
    '## Files Changed',
    '',
  ];

  for (const fc of pkg.filesChanged) {
    lines.push(
      `- \`${fc.path}\` — ${fc.action} (+${fc.linesAdded}/-${fc.linesRemoved})`,
    );
  }

  if (pkg.testResults) {
    lines.push('', '## Test Results', '');
    lines.push(
      `- **Passed:** ${pkg.testResults.passed}`,
      `- **Failed:** ${pkg.testResults.failed}`,
      `- **Skipped:** ${pkg.testResults.skipped}`,
    );
  }

  if (pkg.architectDecision) {
    lines.push('', '## Architecture Decision', '', pkg.architectDecision);
  }

  lines.push(
    '',
    '---',
    '_This PR was created automatically by [OrionOmega](https://orionomega.ai)._',
  );

  return lines.join('\n');
}

// ── createPullRequest ─────────────────────────────────────────────────────────

/**
 * Create a GitHub Pull Request for a completed background coding session.
 * Uses the GitHub skill to call `gh pr create`.
 *
 * @param session   The completed BackgroundCodingSession.
 * @param github    The GitHub skill executor.
 * @param baseBranch  Target branch (default: 'main').
 * @returns  The PR URL.
 */
export async function createPullRequest(
  session: BackgroundCodingSession,
  github: GitHubSkill,
  baseBranch = 'main',
): Promise<string> {
  const prBody = formatPRDescription(session);
  const title = `[OrionOmega] ${session.task.slice(0, 72)}`;

  const pr = await github.execute('gh_pr', {
    action: 'create',
    title,
    body: prBody,
    head: session.branch,
    base: baseBranch,
  });

  return pr.url;
}

// ── watchCI ───────────────────────────────────────────────────────────────────

const CI_POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Poll GitHub Actions workflow runs for the session's branch until all runs
 * reach a terminal state or the timeout elapses.
 *
 * @param session   The background coding session (branch must be set).
 * @param github    The GitHub skill executor.
 * @param timeoutMs Maximum polling duration. Default: 30 minutes.
 * @returns CIRunResult indicating pass, fail, or timeout.
 */
export async function watchCI(
  session: BackgroundCodingSession,
  github: GitHubSkill,
  timeoutMs = 30 * 60 * 1000,
): Promise<CIRunResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runs = await github.execute('gh_actions', {
      action: 'list_workflow_runs',
      branch: session.branch,
    });

    // No runs yet — CI hasn't triggered; keep polling
    if (runs.length === 0) {
      await sleep(CI_POLL_INTERVAL_MS);
      continue;
    }

    const failing = runs.filter(
      (r) => r.status === 'completed' && r.conclusion === 'failure',
    );
    if (failing.length > 0) {
      const logs = failing.map((r) => `Run #${r.id} (${r.name}): ${r.runUrl}`).join('\n');
      return { status: 'failed', logs };
    }

    const allDone = runs.every((r) => r.status === 'completed');
    const allPassed = runs.every((r) => r.conclusion === 'success');
    if (allDone && allPassed) {
      return { status: 'passed' };
    }

    await sleep(CI_POLL_INTERVAL_MS);
  }

  return { status: 'timed_out' };
}

// ── CIFixSession parameters ───────────────────────────────────────────────────

/**
 * Parameters to create a follow-up bug-fix session from a CI failure.
 * Returned by ci-integration.ts's createCIFixSession().
 */
export interface CIFixSessionParams {
  /** The original session that triggered the CI run. */
  parentSessionId: string;
  /** Branch where CI failed. */
  branch: string;
  /** Concatenated CI failure logs to inject as context. */
  ciLogs: string;
  /** Human-readable description for the fix session task. */
  task: string;
}

// ── Internal helper ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

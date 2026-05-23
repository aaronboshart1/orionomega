/**
 * @module orchestration/coding/ci-integration
 * CI/CD Integration — Section 7.5 of the system spec.
 *
 * Provides:
 *  - CIIntegration interface: detect pipeline, watch status, extract logs, fix session
 *  - GitHub Actions integration via the existing github skill
 *  - Automated rollback function
 *
 * Flow after git push:
 *  1. detectCIPipeline() — detect which CI system (GitHub Actions, GitLab CI, etc.)
 *  2. watchCIStatus()    — poll for run completion (every 30s, up to timeout)
 *  3. extractFailureLogs() — fetch `gh run view --log-failed` output
 *  4. createCIFixSession() — spawn a bug-fix template session with CI logs as context
 *  5. Link fix session to original session via Hindsight
 */

import type { CodingDAGTemplate } from './coding-types.js';

// ── CI Pipeline detection ─────────────────────────────────────────────────────

/** Supported CI/CD providers. */
export type CIProvider =
  | 'github-actions'
  | 'gitlab-ci'
  | 'circleci'
  | 'jenkins'
  | 'bitbucket-pipelines'
  | 'unknown';

/**
 * Description of the CI pipeline detected in a repository.
 * Populated by CIIntegration.detectCIPipeline().
 */
export interface CIPipeline {
  /** CI provider detected. */
  provider: CIProvider;
  /** Path to the primary CI config file (relative to repo root). */
  configPath: string;
  /**
   * Names of the pipeline stages/jobs defined in the config.
   * Used to correlate failure logs with specific stages.
   */
  stages: string[];
  /**
   * Whether the pipeline runs on every push to any branch
   * (vs. only main/master or pull_request events).
   */
  runsOnPush: boolean;
}

// ── CI Run Result ─────────────────────────────────────────────────────────────

/**
 * Result of a CI pipeline run, returned by CIIntegration.watchCIStatus().
 */
export interface CIResult {
  /** Terminal status of the CI run. */
  status: 'passed' | 'failed' | 'cancelled' | 'timed_out';
  /** CI run ID (provider-specific, e.g. GitHub Actions run ID). */
  runId?: string;
  /** URL to the CI run in the provider's web UI. */
  runUrl?: string;
  /** Total run duration in milliseconds (populated on terminal state). */
  durationMs?: number;
  /** Names of stages/jobs that failed (when status='failed'). */
  failedStages?: string[];
  /** Extracted failure log text (populated after extractFailureLogs()). */
  failureLogs?: string;
}

// ── CI Failure ────────────────────────────────────────────────────────────────

/**
 * Structured description of a CI failure, passed to createCIFixSession().
 * Assembled from CIResult after extractFailureLogs() has been called.
 */
export interface CIFailure {
  /** The coding session that triggered this CI run. */
  parentSessionId: string;
  /** Branch where CI failed. */
  branch: string;
  /** CI provider. */
  provider: CIProvider;
  /** CI run ID. */
  runId: string;
  /** URL to the failed run. */
  runUrl: string;
  /** Names of failed stages/jobs. */
  failedStages: string[];
  /** Concatenated failure log output. */
  logs: string;
  /** ISO-8601 timestamp when the failure was detected. */
  detectedAt: string;
}

// ── CodingSession (lightweight reference) ────────────────────────────────────

/**
 * Lightweight session descriptor returned by createCIFixSession().
 * The full session state lives in the SQLite `codingSessions` table.
 */
export interface CodingSession {
  /** UUID minted by the orchestrator. */
  sessionId: string;
  /** Task description passed to the orchestrator. */
  task: string;
  /** DAG template selected. */
  template: CodingDAGTemplate;
  /** Remote repository URL. */
  repo: string;
  /** Working branch for this session. */
  branch: string;
  /** Lifecycle state. */
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** ISO-8601 start timestamp. */
  startedAt: string;
  /** ISO-8601 completion timestamp (when terminal). */
  completedAt?: string;
  /** ID of the session that spawned this one (for CI fix chaining). */
  parentSessionId?: string;
}

// ── CIIntegration interface ───────────────────────────────────────────────────

/**
 * Interface for CI/CD integration operations.
 * Implementations wrap the GitHub skill (or other CI clients).
 */
export interface CIIntegration {
  /**
   * Detect whether the repository has a CI/CD configuration and identify the
   * provider and pipeline structure.
   *
   * @param repoDir  Absolute path to the local repository root.
   * @returns CIPipeline if CI config is found, null otherwise.
   */
  detectCIPipeline(repoDir: string): Promise<CIPipeline | null>;

  /**
   * Watch CI status for a branch by polling until all runs reach a terminal
   * state or the timeout elapses.
   *
   * @param branch     Branch name to watch (e.g. 'agent/add-jwt-auth').
   * @param timeoutMs  Maximum polling duration in milliseconds. Default: 30min.
   * @returns CIResult with final status.
   */
  watchCIStatus(branch: string, timeoutMs: number): Promise<CIResult>;

  /**
   * Fetch the failure logs from a specific CI run.
   * For GitHub Actions: equivalent to `gh run view <runId> --log-failed`.
   *
   * @param runId  Provider-specific run identifier.
   * @returns Raw failure log text (may be multi-MB; callers should truncate).
   */
  extractFailureLogs(runId: string): Promise<string>;

  /**
   * Spawn a new bug-fix coding session to address a CI failure.
   * The session task is constructed from the CI failure context and injected
   * with the failure logs so the agent has full context.
   *
   * @param failure  Structured CI failure descriptor.
   * @returns Lightweight session descriptor (full state in SQLite).
   */
  createCIFixSession(failure: CIFailure): Promise<CodingSession>;
}

// ── GitHub Actions CI Integration implementation ──────────────────────────────

/** Minimal GitHub skill interface for CI operations. */
export interface GitHubCISkill {
  execute(
    tool: 'gh_actions',
    args: {
      action: 'list_workflow_runs';
      branch: string;
      repo?: string;
    },
  ): Promise<GHWorkflowRun[]>;

  execute(
    tool: 'gh_run_logs',
    args: {
      action: 'get_failure_logs';
      runId: string;
      repo?: string;
    },
  ): Promise<{ logs: string }>;
}

/** GitHub Actions workflow run record (from gh CLI). */
export interface GHWorkflowRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null;
  branch: string;
  runUrl: string;
  createdAt: string;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Concrete CIIntegration implementation for GitHub Actions.
 * Uses the existing GitHub skill for all API calls.
 */
export class GitHubActionsCIIntegration implements CIIntegration {
  constructor(
    private readonly github: GitHubCISkill,
    private readonly repoSlug?: string, // 'owner/repo'
  ) {}

  async detectCIPipeline(repoDir: string): Promise<CIPipeline | null> {
    // Check for common CI config file paths
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const checks: Array<{ path: string; provider: CIProvider; stages: string[] }> = [
      { path: '.github/workflows', provider: 'github-actions', stages: ['build', 'test'] },
      { path: '.gitlab-ci.yml', provider: 'gitlab-ci', stages: ['build', 'test'] },
      { path: '.circleci/config.yml', provider: 'circleci', stages: ['build', 'test'] },
      { path: 'Jenkinsfile', provider: 'jenkins', stages: ['build', 'test'] },
      { path: 'bitbucket-pipelines.yml', provider: 'bitbucket-pipelines', stages: ['build', 'test'] },
    ];

    for (const check of checks) {
      if (existsSync(join(repoDir, check.path))) {
        return {
          provider: check.provider,
          configPath: check.path,
          stages: check.stages,
          runsOnPush: true,
        };
      }
    }

    return null;
  }

  async watchCIStatus(branch: string, timeoutMs = 30 * 60 * 1000): Promise<CIResult> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const runs = await this.github.execute('gh_actions', {
        action: 'list_workflow_runs',
        branch,
        repo: this.repoSlug,
      });

      if (runs.length === 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const failedRuns = runs.filter(
        (r) => r.status === 'completed' && r.conclusion === 'failure',
      );

      if (failedRuns.length > 0) {
        const run = failedRuns[0]!;
        return {
          status: 'failed',
          runId: String(run.id),
          runUrl: run.runUrl,
          failedStages: runs
            .filter((r) => r.conclusion === 'failure')
            .map((r) => r.name),
        };
      }

      const allDone = runs.every((r) => r.status === 'completed');
      const allPassed = runs.every((r) => r.conclusion === 'success');

      if (allDone && allPassed) {
        const run = runs[0]!;
        return {
          status: 'passed',
          runId: String(run.id),
          runUrl: run.runUrl,
        };
      }

      await sleep(POLL_INTERVAL_MS);
    }

    return { status: 'timed_out' };
  }

  async extractFailureLogs(runId: string): Promise<string> {
    const result = await this.github.execute('gh_run_logs', {
      action: 'get_failure_logs',
      runId,
      repo: this.repoSlug,
    });
    // Truncate to 50K chars to avoid blowing context budgets
    return result.logs.slice(0, 50_000);
  }

  async createCIFixSession(failure: CIFailure): Promise<CodingSession> {
    const { randomBytes } = await import('node:crypto');
    const sessionId = randomBytes(16).toString('hex');
    const task = [
      `Fix CI failure on branch '${failure.branch}'.`,
      `Failed stages: ${failure.failedStages.join(', ')}.`,
      `CI run: ${failure.runUrl}`,
      '',
      '## CI Failure Logs',
      failure.logs,
    ].join('\n');

    return {
      sessionId,
      task,
      template: 'bug-fix',
      repo: this.repoSlug ?? '',
      branch: failure.branch,
      status: 'queued',
      startedAt: new Date().toISOString(),
      parentSessionId: failure.parentSessionId,
    };
  }
}

// ── Rollback automation ───────────────────────────────────────────────────────

/**
 * Minimal git operation interface used by automatedRollback().
 * The real implementation uses execSync/child_process in repo-manager.ts.
 */
export interface GitOps {
  reset(mode: '--hard', ref: string, cwd: string): Promise<void>;
  push(flags: string, branch: string, cwd: string): Promise<void>;
}

/**
 * Rollback all changes from a coding session by hard-resetting to the
 * pre-session commit and force-pushing with lease.
 *
 * Steps:
 *  1. Load the pre-session commit hash from the session checkpoint.
 *  2. `git reset --hard <preSessionCommit>`
 *  3. `git push --force-with-lease` (safe force-push — fails if remote
 *      has diverged beyond our expected state)
 *  4. Emit a rollback_complete event.
 *
 * @param sessionId          The coding session ID to roll back.
 * @param preSessionCommit   Git commit hash recorded before the session started.
 * @param workspaceDir       Absolute path to the workspace directory.
 * @param git                Git operations interface.
 * @param branch             Branch name to force-push (e.g. 'agent/add-jwt-auth').
 * @param onComplete         Callback invoked after successful rollback.
 */
export async function automatedRollback(
  sessionId: string,
  preSessionCommit: string,
  workspaceDir: string,
  git: GitOps,
  branch: string,
  onComplete?: (sessionId: string) => void,
): Promise<void> {
  await git.reset('--hard', preSessionCommit, workspaceDir);
  await git.push('--force-with-lease', branch, workspaceDir);
  onComplete?.(sessionId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── CI config file patterns for detectCIPipeline ─────────────────────────────

/** Known CI configuration file paths and their providers. */
export const CI_CONFIG_PATHS: ReadonlyArray<{
  glob: string;
  provider: CIProvider;
}> = [
  { glob: '.github/workflows/*.yml', provider: 'github-actions' },
  { glob: '.github/workflows/*.yaml', provider: 'github-actions' },
  { glob: '.gitlab-ci.yml', provider: 'gitlab-ci' },
  { glob: '.circleci/config.yml', provider: 'circleci' },
  { glob: 'Jenkinsfile', provider: 'jenkins' },
  { glob: 'bitbucket-pipelines.yml', provider: 'bitbucket-pipelines' },
];

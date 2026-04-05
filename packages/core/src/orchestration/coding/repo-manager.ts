/**
 * @module orchestration/coding/repo-manager
 * Git repository management for Coding Mode.
 *
 * Provides functions to clone, sync, branch, commit, and push repositories.
 * Authentication is handled via the `gh` CLI (when available) or standard
 * git credential helpers configured in the environment.
 *
 * All functions are async and reject with descriptive Error objects on failure.
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createLogger } from '../../logging/logger.js';

const execAsync = promisify(execCb);
const log = createLogger('repo-manager');

// ── Types ─────────────────────────────────────────────────────────────────────

/** Result of a git operation. */
export interface GitResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Combined stdout output. */
  stdout: string;
  /** Combined stderr output. */
  stderr: string;
  /** Exit code of the command. */
  exitCode: number;
}

/** Options for cloneRepo. */
export interface CloneOptions {
  /**
   * Target directory. Defaults to a subdirectory derived from the repo name
   * inside `workspaceDir`.
   */
  targetDir?: string;
  /** Branch or tag to checkout immediately after cloning. */
  branch?: string;
  /** Perform a shallow clone (depth=1). Faster but loses history. */
  shallow?: boolean;
  /** Git credentials token (used as password via HTTPS). */
  token?: string;
}

/** Options for pushChanges. */
export interface PushOptions {
  /** Remote name. Defaults to 'origin'. */
  remote?: string;
  /** Branch name. Defaults to the current branch. */
  branch?: string;
  /** Set the upstream tracking ref (--set-upstream). */
  setUpstream?: boolean;
  /** Force-push (use with caution). */
  force?: boolean;
}

/** Metadata about the current repository state. */
export interface RepoStatus {
  /** Current branch name. */
  branch: string;
  /** Remote URL for 'origin'. */
  remoteUrl: string | null;
  /** Whether the working tree is clean. */
  isClean: boolean;
  /** Staged files. */
  stagedFiles: string[];
  /** Modified but unstaged files. */
  modifiedFiles: string[];
  /** Untracked files. */
  untrackedFiles: string[];
  /** Number of commits ahead of upstream. */
  commitsAhead: number;
  /** Number of commits behind upstream. */
  commitsBehind: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Run a git command in the given directory. Throws if the command fails.
 * @internal
 */
async function runGit(
  args: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<GitResult> {
  const command = `git ${args}`;
  log.verbose('Running git command', { command, cwd });

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    const stdout = (error.stdout ?? '').trim();
    const stderr = (error.stderr ?? '').trim();
    const exitCode = typeof error.code === 'number' ? error.code : 1;
    log.verbose('Git command failed', { command, cwd, exitCode, stderr: stderr.slice(0, 200) });
    return { success: false, stdout, stderr, exitCode };
  }
}

/**
 * Build the authenticated remote URL for HTTPS clones.
 * If a token is provided, injects it as `https://token@host/path`.
 * @internal
 */
function buildAuthUrl(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = 'x-token';
    url.password = token;
    return url.toString();
  } catch {
    // Not a valid URL (e.g. SSH), return as-is
    return repoUrl;
  }
}

/**
 * Derive the repository name from a URL (used as the default clone directory name).
 * @internal
 */
function repoNameFromUrl(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\.git$/, '');
  const parts = cleaned.replace(/^(https?:\/\/|git@)[^/:]+[/:]/, '').split('/');
  return parts[parts.length - 1] || 'repo';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Clone a remote repository into a workspace directory.
 *
 * @param repoUrl - The remote URL (HTTPS or SSH).
 * @param workspaceDir - Parent directory under which the repo is cloned.
 * @param opts - Optional clone configuration.
 * @returns The absolute path to the cloned repository.
 */
export async function cloneRepo(
  repoUrl: string,
  workspaceDir: string,
  opts: CloneOptions = {},
): Promise<string> {
  const repoName = repoNameFromUrl(repoUrl);
  const targetDir = opts.targetDir
    ? resolvePath(opts.targetDir)
    : join(resolvePath(workspaceDir), repoName);

  log.info('Cloning repository', { repoUrl, targetDir, branch: opts.branch ?? 'default', shallow: opts.shallow ?? false });

  if (existsSync(join(targetDir, '.git'))) {
    log.info('Repository already cloned', { targetDir });
    return targetDir;
  }

  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  const authUrl = buildAuthUrl(repoUrl, opts.token);
  const shallowFlag = opts.shallow ? '--depth=1 ' : '';
  const branchFlag = opts.branch ? `--branch ${opts.branch} ` : '';
  const result = await runGit(
    `clone ${shallowFlag}${branchFlag}"${authUrl}" "${targetDir}"`,
    workspaceDir,
  );

  if (!result.success) {
    throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
  }

  log.info('Repository cloned successfully', { targetDir });
  return targetDir;
}

/**
 * Pull the latest changes from the upstream remote.
 *
 * @param repoDir - Absolute path to the local repository.
 * @param remote - Remote name. Defaults to 'origin'.
 * @param branch - Branch name. Defaults to the current branch.
 */
export async function pullLatest(
  repoDir: string,
  remote = 'origin',
  branch?: string,
): Promise<GitResult> {
  log.info('Pulling latest changes', { repoDir, remote, branch });

  const branchArg = branch ? ` ${branch}` : '';
  const result = await runGit(`pull ${remote}${branchArg} --ff-only`, repoDir);

  if (!result.success) {
    // Retry without --ff-only if fast-forward is not possible
    log.warn('Fast-forward pull failed, retrying without --ff-only', { stderr: result.stderr });
    const retryResult = await runGit(`pull ${remote}${branchArg}`, repoDir);
    if (!retryResult.success) {
      throw new Error(`git pull failed: ${retryResult.stderr || retryResult.stdout}`);
    }
    return retryResult;
  }

  return result;
}

/**
 * Create a new branch and check it out.
 *
 * @param repoDir - Absolute path to the local repository.
 * @param branchName - Name of the new branch.
 * @param fromBranch - Starting point. Defaults to HEAD.
 */
export async function createBranch(
  repoDir: string,
  branchName: string,
  fromBranch?: string,
): Promise<GitResult> {
  log.info('Creating branch', { repoDir, branchName, fromBranch });

  const fromArg = fromBranch ? ` ${fromBranch}` : '';
  const result = await runGit(`checkout -b ${branchName}${fromArg}`, repoDir);

  if (!result.success) {
    throw new Error(`git checkout -b failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

/**
 * Switch to an existing branch.
 *
 * @param repoDir - Absolute path to the local repository.
 * @param branchName - The branch to switch to.
 */
export async function switchBranch(
  repoDir: string,
  branchName: string,
): Promise<GitResult> {
  log.info('Switching branch', { repoDir, branchName });

  const result = await runGit(`checkout ${branchName}`, repoDir);

  if (!result.success) {
    throw new Error(`git checkout failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

/**
 * Stage files for commit.
 *
 * @param repoDir - Absolute path to the local repository.
 * @param files - Specific files to stage. Pass undefined or empty to stage all changes.
 */
export async function stageChanges(
  repoDir: string,
  files?: string[],
): Promise<GitResult> {
  const fileArgs = files && files.length > 0
    ? files.map((f) => `"${f}"`).join(' ')
    : '-A';

  log.verbose('Staging changes', { repoDir, files: files ?? 'all' });

  const result = await runGit(`add ${fileArgs}`, repoDir);

  if (!result.success) {
    throw new Error(`git add failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

/**
 * Commit staged changes.
 *
 * @param repoDir - Absolute path to the local repository.
 * @param message - The commit message.
 * @param authorName - Optional git author name (defaults to git config).
 * @param authorEmail - Optional git author email (defaults to git config).
 */
export async function commitChanges(
  repoDir: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
): Promise<GitResult> {
  log.info('Committing changes', { repoDir, message: message.slice(0, 80) });

  const env: Record<string, string> = {};
  if (authorName) env['GIT_AUTHOR_NAME'] = authorName;
  if (authorEmail) env['GIT_AUTHOR_EMAIL'] = authorEmail;

  // Use --allow-empty-message guard — always provide a message
  const safeMessage = message.replace(/"/g, '\\"');
  const result = await runGit(`commit -m "${safeMessage}"`, repoDir, env);

  if (!result.success) {
    // Treat "nothing to commit" as a non-fatal success
    if (result.stdout.includes('nothing to commit') || result.stderr.includes('nothing to commit')) {
      log.info('Nothing to commit', { repoDir });
      return { ...result, success: true };
    }
    throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

/**
 * Push local commits to the remote.
 *
 * @param repoDir - Absolute path to the local repository.
 * @param opts - Push options (remote, branch, set-upstream, force).
 */
export async function pushChanges(
  repoDir: string,
  opts: PushOptions = {},
): Promise<GitResult> {
  const remote = opts.remote ?? 'origin';
  const branchArg = opts.branch ? ` ${opts.branch}` : '';
  const upstreamFlag = opts.setUpstream ? ' --set-upstream' : '';
  const forceFlag = opts.force ? ' --force-with-lease' : '';

  log.info('Pushing changes', { repoDir, remote, branch: opts.branch });

  const result = await runGit(
    `push${upstreamFlag}${forceFlag} ${remote}${branchArg}`,
    repoDir,
  );

  if (!result.success) {
    throw new Error(`git push failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

/**
 * Get the current status of the repository.
 *
 * @param repoDir - Absolute path to the local repository.
 * @returns A structured RepoStatus object.
 */
export async function getRepoStatus(repoDir: string): Promise<RepoStatus> {
  const [branchResult, statusResult, remoteResult, aheadBehindResult] = await Promise.all([
    runGit('rev-parse --abbrev-ref HEAD', repoDir),
    runGit('status --porcelain', repoDir),
    runGit('remote get-url origin', repoDir),
    runGit('rev-list --left-right --count HEAD...@{u}', repoDir),
  ]);

  const branch = branchResult.success ? branchResult.stdout : 'unknown';
  const remoteUrl = remoteResult.success ? remoteResult.stdout : null;

  const stagedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  if (statusResult.success && statusResult.stdout) {
    for (const line of statusResult.stdout.split('\n')) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      const file = line.slice(3);
      if (xy[0] !== ' ' && xy[0] !== '?') stagedFiles.push(file);
      if (xy[1] === 'M' || xy[1] === 'D') modifiedFiles.push(file);
      if (xy === '??') untrackedFiles.push(file);
    }
  }

  let commitsAhead = 0;
  let commitsBehind = 0;
  if (aheadBehindResult.success && aheadBehindResult.stdout) {
    const parts = aheadBehindResult.stdout.split('\t');
    commitsAhead = parseInt(parts[0] ?? '0', 10) || 0;
    commitsBehind = parseInt(parts[1] ?? '0', 10) || 0;
  }

  return {
    branch,
    remoteUrl,
    isClean: stagedFiles.length === 0 && modifiedFiles.length === 0 && untrackedFiles.length === 0,
    stagedFiles,
    modifiedFiles,
    untrackedFiles,
    commitsAhead,
    commitsBehind,
  };
}

/**
 * Stage all changes, commit, and push in a single operation.
 *
 * @param repoDir - Absolute path to the local repository.
 * @param message - Commit message.
 * @param pushOpts - Optional push configuration.
 */
export async function stageCommitPush(
  repoDir: string,
  message: string,
  pushOpts: PushOptions = {},
): Promise<void> {
  await stageChanges(repoDir);
  await commitChanges(repoDir, message);
  await pushChanges(repoDir, pushOpts);
  log.info('Stage/commit/push completed', { repoDir, message: message.slice(0, 80) });
}

/**
 * Check if a directory is a git repository.
 *
 * @param dir - Path to check.
 * @returns true if the directory contains a `.git` folder or is inside a git repo.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await runGit('rev-parse --git-dir', dir);
  return result.success;
}

/**
 * Get the root of the git repository containing `dir`.
 *
 * @param dir - A directory inside a git repository.
 * @returns The absolute path to the repository root, or null if not in a repo.
 */
export async function getRepoRoot(dir: string): Promise<string | null> {
  const result = await runGit('rev-parse --show-toplevel', dir);
  return result.success ? result.stdout : null;
}

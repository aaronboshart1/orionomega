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
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
  /** Latest commit metadata, populated by {@link getRepoStatus}. */
  lastCommit?: {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    date: string;
  } | null;
  /** Untracked files. */
  untrackedFiles: string[];
  /** Number of commits ahead of upstream. */
  commitsAhead: number;
  /** Number of commits behind upstream. */
  commitsBehind: number;
  /**
   * Diagnostics: per-call git stderr for any sub-command that failed.
   * Empty when every probe succeeded. Surfaced to the UI so users aren't
   * left guessing why the branch / HEAD show as "unknown".
   */
  diagnostics?: { branchErr?: string; headErr?: string; remoteErr?: string; statusErr?: string };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Strict git ref-name validator (subset of git-check-ref-format rules,
 * plus extra hardening because we sometimes interpolate refs into shell
 * `exec` strings). Rejects anything that could be misread as a shell
 * argument boundary, an option flag, or a path traversal.
 *
 * Allowed: ASCII letters, digits, `_`, `-`, `.`, `/`. Branch may be 1–250
 * chars. Disallowed: leading `-` or `.`, double-dot `..`, leading or
 * trailing `/`, double `//`, `@{` (refspec sigil), `^`, `~`, `:`, `?`,
 * `*`, `[`, `\`, whitespace, control characters, and `.git`/`.lock`
 * suffixes.
 */
export function isValidGitRefName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 250) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock') || name.endsWith('.git')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  return true;
}

/** Throw if `name` is not a valid git ref name. Use at every shell boundary. */
export function assertValidGitRefName(name: unknown, label = 'branch'): asserts name is string {
  if (!isValidGitRefName(name)) {
    throw new Error(`Invalid ${label} name: refusing to interpolate untrusted value into git command`);
  }
}

/**
 * Run a git command in the given directory. Throws if the command fails.
 * @internal
 */
async function runGit(
  args: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<GitResult> {
  // `-c safe.directory=*` bypasses git's "dubious ownership" check for repos
  // whose on-disk uid differs from the gateway process uid. The user opted
  // into the repo via the Git tab, so the ownership signal isn't useful here
  // and silently turns every status/HEAD read into "unknown".
  // Single-quote `safe.directory=*` so the shell can't glob-expand `*`
  // against files in `cwd`. Without quoting, a cwd containing a file named
  // `safe.directory=foo` would silently corrupt the flag.
  const command = `git -c 'safe.directory=*' ${args}`;
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

  const diagnostics: NonNullable<RepoStatus['diagnostics']> = {};
  if (!branchResult.success) diagnostics.branchErr = branchResult.stderr || `exit ${branchResult.exitCode}`;
  if (!statusResult.success) diagnostics.statusErr = statusResult.stderr || `exit ${statusResult.exitCode}`;
  if (!remoteResult.success) diagnostics.remoteErr = remoteResult.stderr || `exit ${remoteResult.exitCode}`;

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

  const lastCommit = await getLastCommit(repoDir);
  // getLastCommit failure is also a useful HEAD-side signal.
  if (!lastCommit && branchResult.success) {
    // Branch resolved but HEAD didn't — explicitly probe to capture stderr.
    const headProbe = await runGit('rev-parse HEAD', repoDir);
    if (!headProbe.success) diagnostics.headErr = headProbe.stderr || `exit ${headProbe.exitCode}`;
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
    lastCommit,
    diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : undefined,
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

/**
 * Get the URL of a named remote in the repository at `dir`.
 *
 * @param dir - A directory inside a git repository.
 * @param remote - Remote name. Defaults to `'origin'`.
 * @returns The remote URL, or `null` if the remote (or repo) does not exist.
 */
export async function getRemoteUrl(dir: string, remote = 'origin'): Promise<string | null> {
  const result = await runGit(`remote get-url ${remote}`, dir);
  if (!result.success) return null;
  return result.stdout.trim() || null;
}

/**
 * Resolve the current HEAD commit hash of a git repository.
 *
 * @param dir - A directory inside a git repository.
 * @returns The full SHA of HEAD, or `null` if it cannot be determined.
 */
export async function getHeadCommit(dir: string): Promise<string | null> {
  const result = await runGit('rev-parse HEAD', dir);
  if (!result.success) return null;
  return result.stdout.trim() || null;
}

/**
 * Derive the repository name from a URL (filename portion of the path,
 * with any trailing `.git` stripped). Public so the orchestrator can pick
 * the same per-run checkout subdirectory name `cloneRepo` would use.
 */
export function repoNameFromRemoteUrl(repoUrl: string): string {
  return repoNameFromUrl(repoUrl);
}

// ── Session-scoped clone + worktree primitives (Task #196) ───────────────────
//
// These helpers back the Git tab's session-persistent clone model. Instead of
// re-cloning into `<workspaceDir>/output/<runId>/<repo>` on every coding-mode
// turn, the gateway picks a stable per-session clone path (e.g.
// `<workspaceDir>/repos/<sessionId>/<repoName>`) and calls
// `ensureSessionClone` to lazily clone or fast-forward on each turn.
//
// Parallel coding-agent isolation is achieved with `git worktree add`: a
// short-lived branch per dispatch (or per node) checks out into its own
// directory but shares the object DB with the session clone, so adds/fetches
// happen once and merges back are cheap.

/** Result of {@link ensureSessionClone}. */
export interface EnsureSessionCloneResult {
  /** Absolute path to the session clone. */
  localPath: string;
  /** True if the clone was created on this call (false → already existed). */
  cloned: boolean;
  /** True if a `git fetch` ran successfully on this call. */
  fetched: boolean;
  /** True if the working branch was fast-forwarded to its upstream. */
  fastForwarded: boolean;
  /** Current HEAD commit after the operation. */
  headCommit: string | null;
}

/**
 * Ensure the session clone exists at `localPath`. If the directory is
 * missing or empty, clone `remoteUrl` into it on `branch`. If it already
 * contains a `.git`, run `git fetch` and try a `--ff-only` pull on the
 * configured branch so the session always starts on the freshest commit.
 *
 * Never destructive: a non-fast-forwardable working tree is left as-is and
 * surfaced via `fastForwarded: false`. The caller can decide whether to
 * proceed (e.g. allocate a worktree off the stale branch) or surface the
 * mismatch to the user.
 */
export async function ensureSessionClone(
  remoteUrl: string,
  localPath: string,
  branch = 'main',
): Promise<EnsureSessionCloneResult> {
  assertValidGitRefName(branch);
  const abs = resolvePath(localPath);
  const gitDir = join(abs, '.git');
  let cloned = false;
  let fetched = false;
  let fastForwarded = false;

  // Detect a half-cloned directory left behind by a previous failed
  // `git clone -b <branch>` (some git versions leave `.git` in place even
  // when the requested branch doesn't exist, which traps subsequent calls
  // in the "existing clone" branch with an unresolvable HEAD).
  const isBrokenClone = existsSync(gitDir) && (await getHeadCommit(abs)) === null;
  if (isBrokenClone) {
    log.warn('ensureSessionClone: detected half-cloned dir without HEAD — wiping', { localPath: abs });
    rmSync(abs, { recursive: true, force: true });
  }

  if (!existsSync(gitDir)) {
    // Fresh clone. Reuse cloneRepo so the auth/branch flag handling stays
    // in one place. cloneRepo expects (workspaceDir, opts.targetDir).
    const parent = abs.replace(/\/[^/]+\/?$/, '') || '/';
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    log.info('ensureSessionClone: cloning', { remoteUrl, localPath: abs, branch });
    try {
      await cloneRepo(remoteUrl, parent, { targetDir: abs, branch });
    } catch (err) {
      // If the requested branch doesn't exist on the remote (common when the
      // user added a repo without overriding the "main" default but the repo
      // actually uses master / develop / etc.), fall back to cloning the
      // remote's HEAD so the session still gets a usable working tree.
      const msg = err instanceof Error ? err.message : String(err);
      if (/Remote branch .* not found in upstream origin/i.test(msg)) {
        log.warn('ensureSessionClone: requested branch missing — retrying with remote default', {
          remoteUrl, branch,
        });
        // Wipe any partial directory git left behind so the cloneRepo
        // short-circuit (`if (.git exists) return targetDir`) doesn't
        // reuse the broken state.
        if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
        await cloneRepo(remoteUrl, parent, { targetDir: abs });
      } else {
        throw err;
      }
    }
    cloned = true;
  } else {
    // Verify the existing clone points at the same remote — otherwise we'd
    // silently fetch a different repo's history into the user's session dir.
    const existingRemote = await getRemoteUrl(abs);
    if (existingRemote && existingRemote !== remoteUrl) {
      throw new Error(
        `Session clone at ${abs} has remote "${existingRemote}" but the selection asks for "${remoteUrl}". ` +
        `Delete the directory or pick a different local path before re-selecting.`,
      );
    }
    log.info('ensureSessionClone: refreshing existing clone', { localPath: abs, branch });
    const fetchResult = await runGit('fetch --prune origin', abs);
    fetched = fetchResult.success;
    if (!fetchResult.success) {
      log.warn('ensureSessionClone: fetch failed (continuing with local state)', {
        stderr: fetchResult.stderr.slice(0, 200),
      });
    }

    // Best-effort fast-forward of the requested branch from origin.
    const checkout = await runGit(`checkout ${branch}`, abs);
    if (checkout.success) {
      const ff = await runGit(`merge --ff-only origin/${branch}`, abs);
      fastForwarded = ff.success;
    }
  }

  const headCommit = await getHeadCommit(abs);
  return { localPath: abs, cloned, fetched, fastForwarded, headCommit };
}

/**
 * Read the latest commit metadata of a session clone for display in the
 * Git tab. Returns `null` if the repo has no commits or git fails.
 */
export async function getLastCommit(localPath: string): Promise<{
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
} | null> {
  const abs = resolvePath(localPath);
  if (!existsSync(join(abs, '.git'))) return null;
  // %x1f is unit-separator — safe delimiter inside a commit subject.
  const logRes = await runGit('log -1 --pretty=format:%H%x1f%s%x1f%an%x1f%aI', abs);
  if (!logRes.success || !logRes.stdout) return null;
  const [sha, subject, author, date] = logRes.stdout.split('\x1f');
  if (!sha) return null;
  return {
    sha,
    shortSha: sha.slice(0, 8),
    subject: subject ?? '',
    author: author ?? '',
    date: date ?? '',
  };
}

/** Result of {@link addWorktree}. */
export interface AddWorktreeResult {
  /** Absolute path to the new worktree. */
  worktreePath: string;
  /** Branch the worktree is checked out to. */
  branch: string;
}

/**
 * Add a `git worktree` at `worktreePath`, checked out to `branch`.
 *
 * If `branch` does not exist yet, it is created from `baseBranch` (default
 * `'main'`). The new worktree shares the session clone's object DB, so
 * checkouts are near-instant and disk usage stays bounded.
 */
export async function addWorktree(
  sessionClonePath: string,
  worktreePath: string,
  branch: string,
  baseBranch = 'main',
): Promise<AddWorktreeResult> {
  const abs = resolvePath(worktreePath);
  // Idempotency: if the worktree dir already exists with a checkout, return it.
  if (existsSync(join(abs, '.git'))) {
    log.info('addWorktree: worktree already exists, reusing', { worktreePath: abs, branch });
    return { worktreePath: abs, branch };
  }

  // Check whether the branch already exists locally.
  assertValidGitRefName(branch);
  assertValidGitRefName(baseBranch, 'baseBranch');
  const branchExists = await runGit(`rev-parse --verify --quiet refs/heads/${branch}`, sessionClonePath);
  const args = branchExists.success
    ? `worktree add "${abs}" ${branch}`
    : `worktree add -b ${branch} "${abs}" ${baseBranch}`;

  const result = await runGit(args, sessionClonePath);
  if (!result.success) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
  }
  log.info('addWorktree: created', { worktreePath: abs, branch, baseBranch });
  return { worktreePath: abs, branch };
}

/**
 * Remove a previously-allocated worktree. Best-effort: failures are logged
 * but not thrown, since orphan worktrees can be cleaned up later via
 * `git worktree prune`.
 */
export async function removeWorktree(
  sessionClonePath: string,
  worktreePath: string,
): Promise<void> {
  const abs = resolvePath(worktreePath);
  const result = await runGit(`worktree remove --force "${abs}"`, sessionClonePath);
  if (!result.success) {
    log.warn('removeWorktree: failed (non-fatal — run `git worktree prune` later)', {
      worktreePath: abs,
      stderr: result.stderr.slice(0, 200),
    });
  }
}

/**
 * Merge `sourceBranch` into the currently-checked-out branch of
 * `sessionClonePath`. Used by the dispatch consolidation step to fold the
 * worktree's branch back into the session branch before push.
 *
 * Uses `--no-ff` so the merge commit retains the dispatch boundary in
 * history, which makes `git log` more useful when reviewing what each turn
 * actually changed.
 */
export async function mergeBranchInto(
  sessionClonePath: string,
  sourceBranch: string,
  message: string,
): Promise<GitResult> {
  assertValidGitRefName(sourceBranch, 'sourceBranch');
  const safeMsg = message.replace(/"/g, '\\"');
  const result = await runGit(`merge --no-ff -m "${safeMsg}" ${sourceBranch}`, sessionClonePath);
  if (!result.success) {
    throw new Error(`git merge failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

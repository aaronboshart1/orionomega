/**
 * @module orchestration/coding/remote-resolver
 *
 * Remote-URL resolution for code-mode dispatches (Task #237 split out of
 * `coding-orchestrator.ts`). Given contextual clues (a `repo:` hint, a local
 * checkout, an operator default, a fallback cwd), resolves the git remote to
 * clone from — or throws a {@link RemoteResolutionError} that names every
 * recovery option.
 *
 * Re-exported from `coding-orchestrator.ts` so existing import paths keep
 * working (`resolveCodingRemote`, `RemoteResolutionError`,
 * `RemoteResolutionContext`).
 */

import { existsSync } from 'node:fs';
import { getRemoteUrl } from './repo-manager.js';
import { normalizeRepoHint } from './coding-request.js';

/**
 * Typed error raised when no remote URL can be resolved for a coding run.
 * Carries a user-facing message that explains every fallback path that was
 * tried so the operator can pick the easiest one to fix.
 */
export class RemoteResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteResolutionError';
  }
}

/**
 * Inputs to {@link resolveCodingRemote}. Kept as a discrete type so tests
 * can call the resolver without spinning up a full orchestrator config.
 */
export interface RemoteResolutionContext {
  /** A `repo:<url>` hint extracted from the user's task, if any. */
  repoHint?: string;
  /**
   * Optional path to a local git checkout. If it has an `origin` remote,
   * its URL is used. The checkout itself is never reused as the working
   * tree — see `CodingOrchestratorConfig.sourceRepoDir`.
   */
  sourceRepoDir?: string;
  /** Operator-configured default remote URL (`coding.defaultRemote`). */
  defaultRemote?: string;
  /**
   * Final fallback: read `git remote get-url origin` from this directory
   * (typically the install / project root). Skipped when `null`.
   */
  cwdForFallback?: string | null;
}

/**
 * Resolve the remote URL for a code-mode run from contextual clues.
 *
 * Priority order, matching the task spec:
 *   1. Explicit `repo:<url>` hint in the task description.
 *   2. `git remote get-url origin` inside `sourceRepoDir` (if it's a repo).
 *   3. `defaultRemote` from `config.yaml` (`coding.defaultRemote`).
 *   4. `git remote get-url origin` inside `cwdForFallback` (typically the
 *      install / project root) as a last-ditch attempt.
 *
 * When all four miss, throws {@link RemoteResolutionError} with a message
 * that names every option the operator can set to recover. Callers
 * surface this verbatim to the user — the previous code silently fell back
 * to `file://./`, which dropped runs into the gateway process's cwd and
 * led to "not a git repository" failures further down the DAG.
 */
export async function resolveCodingRemote(ctx: RemoteResolutionContext): Promise<string> {
  if (ctx.repoHint && ctx.repoHint.trim().length > 0) {
    // Defense in depth: normalize even hints that came in pre-extracted by
    // a caller, so a bare slug like `owner/repo` still becomes a valid
    // clone URL when fed directly.
    const normalized = normalizeRepoHint(ctx.repoHint);
    if (normalized) return normalized;
  }

  if (ctx.sourceRepoDir && existsSync(ctx.sourceRepoDir)) {
    const origin = await getRemoteUrl(ctx.sourceRepoDir, 'origin').catch(() => null);
    if (origin) return origin;
  }

  if (ctx.defaultRemote && ctx.defaultRemote.trim().length > 0) {
    return ctx.defaultRemote.trim();
  }

  if (ctx.cwdForFallback && existsSync(ctx.cwdForFallback)) {
    const origin = await getRemoteUrl(ctx.cwdForFallback, 'origin').catch(() => null);
    if (origin) return origin;
  }

  throw new RemoteResolutionError(
    'Could not resolve a git remote for this coding run. ' +
    'Try one of these (in order of effort): ' +
    '(1) Include `repo:<https-or-ssh-url>` in your message; ' +
    '(2) set `coding.defaultRemote` in config.yaml to your repo URL; ' +
    '(3) set `coding.repoDir` (sourceRepoDir) to a local checkout whose ' +
    '`origin` remote points at the upstream repo; or ' +
    '(4) launch the gateway from inside a working git checkout so ' +
    '`git remote get-url origin` resolves.',
  );
}

/**
 * @module orchestration/coding/safe-commit
 *
 * Coding-mode commit safety helpers (Task #209).
 *
 * Coding-mode runs perform `npm install` / `pnpm install` / build steps
 * inside a per-run checkout. If the user's repo doesn't carry a
 * stack-appropriate `.gitignore`, a naive final `git add -A` then sweeps
 * every byte of `node_modules/`, `.next/`, `dist/`, `.env*`, etc. into
 * the commit. GitHub then refuses the push (any single file >100 MB is
 * a hard reject; even smaller `node_modules/` blobs spam the user's
 * history).
 *
 * This module provides the deterministic primitives the dispatch
 * preamble describes:
 *
 *   - {@link DEFAULT_GITIGNORE_ENTRIES} — the universal "never commit
 *     this" list.
 *   - {@link ensureSafeGitignore} — append any missing entries to a
 *     repo's `.gitignore` (creating one if absent), preserving the
 *     user-curated content. Reports back which entries were added so
 *     the run summary can surface the change.
 *   - {@link findUnsafeFiles} — scan the working tree for files that
 *     must never be staged: secrets (`.env`, `*.pem`, `*.key`, `*.p12`),
 *     known build-artefact directories, and anything bigger than
 *     {@link MAX_COMMITTABLE_BYTES}.
 *   - {@link assertCommitIsSafe} — orchestration glue that combines the
 *     two and throws a single, user-readable {@link CommitSafetyError}
 *     when something would have made it into the commit.
 *
 * The helpers are pure (aside from filesystem reads/writes) and accept
 * a `repoDir` argument. They do not shell out to `git` — they read the
 * working tree directly so the same checks apply whether the caller is
 * the orchestrator, a test, or a future pre-push hook.
 *
 * Scope (out of scope for this module):
 *   - Rewriting commits already pushed to the user's remote.
 *   - Setting up Git LFS for large binaries that legitimately belong in
 *     the tree — we refuse oversize files with a clear message and let
 *     the user decide.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * GitHub rejects any blob over 100 MB. We refuse at 95 MB so that a
 * little file-system rounding (or compression-on-the-wire surprise)
 * doesn't push us over after the fact, and so the user gets a clearer
 * message than git's own "remote: error" output.
 */
export const MAX_COMMITTABLE_BYTES = 95 * 1024 * 1024;

/**
 * Default `.gitignore` template. These are the entries every web /
 * Node / generic project benefits from. We deliberately keep the list
 * short and universal — language-specific patterns (Python venvs, Java
 * targets, Rust target dirs) are out of scope for the v1 safety net.
 *
 * Order matters only for human readability; git treats `.gitignore`
 * entries as an unordered set for the matching we care about here.
 */
export const DEFAULT_GITIGNORE_ENTRIES: readonly string[] = Object.freeze([
  // Dependencies
  'node_modules/',
  // Environment files (secrets) — broad `.env*` glob, with the two
  // conventional placeholder filenames negated so they remain
  // checkable. Round-5 review: this is the spec-required template,
  // versus enumerating individual `.env.local` / `.env.production`
  // names that miss novel suffixes (`.env.staging`, `.env.docker`...)
  '.env*',
  '!.env.example',
  '!.env.sample',
  // Build artefacts
  '.next/',
  'dist/',
  'build/',
  '.cache/',
  '.turbo/',
  'coverage/',
  // Logs
  '*.log',
  'npm-debug.log*',
  'pnpm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
  // OS / editor junk
  '.DS_Store',
  'Thumbs.db',
  '.idea/',
  '.vscode/',
]);

/**
 * Result of {@link ensureSafeGitignore}.
 */
export interface EnsureSafeGitignoreResult {
  /** Absolute path to the `.gitignore` we read or wrote. */
  gitignorePath: string;
  /** Entries that were missing and have been appended to the file. */
  added: string[];
  /** True if the file did not exist before this call. */
  created: boolean;
}

/**
 * Ensure `repoDir/.gitignore` covers {@link DEFAULT_GITIGNORE_ENTRIES}.
 *
 * - If the file is absent, it is created with a small header explaining
 *   why and the full default set.
 * - If the file exists, only the entries that are not already present
 *   (matched as a literal line, after trimming whitespace) are appended,
 *   under a separator comment. Existing user-curated content is never
 *   reordered or rewritten.
 * - The check is intentionally line-literal: we don't try to interpret
 *   negation (`!foo`), wildcards, or directory equivalence
 *   (`node_modules` vs `node_modules/`). The cost of an over-permissive
 *   match here would be silently letting `node_modules` through; an
 *   over-strict (line-literal) match just appends a redundant entry,
 *   which git treats as a harmless no-op.
 */
export function ensureSafeGitignore(repoDir: string): EnsureSafeGitignoreResult {
  const gitignorePath = join(repoDir, '.gitignore');
  // No-op when the checkout dir doesn't exist yet (e.g. unit-test mocks
  // that return a path string without materialising the directory). The
  // dispatch layer's "is .git a real dir?" check is the canonical gate
  // for "do we have a real repo to protect?", not this function.
  if (!existsSync(repoDir)) {
    return { gitignorePath, added: [], created: false };
  }
  const existed = existsSync(gitignorePath);

  if (!existed) {
    const header =
      '# Auto-generated by OrionOmega coding mode (Task #209) to keep build\n' +
      '# artefacts, dependencies, and secrets out of commits. Add your own\n' +
      '# entries below — this file is owned by you from now on.\n';
    const body = DEFAULT_GITIGNORE_ENTRIES.join('\n') + '\n';
    writeFileSync(gitignorePath, header + '\n' + body, 'utf-8');
    return {
      gitignorePath,
      added: [...DEFAULT_GITIGNORE_ENTRIES],
      created: true,
    };
  }

  const current = readFileSync(gitignorePath, 'utf-8');
  const existingLines = new Set(
    current.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0),
  );

  const missing = DEFAULT_GITIGNORE_ENTRIES.filter(
    (entry) => !existingLines.has(entry),
  );

  if (missing.length === 0) {
    return { gitignorePath, added: [], created: false };
  }

  const separator =
    (current.endsWith('\n') ? '' : '\n') +
    '\n# Added by OrionOmega coding mode (Task #209) — safe-commit defaults.\n';
  writeFileSync(
    gitignorePath,
    current + separator + missing.join('\n') + '\n',
    'utf-8',
  );
  return { gitignorePath, added: missing, created: false };
}

/**
 * One offending file detected by {@link findUnsafeFiles}.
 */
export interface UnsafeFile {
  /** Path relative to the repo root, using POSIX separators. */
  path: string;
  /** Why we refuse to stage this file. */
  reason: 'oversize' | 'secret' | 'build-artefact';
  /** File size in bytes (always populated; useful for the error message). */
  bytes: number;
}

/**
 * Result of {@link findUnsafeFiles}.
 */
export interface FindUnsafeFilesResult {
  /** All offending files, grouped only by `reason` on inspection. */
  unsafe: UnsafeFile[];
}

/**
 * Filenames that always count as secrets, even with a missing or
 * incomplete `.gitignore`. `.env.example` and `.env.sample` are
 * deliberately *not* matched — those are conventional placeholders
 * checked into source.
 */
function isSecretPath(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? '';
  if (base === '.env') return true;
  if (/^\.env\.[^/]+$/.test(base)) {
    if (base === '.env.example' || base === '.env.sample') return false;
    return true;
  }
  return /\.(pem|key|p12|pfx)$/i.test(base);
}

/**
 * Top-level directory names that always count as build / dependency
 * artefacts. We match on the first path segment (relative to the repo
 * root) so a legitimate `node_modules.md` document under `docs/` is
 * untouched.
 */
const BUILD_ARTEFACT_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  '.cache',
  '.turbo',
  'coverage',
]);

function isBuildArtefactPath(relPath: string): boolean {
  const first = relPath.split('/')[0] ?? '';
  return BUILD_ARTEFACT_DIRS.has(first);
}

/**
 * Walk the working tree under `repoDir` and surface any file that
 * matches the deny list (build artefact, secret) or exceeds
 * {@link MAX_COMMITTABLE_BYTES}.
 *
 * The walk skips `.git/` (we never want to "fix" the object database)
 * but does NOT consult `.gitignore` — that's the whole point. The
 * caller has typically just run {@link ensureSafeGitignore}, so a
 * subsequent `git add -A` would now skip `node_modules/` etc.; this
 * scan is the belt-and-braces last line of defence that catches:
 *
 *   - A file already tracked by git that's now over 95 MB.
 *   - A `.env` that the user explicitly committed before adopting the
 *     safe-commit flow (the new `.gitignore` doesn't untrack it; we
 *     surface it so the agent / user removes it explicitly).
 *   - Build directories that slipped past `.gitignore` because of
 *     non-standard names not yet in the default list (the deny set is
 *     a conservative superset of the gitignore template).
 *
 * Performance: the walk is bounded by `maxFiles` (default 200,000 —
 * enough for very large monorepos but small enough to bail on
 * pathological `node_modules/` explosions in a tenth of a second).
 */
export function findUnsafeFiles(
  repoDir: string,
  opts: { maxBytes?: number; maxFiles?: number } = {},
): FindUnsafeFilesResult {
  const maxBytes = opts.maxBytes ?? MAX_COMMITTABLE_BYTES;
  const maxFiles = opts.maxFiles ?? 200_000;
  const unsafe: UnsafeFile[] = [];
  let count = 0;

  function walk(dir: string): void {
    if (count >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxFiles) return;
      const full = join(dir, entry.name);
      const rel = relative(repoDir, full).split(sep).join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      let bytes = 0;
      try {
        bytes = statSync(full).size;
      } catch {
        continue;
      }
      if (isSecretPath(rel)) {
        unsafe.push({ path: rel, reason: 'secret', bytes });
        continue;
      }
      if (isBuildArtefactPath(rel)) {
        unsafe.push({ path: rel, reason: 'build-artefact', bytes });
        continue;
      }
      if (bytes > maxBytes) {
        unsafe.push({ path: rel, reason: 'oversize', bytes });
      }
    }
  }

  walk(repoDir);
  return { unsafe };
}

/**
 * Thrown by {@link assertCommitIsSafe}. The message is shaped so the
 * orchestrator can surface it verbatim to the user without further
 * formatting.
 */
export class CommitSafetyError extends Error {
  constructor(public readonly unsafe: UnsafeFile[]) {
    super(formatCommitSafetyMessage(unsafe));
    this.name = 'CommitSafetyError';
  }
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Format the unsafe-file list into a single user-readable error string.
 * Exported so the dispatch preamble can show the same template in its
 * "what to do if this fails" guidance, and so tests can assert on the
 * exact wording.
 */
export function formatCommitSafetyMessage(unsafe: UnsafeFile[]): string {
  const lines: string[] = [];
  lines.push(
    `Refusing to commit ${unsafe.length} file${unsafe.length === 1 ? '' : 's'} that would either ` +
      `break the push (>${humanBytes(MAX_COMMITTABLE_BYTES)} GitHub limit) or ` +
      `leak secrets / build artefacts:`,
  );
  for (const f of unsafe) {
    const tag =
      f.reason === 'oversize' ? `oversize, ${humanBytes(f.bytes)}`
      : f.reason === 'secret' ? 'secret / env file'
      : 'build artefact';
    lines.push(`  - ${f.path} (${tag})`);
  }
  lines.push(
    'Fix: remove the file from the working tree (or move it outside the repo), ' +
      'add the appropriate pattern to .gitignore, then re-run. For files that ' +
      'legitimately belong in the repo but exceed 95 MB, set up Git LFS first.',
  );
  return lines.join('\n');
}

/**
 * Result of {@link prepareSafeCommit}.
 */
export interface PrepareSafeCommitResult {
  /** Outcome of the gitignore step. */
  gitignore: EnsureSafeGitignoreResult;
  /** Files that were refused (always empty when no error was thrown). */
  refused: UnsafeFile[];
}

/**
 * Run the full safe-commit pre-flight: ensure `.gitignore` covers the
 * defaults, then walk the working tree and throw
 * {@link CommitSafetyError} if any unsafe files remain.
 *
 * Callers (the dispatch preamble's commit step, integration tests, a
 * future pre-push hook) get a single function to call instead of
 * having to remember the order of operations.
 */
export function prepareSafeCommit(repoDir: string): PrepareSafeCommitResult {
  const gitignore = ensureSafeGitignore(repoDir);
  const { unsafe } = findUnsafeFiles(repoDir);
  if (unsafe.length > 0) {
    throw new CommitSafetyError(unsafe);
  }
  return { gitignore, refused: [] };
}

/**
 * Round-5 review: deterministic post-execution preflight that walks
 * the commits the agent introduced (`baseHeadCommit..HEAD`) and
 * applies the same deny-list as the runtime hooks — INDEPENDENTLY of
 * the agent. The hooks can in theory be bypassed (`git push
 * --no-verify`, an `IPC::Open2` failure swallowed under load, a
 * disabled hook in a downstream worktree...); this scan is the
 * executor's last line of defence and runs in plain TypeScript so
 * its behaviour is testable without spawning Perl.
 *
 * Algorithm:
 *  1. `git rev-list --reverse <base>..HEAD` → ordered commit list.
 *     If `base` is null (unborn branch at dispatch time) we fall
 *     back to walking every reachable commit, matching the pre-push
 *     hook's new-branch behaviour (`remote_sha = 0*40`).
 *  2. For each commit, `git ls-tree -r -l -z` → `(mode, type, sha,
 *     size, path)` rows. We dedup blobs by `sha` so a file that
 *     appears unchanged in 100 commits is checked once.
 *  3. Apply the same deny-list the hooks use (oversize, secret
 *     filenames, build-artefact dirs, control bytes in path) and
 *     attach the *first* commit each blob was seen in (we walk
 *     newest → oldest after dedup).
 *
 * Pure shell-out via `spawnSync` — no FS writes, safe to run from
 * the executor's hot path.
 */
export interface FindUnsafeCommittedFilesOptions {
  /** Override the 95 MB ceiling (used in tests). */
  maxBytes?: number;
  /**
   * Hard cap on commits walked. Protects against accidentally
   * scanning a full clone history when `baseHeadCommit` is null on a
   * very large repo. Default 5,000 — well above what any single
   * coding-mode dispatch will produce.
   */
  maxCommits?: number;
}

export interface FindUnsafeCommittedFilesResult {
  /** Refused files, deduped by blob SHA, newest commit wins. */
  refused: import('../types.js').RefusedCommittedFile[];
  /** Reason a scan could not run (when `null` the scan ran cleanly). */
  skippedReason: string | null;
}

function isControlBytePath(relPath: string): boolean {
  for (let i = 0; i < relPath.length; i++) {
    const code = relPath.charCodeAt(i);
    if (code >= 0x01 && code <= 0x1f) return true;
  }
  return false;
}

export function findUnsafeCommittedFiles(
  checkoutPath: string,
  baseHeadCommit: string | null,
  opts: FindUnsafeCommittedFilesOptions = {},
): FindUnsafeCommittedFilesResult {
  const maxBytes = opts.maxBytes ?? MAX_COMMITTABLE_BYTES;
  const maxCommits = opts.maxCommits ?? 5000;

  if (!existsSync(join(checkoutPath, '.git'))) {
    return { refused: [], skippedReason: 'no .git directory at checkout path' };
  }

  // Lazy require to keep the helper usable from environments where
  // `child_process` isn't on the import allow-list (unit-test mocks).
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

  // Step 1: get commit list. `--reverse` so the FIRST time we see a
  // blob is the OLDEST commit it appears in — but we want NEWEST,
  // so we DON'T pass --reverse and walk the default newest-first
  // order. (Naming is confusing; we deliberately keep newest-first.)
  let revListArgs: string[];
  if (baseHeadCommit && baseHeadCommit.length > 0) {
    revListArgs = ['rev-list', `${baseHeadCommit}..HEAD`];
  } else {
    // Unborn-branch / brand-new-clone case: walk all reachable
    // history. The pre-push hook does the same when the remote sha
    // is 40 zeros.
    revListArgs = ['rev-list', '--all'];
  }
  const revList = spawnSync('git', ['-C', checkoutPath, ...revListArgs], {
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (revList.status !== 0) {
    return {
      refused: [],
      skippedReason: `git rev-list failed: ${(revList.stderr || '').trim() || `exit ${revList.status}`}`,
    };
  }
  const commits = revList.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, maxCommits);

  if (commits.length === 0) {
    return { refused: [], skippedReason: null };
  }

  const seenBlobs = new Set<string>();
  const refused: import('../types.js').RefusedCommittedFile[] = [];

  for (const commit of commits) {
    const ls = spawnSync(
      'git',
      ['-C', checkoutPath, 'ls-tree', '-r', '-l', '-z', commit],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    if (ls.status !== 0) continue;
    // -z output: NUL-terminated `<mode> <type> <sha> <size>\t<path>`
    // entries. We split on NUL, then parse each row by hand because
    // the path may contain spaces / tabs (NUL is the only safe
    // delimiter).
    const text = ls.stdout.toString('utf-8');
    const rows = text.split('\0').filter((r) => r.length > 0);
    for (const row of rows) {
      const tabIdx = row.indexOf('\t');
      if (tabIdx === -1) continue;
      const meta = row.slice(0, tabIdx).split(/\s+/);
      const path = row.slice(tabIdx + 1);
      if (meta.length < 4) continue;
      const [, type, sha, sizeStr] = meta;
      if (type !== 'blob') continue;
      if (seenBlobs.has(sha)) continue;
      seenBlobs.add(sha);
      const bytes = sizeStr === '-' ? 0 : Number.parseInt(sizeStr, 10);
      // Deny-list — same order as the Perl hooks.
      let reason: import('../types.js').RefusedCommittedFile['reason'] | null = null;
      if (isControlBytePath(path)) reason = 'control-bytes';
      else if (isSecretPath(path)) reason = 'secret';
      else if (isBuildArtefactPath(path)) reason = 'build-artefact';
      else if (Number.isFinite(bytes) && bytes > maxBytes) reason = 'oversize';
      if (reason !== null) {
        refused.push({
          path,
          reason,
          bytes: Number.isFinite(bytes) ? bytes : 0,
          commit,
          blobSha: sha,
        });
      }
    }
  }

  return { refused, skippedReason: null };
}

/**
 * Result of {@link installSafeCommitHooks}.
 *
 * Two hooks are installed in tandem (Task #209, deterministic
 * enforcement):
 *
 *  - `.git/hooks/pre-commit` — refuses to *create* a commit that
 *    contains any unsafe staged file. This is the primary gate; if
 *    the commit never happens, no bad blob enters local history and
 *    nothing pathological can leak into the user's eventual push.
 *  - `.git/hooks/pre-push` — defence-in-depth, walks **every commit
 *    being pushed** (not just `HEAD`) and refuses if any blob in any
 *    of those commits trips the deny-list. This catches the residual
 *    case of pre-existing bad commits in the repo's history that
 *    pre-date hook installation.
 *
 * Together they implement the "never get staged → never get pushed"
 * contract the task asks for: pre-commit prevents *new* offenders,
 * pre-push catches *historical* ones.
 */
export interface InstallSafeCommitHooksResult {
  /** Absolute path to the installed `pre-commit` hook. */
  preCommitHookPath: string;
  /** Absolute path to the installed `pre-push` hook. */
  prePushHookPath: string;
  /**
   * True iff BOTH hooks were successfully written + chmod'd. The
   * dispatch layer turns `installed: false` (when `.git` exists) into
   * a hard dispatch failure — silent fallback was the gap the first
   * architect review caught, so we conservatively report success only
   * when the full safety net is in place.
   */
  installed: boolean;
}

/**
 * Pre-commit hook body. Reads the staged index via
 * `git ls-files -s -z` (NUL-delimited, robust against pathological
 * filenames) and refuses the commit on the first deny-list match.
 *
 * Why a hook (vs the dispatch preamble step alone)? The preamble is
 * advisory text the agent might skip; a `pre-commit` hook is
 * deterministic — git invokes it before recording the commit, and a
 * non-zero exit aborts the commit. Even `git commit -n` (which
 * bypasses the hook) is explicitly forbidden in the preamble
 * alongside `git push --no-verify`.
 */
const PRE_COMMIT_HOOK_BODY = `#!/usr/bin/env perl
# Auto-installed by OrionOmega coding mode (Task #209).
# Refuses to record a commit whose staged index contains:
#   - any blob > 95 MB
#   - anything under node_modules/.next/dist/build/.cache/.turbo/coverage
#   - any .env* (except .env.example / .env.sample)
#   - any *.{pem,key,p12,pfx}
#   - any path containing control bytes (0x01-0x1F)
#
# This is the PRIMARY gate — if the commit never happens, the bad
# blob never enters local history, and the pre-push hook never has
# to deal with it. Bypass requires \`git commit -n\` / --no-verify,
# which the dispatch preamble explicitly forbids.

use strict;
use warnings;
use IPC::Open2;

my \$MAX = 95 * 1024 * 1024;
my @bad;

# git ls-files -s -z emits NUL-delimited records of the form:
#   "<mode> SP <sha> SP <stage>\\t<path>\\0"
# Capture (sha, path) for every staged entry.
open(my \$lf, '-|', 'git', 'ls-files', '-s', '-z') or exit 0;
local \$/ = "\\0";
my @entries;
while (my \$rec = <\$lf>) {
  chomp \$rec;
  next if \$rec eq '';
  my (\$meta, \$path) = split /\\t/, \$rec, 2;
  next unless defined \$path;
  my @f = split /\\s+/, \$meta;
  next unless @f >= 3;
  push @entries, { sha => \$f[1], path => \$path };
}
close(\$lf);

# Batch-resolve sizes in one cat-file pass — far faster than forking
# git cat-file -s once per file when the index is large.
# Declare the IPC handles + pid in the outer scope so the eval{} guard
# can populate them and the read loop below can still see them under
# strict mode. (Inline lexicals declared inside open2(...) do not
# escape to the surrounding scope.)
my %size;
if (@entries) {
  my \$cf_in;
  my \$cf_out;
  my \$pid = eval {
    open2(\$cf_out, \$cf_in,
      'git', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)');
  };
  # eval failure → git missing or open2 unavailable. Best-effort no-op
  # rather than block the commit; the pre-push hook is still the
  # belt-and-braces gate before code leaves the machine.
  if (!defined \$pid) { exit 0 }
  print \$cf_in "\$_->{sha}\\n" for @entries;
  close(\$cf_in);
  while (my \$line = <\$cf_out>) {
    chomp \$line;
    my (\$sha, \$type, \$sz) = split /\\s+/, \$line;
    next unless defined \$type && \$type eq 'blob' && \$sz =~ /^\\d+\$/;
    \$size{\$sha} = \$sz + 0;
  }
  close(\$cf_out);
  waitpid(\$pid, 0);
}

for my \$e (@entries) {
  my \$path = \$e->{path};
  my \$sha  = \$e->{sha};
  my \$sz   = \$size{\$sha};
  next unless defined \$sz;

  if (\$path =~ /[\\x01-\\x1f]/) {
    push @bad, "<staged path with control characters; rename it>";
    next;
  }
  if (\$sz > \$MAX) {
    push @bad, "\$path (\$sz bytes, >95 MB GitHub-safe limit)";
    next;
  }
  if (\$path =~ m{^(?:node_modules|\\.next|dist|build|\\.cache|\\.turbo|coverage)/}) {
    push @bad, "\$path (build artefact)";
    next;
  }
  (my \$base = \$path) =~ s{.*/}{};
  next if \$base eq '.env.example' || \$base eq '.env.sample';
  if (\$base eq '.env' || \$base =~ /^\\.env\\./) {
    push @bad, "\$path (secret / env file)";
    next;
  }
  if (\$base =~ /\\.(?:pem|key|p12|pfx)\$/) {
    push @bad, "\$path (secret / key material)";
    next;
  }
}

if (@bad) {
  print STDERR "OrionOmega safe-commit hook (Task #209) refusing this commit:\\n";
  print STDERR "  - \$_\\n" for @bad;
  print STDERR "\\nFix: \\\`git rm --cached <file>\\\` (or \\\`git restore --staged <file>\\\`)\\n";
  print STDERR "and ensure the matching pattern is in .gitignore, then re-commit.\\n";
  print STDERR "For files that legitimately belong in the repo but exceed 95 MB,\\n";
  print STDERR "set up Git LFS first.\\n";
  exit 1;
}
exit 0;
`;

/**
 * Pre-push hook body. Walks **every commit being pushed** (per the
 * git-pre-push contract: stdin lines of
 * `<local_ref> <local_sha> <remote_ref> <remote_sha>`), then for each
 * commit walks its tree via `git ls-tree -r -l -z <commit>` and
 * applies the deny-list to every blob. Blobs are deduplicated by
 * SHA across commits so re-pushing a deep history is cheap.
 *
 * This catches the residual case the pre-commit hook can't help with:
 * a bad blob that landed in the repo's history *before* the safe-
 * commit hooks were installed (e.g. the user's pre-existing repo).
 *
 * Falls back to walking the `HEAD` tree when stdin is empty (manual
 * invocation, integration tests, `git push` with no refs to push) so
 * the hook is still useful as a one-shot audit tool.
 */
const PRE_PUSH_HOOK_BODY = `#!/usr/bin/env perl
# Auto-installed by OrionOmega coding mode (Task #209).
# Safety net: refuse to push anything that would either bust GitHub's
# 100 MB blob limit or leak secrets / build artefacts.
# Edit at your own risk — the hook is reinstalled on every coding-mode
# dispatch, so manual changes will be overwritten.
#
# NOTE: this hook can be bypassed with \`git push --no-verify\`. The
# coding-mode preamble explicitly forbids that flag; we treat the hook
# as defence-in-depth, not a user-hostile lock.
#
# Why perl, not POSIX shell + awk? \`git ls-tree -z\` emits NUL-
# delimited records that may contain TAB / LF / arbitrary control
# bytes inside paths. Mawk's RS='\\0' support is unreliable across
# distros, and POSIX \`read\` has no -d flag, so any line-based shell
# parse can be smuggled past with a path like "evil\\nnode_modules/x".
# Perl's \`local \$/ = "\\0"\` does true NUL-record processing in one
# line, and perl is a hard transitive dependency of git itself
# (git-add--interactive, git-stash, git-send-email, …) so it is
# present everywhere git is present.

use strict;
use warnings;

my \$MAX = 95 * 1024 * 1024;
my @bad;

# Determine which commits are about to be pushed. Pre-push receives
# zero or more lines on stdin:
#   "<local_ref> <local_sha> <remote_ref> <remote_sha>\\n"
# remote_sha == 0{40} means the remote has no such ref yet — push the
# whole reachable history of local_sha. Otherwise push the range
# remote_sha..local_sha (the new commits). local_sha == 0{40} means a
# delete-only push — nothing new to inspect.
my @ranges;
while (my \$line = <STDIN>) {
  chomp \$line;
  my (\$lref, \$lsha, \$rref, \$rsha) = split /\\s+/, \$line;
  next unless defined \$lsha;
  next if \$lsha =~ /^0+\$/;            # pure delete — nothing to scan
  if (!defined \$rsha || \$rsha =~ /^0+\$/) {
    push @ranges, \$lsha;                # new ref — walk all reachable
  } else {
    push @ranges, "\$rsha..\$lsha";      # incremental
  }
}

# Manual invocation / no-stdin / integration tests: fall back to the
# HEAD tree so the hook still provides a useful one-shot audit.
my \$fallback_to_head = !@ranges;
push @ranges, 'HEAD' if \$fallback_to_head;

# Deduplicate blob SHAs across every (range, commit, tree) we walk so
# a deep history with many commits referring to the same file isn't
# re-classified hundreds of times.
my %seen_blob;

sub classify {
  my (\$path, \$size) = @_;
  # Reject ANY control character in the path. 0x01–0x1F includes
  # TAB (0x09), LF (0x0A), VT, FF, CR (0x0D), so a filename like
  # "evil\\nnode_modules/x" is caught here against the intact NUL-
  # record path before any other classifier runs.
  if (\$path =~ /[\\x01-\\x1f]/) {
    push @bad, "<path with control characters; rename it>";
    return;
  }
  if (\$size > \$MAX) {
    push @bad, "\$path (\$size bytes, >95 MB GitHub-safe limit)";
    return;
  }
  if (\$path =~ m{^(?:node_modules|\\.next|dist|build|\\.cache|\\.turbo|coverage)/}) {
    push @bad, "\$path (build artefact)";
    return;
  }
  (my \$base = \$path) =~ s{.*/}{};
  return if \$base eq '.env.example' || \$base eq '.env.sample';
  if (\$base eq '.env' || \$base =~ /^\\.env\\./) {
    push @bad, "\$path (secret / env file)";
    return;
  }
  if (\$base =~ /\\.(?:pem|key|p12|pfx)\$/) {
    push @bad, "\$path (secret / key material)";
    return;
  }
}

sub walk_tree {
  my (\$commitish) = @_;
  open(my \$fh, '-|', 'git', 'ls-tree', '-r', '-l', '-z', \$commitish) or return;
  local \$/ = "\\0";
  while (my \$rec = <\$fh>) {
    chomp \$rec;
    next if \$rec eq '';
    # Format with -l -z: "<mode> <type> <sha> <size>\\t<path>"
    my (\$meta, \$path) = split /\\t/, \$rec, 2;
    next unless defined \$path;
    my @f = split /\\s+/, \$meta;
    next unless @f >= 4;
    my (\$mode, \$type, \$sha, \$size) = @f;
    next unless \$type eq 'blob';
    next unless \$size =~ /^\\d+\$/;
    next if \$seen_blob{\$sha}++;
    classify(\$path, \$size + 0);
  }
  close(\$fh);
}

for my \$range (@ranges) {
  if (\$fallback_to_head) {
    walk_tree(\$range);
    next;
  }
  # Enumerate every commit in the range (newest-first ordering is
  # fine — we dedupe by blob SHA anyway).
  open(my \$rl, '-|', 'git', 'rev-list', \$range) or next;
  while (my \$commit = <\$rl>) {
    chomp \$commit;
    next unless \$commit =~ /^[0-9a-f]{4,}\$/;
    walk_tree(\$commit);
  }
  close(\$rl);
}

if (@bad) {
  print STDERR "OrionOmega safe-commit hook (Task #209) refusing to push:\\n";
  print STDERR "  - \$_\\n" for @bad;
  print STDERR "\\nFix: remove the file(s) from the working tree, add the matching\\n";
  print STDERR "pattern to .gitignore, then \\\`git rm --cached <file>\\\` and re-commit.\\n";
  print STDERR "For files that legitimately belong in the repo but exceed 95 MB,\\n";
  print STDERR "set up Git LFS first. To purge a bad blob from history use\\n";
  print STDERR "\\\`git filter-repo\\\` (or BFG) before re-pushing.\\n";
  exit 1;
}
exit 0;
`;

/**
 * Install BOTH safe-commit hooks (pre-commit + pre-push) into a
 * checkout's `.git/hooks/`. Idempotent: each hook is overwritten on
 * every call so a stale version from a previous OrionOmega release
 * can't leave a checkout under-protected.
 *
 * No-op (returns `installed: false`) when `repoDir/.git` doesn't
 * exist — we never want to fabricate a `.git` directory just to drop
 * a hook into it. Bare repos (`.git` is a file pointing elsewhere)
 * are also skipped because the hook would have to live next to the
 * actual git dir, not next to the working tree.
 *
 * `installed: true` is returned only when BOTH hooks were written
 * AND made executable. The dispatch layer turns `installed: false`
 * (when `.git` exists) into a hard dispatch failure — silent
 * fallback was the gap the first architect review caught, so the
 * conservative "all-or-nothing" reporting is intentional.
 */
export function installSafeCommitHooks(repoDir: string): InstallSafeCommitHooksResult {
  const gitDir = join(repoDir, '.git');
  const hooksDir = join(gitDir, 'hooks');
  const preCommitHookPath = join(hooksDir, 'pre-commit');
  const prePushHookPath = join(hooksDir, 'pre-push');

  // Only proceed when `.git` is a real directory (rules out bare-repo
  // files and missing-clone cases).
  let isDir = false;
  try { isDir = statSync(gitDir).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    return { preCommitHookPath, prePushHookPath, installed: false };
  }

  // Truly atomic install (round-5 review): write both hooks + chmod
  // them under temp names FIRST, snapshot any pre-existing targets,
  // then rename into place. If anything fails — including chmod on
  // POSIX, where a non-executable hook is a silent disable — we
  // restore prior state and report installed=false. The caller turns
  // installed=false (with .git present) into a hard dispatch failure,
  // so we MUST never leave a half-installed state behind.
  const isPosix = process.platform !== 'win32';
  // Per-call random suffix avoids collisions if two installs ever race
  // on the same checkout (shouldn't happen, but cheap insurance).
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const preCommitTmp = `${preCommitHookPath}.installing.${suffix}`;
  const prePushTmp = `${prePushHookPath}.installing.${suffix}`;

  // In-memory snapshot of any pre-existing pre-commit hook so we can
  // restore it if the second rename fails after the first succeeded.
  // (We don't need a snapshot for pre-push: pre-push is renamed last,
  // so if it fails the original pre-push file is still untouched —
  // POSIX rename() either fully succeeds or leaves the target alone.)
  let preCommitPrev: Buffer | null = null;

  // Track which side-effects we've successfully performed so the
  // catch block knows what to undo. `tmpsCreated[i]=true` means the
  // temp file exists; `installedFinal[i]=true` means it's already in
  // its final location.
  let preCommitTmpCreated = false;
  let prePushTmpCreated = false;
  let preCommitInstalledFinal = false;

  try {
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }

    // Snapshot the pre-existing pre-commit target (if any) BEFORE we
    // touch anything. Used by the rollback path if the pre-push rename
    // fails after we've already swapped pre-commit into place.
    if (existsSync(preCommitHookPath)) {
      try { preCommitPrev = readFileSync(preCommitHookPath); } catch { preCommitPrev = null; }
    }

    // Phase 1: write + chmod both temp files. Either succeeds for both
    // or we throw and the catch unwinds.
    writeFileSync(preCommitTmp, PRE_COMMIT_HOOK_BODY, 'utf-8');
    preCommitTmpCreated = true;
    writeFileSync(prePushTmp, PRE_PUSH_HOOK_BODY, 'utf-8');
    prePushTmpCreated = true;

    // chmod failures on POSIX are FATAL — git silently skips
    // non-executable hooks, which would silently disable the entire
    // safety net. On Windows the FS doesn't have a meaningful execute
    // bit so chmod is best-effort there.
    try {
      chmodSync(preCommitTmp, 0o755);
    } catch (err) {
      if (isPosix) throw err;
    }
    try {
      chmodSync(prePushTmp, 0o755);
    } catch (err) {
      if (isPosix) throw err;
    }

    // Phase 2: rename into place. POSIX rename is atomic within a
    // filesystem, so each rename either fully succeeds or leaves the
    // target untouched. We can't make TWO renames jointly atomic, so
    // if the second one fails we manually restore the first from our
    // in-memory snapshot.
    renameSync(preCommitTmp, preCommitHookPath);
    preCommitTmpCreated = false;
    preCommitInstalledFinal = true;

    renameSync(prePushTmp, prePushHookPath);
    prePushTmpCreated = false;

    return { preCommitHookPath, prePushHookPath, installed: true };
  } catch {
    // Roll back every side-effect we managed to perform, in reverse
    // order. Best-effort — if rollback itself fails we report
    // installed=false and the caller (prepareCodingDispatch) will
    // surface that as a hard dispatch failure.
    if (preCommitInstalledFinal) {
      // pre-commit was renamed into place but pre-push failed → restore
      // pre-commit to its prior content (or remove if there wasn't one).
      try {
        if (preCommitPrev !== null) {
          writeFileSync(preCommitHookPath, preCommitPrev);
        } else {
          unlinkSync(preCommitHookPath);
        }
      } catch { /* best effort */ }
    }
    if (preCommitTmpCreated) {
      try { unlinkSync(preCommitTmp); } catch { /* best effort */ }
    }
    if (prePushTmpCreated) {
      try { unlinkSync(prePushTmp); } catch { /* best effort */ }
    }
    return { preCommitHookPath, prePushHookPath, installed: false };
  }
}

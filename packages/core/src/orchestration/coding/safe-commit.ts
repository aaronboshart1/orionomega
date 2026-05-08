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
  // Environment files (secrets)
  '.env',
  '.env.local',
  '.env.*.local',
  '.env.development',
  '.env.production',
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
 * Result of {@link installSafeCommitHook}.
 */
export interface InstallSafeCommitHookResult {
  /** Absolute path to the installed hook (`.git/hooks/pre-push`). */
  hookPath: string;
  /** True if the hook was newly created or rewritten on this call. */
  installed: boolean;
}

/**
 * POSIX-shell pre-push hook body. Inlined as a constant so the
 * installer is a single `writeFileSync` call and the hook source
 * lives next to the policy it enforces.
 *
 * The hook walks `git ls-tree -r -l HEAD` (mode/type/sha/size/path
 * for every blob in the HEAD tree — i.e. the snapshot the agent is
 * trying to push), then rejects on:
 *
 *   - Any single blob > 95 MB (GitHub's 100 MB hard limit minus
 *     a margin).
 *   - Anything under a known build-artefact directory.
 *   - Any `.env*` (except `.env.example` / `.env.sample`) or
 *     `*.{pem,key,p12,pfx}` file.
 *
 * The hook is intentionally self-contained — no Node, no jq, no
 * `find`. It uses only POSIX `awk` + git plumbing so it runs on the
 * Replit container, on macOS, and on Linux CI without surprises.
 *
 * The error message is shaped so git's own `pre-push hook declined`
 * banner is followed by a clear, actionable list of offending files.
 * Our existing rule "if `git push` fails, fail the run with the
 * verbatim stderr" then surfaces this to the user untouched.
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

open(my \$fh, '-|', 'git', 'ls-tree', '-r', '-l', '-z', 'HEAD') or exit 0;
local \$/ = "\\0";
while (my \$rec = <\$fh>) {
  chomp \$rec;             # strip trailing NUL
  next if \$rec eq '';

  # Format with -l -z: "<mode> <type> <sha> <size>\\t<path>"
  my (\$meta, \$path) = split /\\t/, \$rec, 2;
  next unless defined \$path;
  my @f = split /\\s+/, \$meta;
  next unless @f >= 4;
  my \$size = \$f[3];
  next unless \$size =~ /^\\d+\$/;

  # Reject ANY control character in the path. 0x01–0x1F includes
  # TAB (0x09), LF (0x0A), VT, FF, CR (0x0D), so a filename like
  # "evil\\nnode_modules/x" is caught here against the intact NUL-
  # record path before any other classifier runs.
  if (\$path =~ /[\\x01-\\x1f]/) {
    push @bad, "<path with control characters; rename it>";
    next;
  }

  if (\$size > \$MAX) {
    push @bad, "\$path (\$size bytes, >95 MB GitHub-safe limit)";
    next;
  }

  # Build artefacts — first path segment must be one of these dirs.
  if (\$path =~ m{^(?:node_modules|\\.next|dist|build|\\.cache|\\.turbo|coverage)/}) {
    push @bad, "\$path (build artefact)";
    next;
  }

  # Basename for secret matching.
  (my \$base = \$path) =~ s{.*/}{};

  # Allowed conventional placeholders.
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
close(\$fh);

if (@bad) {
  print STDERR "OrionOmega safe-commit hook (Task #209) refusing to push:\\n";
  print STDERR "  - \$_\\n" for @bad;
  print STDERR "\\nFix: remove the file(s) from the working tree, add the matching\\n";
  print STDERR "pattern to .gitignore, then \\\`git rm --cached <file>\\\` and re-commit.\\n";
  print STDERR "For files that legitimately belong in the repo but exceed 95 MB,\\n";
  print STDERR "set up Git LFS first.\\n";
  exit 1;
}
exit 0;
`;

/**
 * Install the safe-commit pre-push hook into a checkout's
 * `.git/hooks/pre-push`. Idempotent: the hook is overwritten on every
 * call so a stale version from a previous OrionOmega release can't
 * leave a checkout under-protected.
 *
 * No-op (returns `installed: false`) when `repoDir/.git` doesn't
 * exist — we never want to fabricate a `.git` directory just to drop
 * a hook into it. Bare repos (`.git` is a file pointing elsewhere)
 * are also skipped because the hook would have to live next to the
 * actual git dir, not next to the working tree.
 */
export function installSafeCommitHook(repoDir: string): InstallSafeCommitHookResult {
  const gitDir = join(repoDir, '.git');
  // Only proceed when `.git` is a real directory (rules out bare-repo
  // files and missing-clone cases).
  let isDir = false;
  try { isDir = statSync(gitDir).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    return { hookPath: join(gitDir, 'hooks', 'pre-push'), installed: false };
  }

  const hooksDir = join(gitDir, 'hooks');
  const hookPath = join(hooksDir, 'pre-push');
  // Catch the FS work as a unit so the caller gets a single, clear
  // signal: hookPath + installed:false. The dispatch layer turns
  // installed=false (when .git exists) into a hard dispatch failure,
  // which is the deterministic-enforcement contract.
  try {
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }
    writeFileSync(hookPath, PRE_PUSH_HOOK_BODY, 'utf-8');
    // 0o755 — readable + executable by everyone, writable by owner.
    // Git silently skips hooks that aren't executable, so this is the
    // single most important line in the installer.
    try { chmodSync(hookPath, 0o755); } catch { /* Windows etc. — best effort */ }
    return { hookPath, installed: true };
  } catch {
    return { hookPath, installed: false };
  }
}

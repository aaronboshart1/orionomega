/**
 * @module orchestration/coding/project-fingerprint
 * ProjectFingerprint persistence and cache invalidation (Section 7.3 of spec).
 *
 * The fingerprint caches the result of the codebase scanner so that
 * subsequent sessions skip the expensive full scan.
 *
 * Invalidation rules (from spec):
 *   1. >10% of indexed files have changed (git diff detects new/modified/deleted)
 *   2. 24-hour TTL (hard expiry)
 *   3. Explicit --reindex flag (caller passes force=true)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodebaseScanOutput } from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const execAsync = promisify(execCb);
const log = createLogger('project-fingerprint');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Extended codebase scan result with cache-validity metadata.
 * Cached at {workspaceDir}/.orion/fingerprint.json.
 */
export interface ProjectFingerprint extends CodebaseScanOutput {
  /** Absolute workspace directory path this fingerprint was built for. */
  workspaceDir: string;
  /** Total number of source files at build time (for change-ratio calculation). */
  fileCount: number;
  /** Git HEAD commit hash at build time (for changed-file count). */
  gitHeadCommit: string;
  /** Unix timestamp (ms) when this fingerprint was created. */
  createdAt: number;
  /** Unix timestamp (ms) of the last cache validity check. */
  checkedAt: number;
}

/** Result of a cache validity check. */
export interface FingerprintValidity {
  /** Whether the cached fingerprint is still valid. */
  valid: boolean;
  /** Human-readable reason for invalidity (if not valid). */
  reason?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FINGERPRINT_FILE = 'fingerprint.json';
const FINGERPRINT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FILE_CHANGE_THRESHOLD = 0.10; // 10%

// ── Persistence ───────────────────────────────────────────────────────────────

function getOrionDir(workspaceDir: string, orionDir?: string): string {
  return orionDir ?? join(workspaceDir, '.orion');
}

/**
 * Save a ProjectFingerprint to {workspaceDir}/.orion/fingerprint.json.
 *
 * @param fingerprint - The fingerprint to persist.
 * @param orionDir    - Override for the .orion directory (useful in tests).
 */
export function saveFingerprint(fingerprint: ProjectFingerprint, orionDir?: string): void {
  const dir = getOrionDir(fingerprint.workspaceDir, orionDir);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, FINGERPRINT_FILE),
      JSON.stringify(fingerprint, null, 2),
      'utf-8',
    );
    log.info('Saved project fingerprint', { workspaceDir: fingerprint.workspaceDir });
  } catch (err) {
    log.warn('Failed to save fingerprint', { err });
  }
}

/**
 * Load a previously saved fingerprint from disk.
 *
 * @param workspaceDir - The workspace directory.
 * @param orionDir     - Override for the .orion directory.
 * @returns The fingerprint or null if not found / unreadable.
 */
export function loadFingerprint(workspaceDir: string, orionDir?: string): ProjectFingerprint | null {
  const fingerprintPath = join(getOrionDir(workspaceDir, orionDir), FINGERPRINT_FILE);
  if (!existsSync(fingerprintPath)) return null;
  try {
    const raw = readFileSync(fingerprintPath, 'utf-8');
    const fp = JSON.parse(raw) as ProjectFingerprint;
    // Basic schema check
    if (!fp.workspaceDir || !fp.createdAt || typeof fp.fileCount !== 'number') {
      return null;
    }
    // Guard against cross-workspace cache pollution
    if (fp.workspaceDir !== workspaceDir) return null;
    return fp;
  } catch {
    return null;
  }
}

// ── Cache validity ────────────────────────────────────────────────────────────

/**
 * Compute the number of files changed since the fingerprint was built
 * by running `git diff --name-only <commit> HEAD`.
 */
async function countChangedFilesSince(workspaceDir: string, sinceCommit: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `git diff --name-only ${sinceCommit} HEAD 2>/dev/null`,
      { cwd: workspaceDir, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim().split('\n').filter(Boolean).length;
  } catch {
    // If git fails (e.g. no git, or commit not found), assume changed
    return Infinity;
  }
}

/**
 * Get the current git HEAD commit hash.
 */
async function getCurrentHeadCommit(workspaceDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: workspaceDir });
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Check whether a cached ProjectFingerprint is still valid.
 *
 * Invalidity conditions:
 *   1. TTL expired (> 24 hours since creation)
 *   2. > 10% of indexed files have changed since the fingerprint was built
 *
 * @param fingerprint  - The cached fingerprint to validate.
 * @param force        - If true, always return invalid (--reindex semantics).
 */
export async function isFingerprintValid(
  fingerprint: ProjectFingerprint,
  force = false,
): Promise<FingerprintValidity> {
  if (force) {
    return { valid: false, reason: 'force reindex requested' };
  }

  // Check TTL
  const age = Date.now() - fingerprint.createdAt;
  if (age > FINGERPRINT_TTL_MS) {
    return { valid: false, reason: `TTL expired (${Math.round(age / 3600000)}h old, max 24h)` };
  }

  // Check file change ratio
  if (fingerprint.gitHeadCommit) {
    const changedCount = await countChangedFilesSince(
      fingerprint.workspaceDir,
      fingerprint.gitHeadCommit,
    );
    if (fingerprint.fileCount > 0) {
      const changeRatio = changedCount / fingerprint.fileCount;
      if (changeRatio > FILE_CHANGE_THRESHOLD) {
        return {
          valid: false,
          reason: `${Math.round(changeRatio * 100)}% of files changed (threshold: ${FILE_CHANGE_THRESHOLD * 100}%)`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Compute the fraction of files that have changed since a reference commit.
 * Returns a value in [0, 1]; returns 1 if git is unavailable or ref not found.
 */
export async function computeFileChangeRatio(
  workspaceDir: string,
  sinceCommit: string,
  totalFileCount: number,
): Promise<number> {
  if (totalFileCount === 0) return 0;
  const changed = await countChangedFilesSince(workspaceDir, sinceCommit);
  return Math.min(changed / totalFileCount, 1);
}

// ── Load-or-build helper ──────────────────────────────────────────────────────

/**
 * Load a valid cached fingerprint or return null if the cache is stale/missing.
 *
 * The caller is responsible for building a fresh fingerprint and calling
 * saveFingerprint() when null is returned.
 *
 * @param workspaceDir - The workspace directory.
 * @param force        - Force cache invalidation.
 * @param orionDir     - Override for the .orion directory.
 */
export async function loadValidFingerprint(
  workspaceDir: string,
  force = false,
  orionDir?: string,
): Promise<ProjectFingerprint | null> {
  const cached = loadFingerprint(workspaceDir, orionDir);
  if (!cached) return null;

  const validity = await isFingerprintValid(cached, force);
  if (!validity.valid) {
    log.info('Fingerprint cache invalid, will rebuild', { reason: validity.reason });
    return null;
  }

  log.info('Using cached project fingerprint', {
    age: Math.round((Date.now() - cached.createdAt) / 60000) + 'min',
    files: cached.fileCount,
  });
  return cached;
}

/**
 * Build a ProjectFingerprint from a CodebaseScanOutput and workspace metadata.
 *
 * @param scan         - The result of the codebase scanner.
 * @param workspaceDir - Absolute workspace directory.
 */
export async function buildFingerprint(
  scan: CodebaseScanOutput,
  workspaceDir: string,
): Promise<ProjectFingerprint> {
  const gitHeadCommit = await getCurrentHeadCommit(workspaceDir);
  const now = Date.now();
  return {
    ...scan,
    workspaceDir,
    fileCount: scan.relevantFiles.length,
    gitHeadCommit,
    createdAt: now,
    checkedAt: now,
  };
}

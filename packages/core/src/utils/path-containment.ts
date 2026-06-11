/**
 * @module utils/path-containment
 *
 * Task #232: Single source of truth for file-access containment. Every
 * boundary that resolves a caller-supplied path under a trusted root —
 * the gateway file-read endpoint, the coding-mode spec-loader, etc. —
 * routes through these helpers instead of hand-rolling its own
 * `resolve` + `startsWith` guard. Centralising the logic removes the
 * subtle per-boundary differences (some used `realpathSync`, some did
 * not; some forgot the trailing-separator check that lets
 * `/workspace-evil` masquerade as living under `/workspace`).
 *
 * Two flavours are provided:
 *   - {@link resolveContainedPath} — pure, filesystem-free. Resolves
 *     `..` / `.` segments lexically and rejects anything that escapes
 *     the root. Use when the target may not exist yet, or when reads go
 *     through an injected/virtual filesystem (unit tests, spec-loader).
 *   - {@link realpathContainedPath} — symlink-aware. Resolves both root
 *     and target through `realpathSync`, defeating symlink-based escapes
 *     (`<root>/link → /etc`). Both must already exist on disk. Use at
 *     real filesystem boundaries (gateway file-read).
 */

import { resolve as resolvePath, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * True when `candidate` is the root itself or lives strictly underneath
 * it. The trailing-separator check is the important part: without it
 * `/workspace-evil`.startsWith('/workspace') would be a false positive.
 *
 * Both arguments must already be absolute, normalised paths.
 */
export function isPathInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/**
 * Resolve `target` against `root` (lexically, no filesystem access) and
 * return the absolute path **only if it stays inside `root`**; otherwise
 * return `null`.
 *
 * `target` may be relative (resolved under `root`) or absolute (must
 * still fall under `root`). Path-traversal sequences (`../../etc/passwd`)
 * resolve out of the root and are rejected.
 */
export function resolveContainedPath(root: string, target: string): string | null {
  const absRoot = resolvePath(root);
  const candidate = resolvePath(absRoot, target);
  return isPathInside(absRoot, candidate) ? candidate : null;
}

/**
 * Symlink-aware variant of {@link resolveContainedPath}. Resolves both
 * `root` and the candidate through `realpathSync` so a symlink inside
 * the root that points outside it is caught. Returns the canonical
 * (real) absolute path when contained, or `null` when the path escapes,
 * does not exist, or cannot be resolved.
 *
 * Because `realpathSync` requires the target to exist, callers that need
 * to distinguish "not found" from "outside workspace" should `existsSync`
 * first and treat `null` here as the containment failure.
 */
export function realpathContainedPath(root: string, target: string): string | null {
  try {
    const absRoot = realpathSync(resolvePath(root));
    const candidate = resolvePath(absRoot, target);
    const real = realpathSync(candidate);
    return isPathInside(absRoot, real) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Try a list of roots in priority order, returning the first
 * {@link resolveContainedPath} that succeeds. Mirrors the spec-loader's
 * "try checkout, then workspace" probing.
 */
export function resolveContainedPathInRoots(roots: string[], target: string): string | null {
  for (const root of roots) {
    const resolved = resolveContainedPath(root, target);
    if (resolved) return resolved;
  }
  return null;
}

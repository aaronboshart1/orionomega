/**
 * @module utils/install-dir
 * Shared helpers for detecting writes that leak into the OrionOmega install
 * tree (`~/.orionomega/...`) **or** the OrionOmega monorepo source tree
 * when running from a dev checkout (`<repo>/packages/<pkg>/src/...`).
 *
 * Used by both the orchestration executor's CODING_AGENT post-step check
 * and the main agent's direct-mode `write_file` tool, so the two code
 * paths agree on what counts as a leak. The Direct-mode write guard
 * (Task #216) refuses any write that lands under one of these roots so
 * the chat agent can never silently corrupt OrionOmega's own source —
 * regardless of how it was launched.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the OrionOmega install directory roots that deliverable writes
 * must never land in. Includes the conventional `~/.orionomega` location and,
 * if discoverable, the install root surfaced by the update command via
 * `process.env.ORIONOMEGA_INSTALL_DIR`.
 */
export function getOrionOmegaInstallRoots(): string[] {
  const roots = new Set<string>();
  try {
    roots.add(resolvePath(homedir(), '.orionomega'));
  } catch { /* ignore */ }
  const envRoot = process.env.ORIONOMEGA_INSTALL_DIR;
  if (envRoot) {
    try { roots.add(resolvePath(envRoot)); } catch { /* ignore */ }
  }
  return [...roots];
}

let _sourceRootsCache: string[] | null = null;

/**
 * When OrionOmega is running from a dev checkout (i.e. `pnpm --filter
 * @orionomega/core ...` against the monorepo, rather than the bundled
 * `~/.orionomega` install), return the absolute path of the monorepo's
 * `packages/` directory. The Direct-mode write guard treats anything
 * under this path as the OrionOmega source tree itself and refuses to
 * write to it — so a confused chat agent cannot silently edit
 * `packages/core/src/agent/main-agent.ts` while the user thinks they
 * asked for a fix in their own repo.
 *
 * Detection: walk up from this module's own location until we find a
 * directory that contains BOTH `pnpm-workspace.yaml` and a `packages/`
 * subdirectory. Cached after first call — the install layout doesn't
 * change at runtime. Returns an empty array when no monorepo root is
 * found (the bundled install case).
 */
export function getOrionOmegaSourceRoots(): string[] {
  if (_sourceRootsCache) return _sourceRootsCache;
  const roots = new Set<string>();
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i++) {
      const ws = resolvePath(dir, 'pnpm-workspace.yaml');
      const pkgs = resolvePath(dir, 'packages');
      if (existsSync(ws) && existsSync(pkgs)) {
        roots.add(pkgs);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  _sourceRootsCache = [...roots];
  return _sourceRootsCache;
}

/** @internal exposed for tests so they can flip env / cwd between cases. */
export function _resetOrionOmegaSourceRootsCache(): void {
  _sourceRootsCache = null;
}

/**
 * Return every protected OrionOmega root: install roots (always) +
 * dev-checkout source roots (when applicable). Both kinds of root are
 * off-limits for Direct-mode deliverable writes.
 */
export function getProtectedOrionOmegaRoots(): string[] {
  return [...getOrionOmegaInstallRoots(), ...getOrionOmegaSourceRoots()];
}

/**
 * Returns the subset of `paths` that resolve under any OrionOmega
 * protected root (install dir OR dev-checkout source tree). Used both as
 * a regression warning by the orchestration executor and as a hard
 * write-time refusal by the Direct-mode tool dispatcher.
 *
 * Relative paths are resolved against `cwd` when provided, so a write
 * that reports `path: "src/foo.md"` is checked against `<cwd>/src/foo.md`
 * rather than `<process.cwd()>/src/foo.md`. Falls back to process cwd
 * if not provided.
 */
export function detectInstallDirWrites(paths: string[], cwd?: string): string[] {
  if (paths.length === 0) return [];
  const roots = getProtectedOrionOmegaRoots();
  if (roots.length === 0) return [];
  const offenders: string[] = [];
  for (const p of paths) {
    let resolved: string;
    try {
      resolved = cwd ? resolvePath(cwd, p) : resolvePath(p);
    } catch { continue; }
    for (const root of roots) {
      if (resolved === root || resolved.startsWith(root + '/')) {
        offenders.push(resolved);
        break;
      }
    }
  }
  return offenders;
}

/**
 * @module utils/install-dir
 * Shared helpers for detecting writes that leak into the OrionOmega install
 * tree (`~/.orionomega/...`). Used by both the orchestration executor's
 * CODING_AGENT post-step check and the main agent's direct-mode `write_file`
 * tool, so the two code paths agree on what counts as a leak.
 */

import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

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

/**
 * Returns the subset of `paths` that resolve under any OrionOmega install
 * root. Used to surface a regression warning if an agent ever writes
 * deliverables back into the install tree.
 *
 * Relative paths are resolved against `cwd` when provided, so a write that
 * reports `path: "src/foo.md"` is checked against `<cwd>/src/foo.md` rather
 * than `<process.cwd()>/src/foo.md`. Falls back to process cwd if not
 * provided.
 */
export function detectInstallDirWrites(paths: string[], cwd?: string): string[] {
  if (paths.length === 0) return [];
  const roots = getOrionOmegaInstallRoots();
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

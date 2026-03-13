/**
 * @module version
 * Runtime version info: package version + git short hash.
 * Resolved once at module load and cached.
 *
 * The git hash is resolved by explicitly passing `cwd` to `execSync`,
 * derived by walking up from this file's directory until a `.git` folder
 * is found.  This makes it work regardless of the process's working
 * directory (e.g. when launched via systemd).
 */

import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import path from 'path';

const _require = createRequire(import.meta.url);
const _dir = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until we find a directory containing `.git`. */
function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start);
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function readPackageVersion(): string {
  try {
    // Walk up from _dir to find the nearest package.json
    const pkg = _require(path.join(_dir, '..', 'package.json')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitHash(): string {
  try {
    const repoRoot = findRepoRoot(_dir);
    if (!repoRoot) return 'unknown';
    return execSync('git rev-parse --short HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** e.g. `v0.1.0 (8d5f9bc)` */
export const VERSION_STRING: string = `v${readPackageVersion()} (${readGitHash()})`;

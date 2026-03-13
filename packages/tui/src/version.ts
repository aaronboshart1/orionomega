/**
 * @module version
 * Runtime version info: package version + git short hash.
 * Resolved once at module load and cached.
 */

import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const _require = createRequire(import.meta.url);
const _dir = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    const pkg = _require(path.join(_dir, '..', 'package.json')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/** e.g. 'v0.1.0 (8d5f9bc)' */
export const VERSION_STRING: string = `v${readPackageVersion()} (${readGitHash()})`;

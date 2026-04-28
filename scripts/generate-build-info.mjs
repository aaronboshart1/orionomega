#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const packageName = process.argv[2];
if (!packageName) {
  console.error('[generate-build-info] Usage: node scripts/generate-build-info.mjs <package-name>');
  process.exit(2);
}

const pkgRoot = resolve(repoRoot, 'packages', packageName);
if (!existsSync(pkgRoot)) {
  console.error(`[generate-build-info] Package not found: ${pkgRoot}`);
  process.exit(2);
}

// Track whether ANY git command failed so we can degrade `dirty` gracefully
// in restricted environments (read-only checkouts, sandboxes that block
// `git status`'s implicit index lock acquisition, CI runners without a
// `.git` directory, etc.) rather than emitting a misleading `dirty: false`.
let gitAvailable = true;
function tryGit(args, cwd) {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim();
  } catch {
    gitAvailable = false;
    return '';
  }
}

const commit = tryGit('rev-parse HEAD', repoRoot) || 'unknown';
const shortCommit = commit !== 'unknown' ? commit.slice(0, 7) : 'unknown';
const branch = tryGit('rev-parse --abbrev-ref HEAD', repoRoot) || 'unknown';
// Prefer `diff --quiet` over `status --porcelain` because it does not need
// to acquire the index lock for refreshing the stat cache, and it returns
// a clean exit code (0=clean, 1=dirty) so we can tell apart "clean" from
// "command failed". Fall back to `status --porcelain` if `diff` itself
// errors. If everything fails we report dirty=false and rely on the
// `commit === 'unknown'` branch in `getStaleBuildStatus()` to flag stale.
let dirty = false;
if (gitAvailable && commit !== 'unknown') {
  try {
    execSync('git diff --quiet HEAD --', { cwd: repoRoot, stdio: 'ignore' });
    // exit 0 → clean
    dirty = false;
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && err.status === 1) {
      // exit 1 → dirty (this is the documented behavior)
      dirty = true;
    } else {
      // Anything else (signal, ENOENT, permission denied) — fall back to
      // status --porcelain, then to dirty=false if even that fails.
      const porcelain = tryGit('status --porcelain', repoRoot);
      dirty = porcelain.length > 0;
    }
  }
}
const buildTime = new Date().toISOString();

let pkgVersion = '0.0.0';
try {
  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
  pkgVersion = pkgJson.version ?? pkgVersion;
} catch { /* ignore */ }

const outDir = join(pkgRoot, 'src', 'generated');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'build-info.ts');

const content = `/**
 * @module generated/build-info
 *
 * AUTO-GENERATED at build time by scripts/generate-build-info.mjs.
 * Do not edit by hand. Do not commit.
 *
 * Records the git commit and build timestamp baked into this dist/ output so
 * the runtime can detect a stale build (i.e. dist/ compiled from a different
 * commit than the current source tree).
 */

export interface BuildInfo {
  /** Full git commit SHA the build was produced from. */
  readonly commit: string;
  /** Short (7-char) form of \`commit\` for display. */
  readonly shortCommit: string;
  /** Git branch the build was produced from. */
  readonly branch: string;
  /** True if the working tree had uncommitted changes at build time. */
  readonly dirty: boolean;
  /** ISO-8601 timestamp of when the build ran. */
  readonly buildTime: string;
  /** Package name this build belongs to. */
  readonly packageName: string;
  /** package.json version string. */
  readonly packageVersion: string;
}

export const BUILD_INFO: BuildInfo = {
  commit: ${JSON.stringify(commit)},
  shortCommit: ${JSON.stringify(shortCommit)},
  branch: ${JSON.stringify(branch)},
  dirty: ${dirty ? 'true' : 'false'},
  buildTime: ${JSON.stringify(buildTime)},
  packageName: ${JSON.stringify('@orionomega/' + packageName)},
  packageVersion: ${JSON.stringify(pkgVersion)},
};
`;

writeFileSync(outFile, content, 'utf-8');
console.log(`[generate-build-info] wrote ${outFile} (commit=${shortCommit}${dirty ? '-dirty' : ''})`);

/**
 * @module sandbox
 * Hardened-execution backend for skill handlers.
 *
 * The default (advisory) execution mode spawns a handler directly with sensitive
 * environment variables filtered out. Hardened mode goes further: it runs the
 * handler inside fresh Linux namespaces (mount / PID / network / IPC / UTS) so
 * that an untrusted handler gets a restricted filesystem view and cannot see or
 * signal host processes, nor reach the network.
 *
 * Isolation is provided by `unshare(1)` with a user namespace mapped to root,
 * which grants the mount capabilities needed to build the restricted view
 * without requiring the host process to run as root. No external dependency is
 * introduced — `util-linux`'s `unshare` ships on every Linux host.
 *
 * If a hardened run is requested but no namespace backend is available, callers
 * MUST fail rather than silently downgrade to advisory mode.
 */

import { spawnSync } from 'node:child_process';
import type { SandboxPolicy } from './types.js';

/** Identifies the sandbox mechanism available on the current host. */
export interface SandboxBackend {
  /** Backend kind — currently only Linux user-namespace `unshare`. */
  kind: 'unshare';
  /** Absolute path to the backend binary, when known. */
  binary: string;
}

let cachedBackend: SandboxBackend | null | undefined;

/**
 * Detect a usable sandbox backend, caching the result. Returns `null` when no
 * backend is available (non-Linux host, missing `unshare`, or user namespaces
 * disabled by the kernel/seccomp policy).
 */
export function detectSandboxBackend(forceRefresh = false): SandboxBackend | null {
  if (!forceRefresh && cachedBackend !== undefined) {
    return cachedBackend;
  }

  cachedBackend = probeUnshare();
  return cachedBackend;
}

function probeUnshare(): SandboxBackend | null {
  if (process.platform !== 'linux') {
    return null;
  }

  // Verify that a user namespace with a mapped root user can actually be
  // created AND can perform a mount — both are required for the restricted
  // filesystem view. A kernel that disables unprivileged user namespaces will
  // fail this probe, so we never claim hardening we cannot deliver.
  const probe = spawnSync(
    'unshare',
    ['--user', '--map-root-user', '--mount', 'sh', '-c', 'mount -t tmpfs none /tmp >/dev/null 2>&1 && echo ok'],
    { encoding: 'utf-8', timeout: 5_000 },
  );

  if (probe.status === 0 && probe.stdout.trim() === 'ok') {
    return { kind: 'unshare', binary: 'unshare' };
  }

  return null;
}

/** Reset the cached backend probe — used by tests. */
export function resetSandboxBackendCache(): void {
  cachedBackend = undefined;
}

/** Thrown when hardened execution is requested but cannot be provided. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

export interface SandboxedSpawn {
  /** The command to spawn (the namespace launcher). */
  command: string;
  /** Arguments for {@link command}, ending with the wrapped handler. */
  args: string[];
  /** Extra environment variables the sandbox prelude consumes. */
  env: Record<string, string>;
}

/**
 * Build the argv that runs `handlerPath` inside the hardened sandbox.
 *
 * @param handlerPath Absolute path to the (already-validated) handler script.
 * @param skillDir    Absolute path to the skill directory (mounted read-only).
 * @param policy      Optional fine-grained sandbox policy.
 * @throws SandboxUnavailableError when no backend is available.
 */
export function buildSandboxedSpawn(
  handlerPath: string,
  skillDir: string,
  policy: SandboxPolicy = {},
): SandboxedSpawn {
  const backend = detectSandboxBackend();
  if (!backend) {
    throw new SandboxUnavailableError(
      'Hardened skill execution was requested but no namespace sandbox backend ' +
        'is available on this host (Linux unprivileged user namespaces with ' +
        '`unshare` are required). Refusing to run the handler unsandboxed.',
    );
  }

  const readonlySkillDir = policy.readonlySkillDir ?? true;
  const isolateNetwork = policy.isolateNetwork ?? true;
  const hidePaths = (policy.hidePaths ?? []).filter((p) => p && p.startsWith('/'));

  const nsFlags = ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--ipc', '--uts'];
  if (isolateNetwork) {
    nsFlags.push('--net');
  }

  // The prelude runs as PID 1 inside the new namespaces, sets up the restricted
  // filesystem view, then `exec`s the handler so signals/exit codes propagate.
  // `set -e` ensures any setup failure aborts the run (no silent downgrade).
  const prelude = [
    'set -e',
    'mount --make-rprivate / 2>/dev/null || true',
    readonlySkillDir
      ? 'if [ -n "$__OO_RO_DIR" ] && [ -d "$__OO_RO_DIR" ]; then ' +
        'mount --bind "$__OO_RO_DIR" "$__OO_RO_DIR"; ' +
        'mount -o remount,ro,bind "$__OO_RO_DIR"; fi'
      : '',
    'if [ -n "$__OO_HIDE" ]; then ' +
      'printf "%s\\n" "$__OO_HIDE" | tr ":" "\\n" | while IFS= read -r p; do ' +
      '[ -n "$p" ] && [ -e "$p" ] && mount -t tmpfs none "$p" 2>/dev/null || true; ' +
      'done; fi',
    'H="$__OO_HANDLER"',
    'unset __OO_RO_DIR __OO_HIDE __OO_HANDLER',
    'exec "$H"',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    command: backend.binary,
    args: [...nsFlags, 'sh', '-c', prelude],
    env: {
      __OO_HANDLER: handlerPath,
      __OO_RO_DIR: readonlySkillDir ? skillDir : '',
      __OO_HIDE: hidePaths.join(':'),
    },
  };
}

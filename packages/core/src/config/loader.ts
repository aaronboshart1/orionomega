/**
 * @module config/loader
 * Configuration loading, writing, and default generation for OrionOmega.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { OrionOmegaConfig } from './types.js';
import { deepMerge } from '../utils/deep-merge.js';
import { createLogger } from '../logging/logger.js';
import { applyRegistryOverrides } from '../models/model-registry.js';

const log = createLogger('config-loader');

const require = createRequire(import.meta.url);

function getDataDir(): string {
  if (process.env.REPL_ID) {
    return join(process.cwd(), '.orionomega');
  }
  return join(homedir(), '.orionomega');
}

/**
 * Returns the default configuration path: `~/.orionomega/config.yaml`.
 * On Replit, uses the workspace directory for persistence across deployments.
 */
export function getConfigPath(): string {
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  return join(getDataDir(), 'config.yaml');
}

/**
 * Returns a complete configuration object with sensible defaults.
 */
export function getDefaultConfig(): OrionOmegaConfig {
  return {
    gateway: {
      port: 8000,
      bind: ['127.0.0.1'],
      auth: {
        // Authenticated by default (Task #231 — Security P0). On first start the
        // gateway auto-generates a random api-key secret (see
        // `ensureGatewayAuthSecret`) and persists its `keyHash` so local clients
        // (the web proxy / TUI) can mint signed tokens. Operators who genuinely
        // want an unauthenticated local-only gateway must explicitly set
        // `mode: 'none'` in config.yaml — and will then be refused a
        // non-localhost bind unless they also set ORIONOMEGA_ALLOW_INSECURE_BIND=1.
        mode: 'api-key',
      },
      cors: {
        origins: ['http://localhost:*'],
      },
    },
    hindsight: {
      url: 'http://localhost:8888',
      defaultBank: 'default',
      retainOnComplete: true,
      retainOnError: true,
    },
    models: {
      provider: 'anthropic',
      apiKey: '',
      default: '',
      planner: '',
      cheap: 'claude-haiku-4-5-20251001',
      workers: {},
    },
    orchestration: {
      maxSpawnDepth: 3,
      // Wall-clock budget for AGENT/TOOL nodes when the planner does not set one.
      // Bumped to 900s after observing repeated timeouts on GitHub-heavy research
      // nodes that need multiple API round-trips (MCS Legal 2 run).
      workerTimeout: 900,
      // Coding agents iterate (Read/Edit/Bash) and need a much larger envelope.
      // Bumped to 2700s after observing timeouts on large-document validation
      // tasks (83KB+ documents requiring chunked reading).
      codingAgentTimeout: 2700,
      // In-loop validation commands (build/test/lint) inside coding mode templates.
      validationTimeout: 300,
      // 0 = unlimited retries on transient failures; permanent errors still
      // short-circuit via classifyError() in executor.ts. Per-node `retries`
      // still wins, and 0 there keeps its original "no retries" meaning.
      maxRetries: 0,
      planFirst: true,
      checkpointInterval: 30,
      autoResume: false,
      defaultAgentMode: 'orchestrate',
      eventBatching: {
        tuiIntervalMs: 250,
        webIntervalMs: 1000,
        immediateTypes: ['error', 'done', 'finding'],
      },
      // Task #238 (R5): persistent task queue. In-process by default so local
      // dev needs zero setup; set backend: 'redis' + a redisUrl/REDIS_URL to
      // dispatch node jobs through a durable, restart-surviving Redis/BullMQ
      // queue that can be consumed by separate worker processes.
      queue: {
        backend: 'in-process',
      },
    },
    workspace: {
      path: join(homedir(), 'orionomega', 'workspace'),
      maxOutputSize: '10MB',
    },
    logging: {
      level: 'info',
      file: join(getDataDir(), 'logs', 'orionomega.log'),
      maxSize: '50MB',
      maxFiles: 5,
      console: true,
    },
    skills: {
      directory: join(getDataDir(), 'skills'),
      autoLoad: true,
    },
    webui: {
      port: 5000,
      bind: ['0.0.0.0'],
    },
    commands: {
      directory: join(homedir(), 'orionomega', 'commands'),
    },
    autonomous: {
      enabled: false,
      maxBudgetUsd: 50,
      maxDurationMinutes: 360,
      progressIntervalMinutes: 15,
      humanGates: ['deploy', 'merge', 'delete', 'destroy_vm'],
      autoAdvance: true,
    },
    agentSdk: {
      enabled: true,
      permissionMode: 'acceptEdits',
      effort: 'high',
      // R4: native context editing (auto-compaction) on by default so long
      // unattended AGENT/CODING_AGENT runs auto-trim stale tool results
      // instead of exhausting the context window. Set enabled:false to disable.
      contextEditing: { enabled: true },
      // Task #240 (R3): native multi-agent-session substrate pilot. OFF by
      // default — enabling it routes one eligible sub-DAG layer through a
      // single Anthropic native multi-agent session instead of in-house
      // per-node dispatch. See docs/architecture-notes.md.
      nativeSessions: { enabled: false, maxAgentsPerLayer: 8 },
    },
    codingMode: {
      enabled: true,
      maxParallelAgents: 4,
      templates: {
        'feature-implementation': true,
        'bug-fix': true,
        'refactor': true,
        'test-suite': true,
        'review-iterate': true,
      },
      models: {},
      validation: {
        autoRun: true,
        commands: [],   // Empty = auto-detect from package.json/Makefile
      },
      budgetMultiplier: 1.0,
      tierRouting: { enabled: true },
    },
  };
}

/**
 * Normalizes a bind value (string, comma-separated string, or array) into a
 * deduplicated array of trimmed, non-empty address strings.
 */
export function normalizeBindAddresses(bind: string | string[] | undefined): string[] {
  if (bind === undefined || bind === null) return ['127.0.0.1'];
  if (Array.isArray(bind)) {
    const addrs = bind.flatMap((b) => String(b).split(',')).map((s) => s.trim()).filter(Boolean);
    return [...new Set(addrs.length > 0 ? addrs : ['127.0.0.1'])];
  }
  const addrs = String(bind).split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(addrs.length > 0 ? addrs : ['127.0.0.1'])];
}

function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)}/g, (_match, name: string) => {
      return process.env[name] ?? '';
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateEnvVars(val);
    }
    return result;
  }
  return obj;
}

function isNonLocalhostBind(addresses: string[]): boolean {
  const localAddrs = new Set(['127.0.0.1', '::1', 'localhost']);
  return addresses.some((addr) => !localAddrs.has(addr));
}

/**
 * Reads and parses the YAML configuration file, merging with defaults.
 * If the file does not exist, returns the default configuration.
 *
 * @param configPath - Path to the YAML config file. Defaults to `getConfigPath()`.
 * @returns The fully-resolved configuration.
 */
export function readConfig(configPath?: string): OrionOmegaConfig {
  const filePath = configPath ?? getConfigPath();
  const defaults = getDefaultConfig();

  if (!existsSync(filePath) && process.env.REPL_ID) {
    const legacyPath = join(homedir(), '.orionomega', 'config.yaml');
    if (existsSync(legacyPath)) {
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      copyFileSync(legacyPath, filePath);
    }
  }

  if (!existsSync(filePath)) {
    return defaults;
  }

  const raw = readFileSync(filePath, 'utf-8');

  let yaml: typeof import('js-yaml');
  try {
     
    yaml = require('js-yaml') as typeof import('js-yaml');
  } catch {
    throw new Error(
      'js-yaml is required but not installed. Run: npm install js-yaml',
    );
  }

  const parsed = yaml.load(raw);
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return defaults;
  }

  const interpolated = interpolateEnvVars(parsed) as Record<string, unknown>;

  // Task #211: silently strip stale `agentSdk.maxTurns` from on-disk configs.
  // Max turns is now unlimited by default; lingering YAML keys would otherwise
  // be merged into the runtime config and surface in writeConfig() round-trips.
  const agentSdkRaw = interpolated.agentSdk;
  if (agentSdkRaw && typeof agentSdkRaw === 'object' && 'maxTurns' in agentSdkRaw) {
    delete (agentSdkRaw as Record<string, unknown>).maxTurns;
    log.debug('Stripped stale agentSdk.maxTurns from config (Task #211: maxTurns is now unlimited by default)');
  }

  const merged = deepMerge(
    defaults as unknown as Record<string, unknown>,
    interpolated,
  ) as unknown as OrionOmegaConfig;

  merged.gateway.bind = normalizeBindAddresses(merged.gateway.bind);
  merged.webui.bind = normalizeBindAddresses(merged.webui.bind);

  // Apply declarative model-registry overrides (config > discovery > defaults).
  applyRegistryOverrides(merged.models?.registry);

  if (merged.gateway.auth.mode === 'none') {
    if (isNonLocalhostBind(merged.gateway.bind)) {
      console.warn(
        '[security] WARNING: auth mode is "none" but gateway is bound to a non-localhost address (' +
        merged.gateway.bind.join(', ') +
        '). This exposes the gateway without authentication. Set auth.mode to "api-key" or bind to 127.0.0.1. ' +
        'Startup will be REFUSED in this configuration unless ' + INSECURE_BIND_OVERRIDE_ENV + '=1 is set.',
      );
    } else {
      console.warn(
        '[security] WARNING: auth mode is "none" — the gateway is unauthenticated. This is only safe for ' +
        'local-only use bound to 127.0.0.1. Set auth.mode to "api-key" for any networked/unattended deployment.',
      );
    }
  } else if (merged.gateway.auth.mode === 'api-key' && !merged.gateway.auth.keyHash) {
    console.warn(
      '[security] auth mode is "api-key" but no keyHash is set. Run the gateway to auto-generate one, ' +
      'or run `orionomega setup` to configure a key.',
    );
  }

  return merged;
}

/** Env var that, when set to a truthy value, allows a non-localhost bind with auth disabled. */
export const INSECURE_BIND_OVERRIDE_ENV = 'ORIONOMEGA_ALLOW_INSECURE_BIND';

/** Error thrown by {@link assertSecureBind} when an insecure bind configuration is refused. */
export class InsecureBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureBindError';
  }
}

/**
 * Refuses an unsafe gateway exposure: auth disabled (`mode: 'none'`) combined
 * with a non-localhost bind. Throws {@link InsecureBindError} unless the
 * operator has explicitly opted in via `ORIONOMEGA_ALLOW_INSECURE_BIND=1`.
 *
 * This is the hard refusal that backs the advisory warning emitted by
 * {@link readConfig}. Callers (the gateway entry point) should treat the throw
 * as fatal. Pure / side-effect-free so it is trivially unit-testable.
 *
 * @param config - The resolved configuration to validate.
 * @param env - Environment to read the override flag from. Defaults to `process.env`.
 */
export function assertSecureBind(
  config: OrionOmegaConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const addrs = normalizeBindAddresses(config.gateway.bind);
  if (config.gateway.auth.mode !== 'none') return;
  if (!isNonLocalhostBind(addrs)) return;

  const override = env[INSECURE_BIND_OVERRIDE_ENV];
  const overridden = override === '1' || override === 'true' || override === 'yes';
  if (overridden) {
    console.warn(
      '[security] DANGER: gateway is bound to a non-localhost address (' + addrs.join(', ') +
      ') with auth disabled, allowed only because ' + INSECURE_BIND_OVERRIDE_ENV + ' is set. ' +
      'Anyone who can reach this address has full, unauthenticated control of the agent.',
    );
    return;
  }

  throw new InsecureBindError(
    'Refusing to start: gateway auth mode is "none" but it is bound to a non-localhost address (' +
    addrs.join(', ') + '). An unauthenticated gateway that can clone repos, run shell commands, and ' +
    'spend money must not be network-exposed. Fix one of:\n' +
    '  • set gateway.auth.mode to "api-key" (recommended), or\n' +
    '  • bind gateway.bind to 127.0.0.1 (local only), or\n' +
    '  • set ' + INSECURE_BIND_OVERRIDE_ENV + '=1 to explicitly accept the risk.',
  );
}

/**
 * Ensures the gateway has a usable api-key secret when auth is enabled.
 *
 * When `gateway.auth.mode === 'api-key'` and no `keyHash` is configured, this
 * generates a cryptographically-random secret, stores it as `gateway.auth.keyHash`,
 * and persists the config to disk (so local clients — the web proxy and TUI —
 * can read it and mint signed tokens). The generated value is the shared HMAC
 * signing secret used by {@link generateToken}/`validateToken`; it is not a
 * scrypt password hash.
 *
 * Mutates `config` in place and returns whether a key was generated. The caller
 * is responsible for logging the (sensitive) `keyHash` if it wants operators to
 * be able to copy it for external clients.
 *
 * @param config - The configuration to inspect/mutate.
 * @param configPath - Where to persist the config. Defaults to `getConfigPath()`.
 * @returns `{ generated: true, keyHash }` if a key was created, else `{ generated: false }`.
 */
export function ensureGatewayAuthSecret(
  config: OrionOmegaConfig,
  configPath?: string,
): { generated: boolean; keyHash?: string } {
  if (config.gateway.auth.mode !== 'api-key') return { generated: false };
  if (config.gateway.auth.keyHash && config.gateway.auth.keyHash.length > 0) {
    return { generated: false };
  }

  const keyHash = randomBytes(48).toString('base64url');
  config.gateway.auth.keyHash = keyHash;

  try {
    writeConfig(config, configPath);
  } catch (err) {
    log.warn('Failed to persist auto-generated gateway api-key secret', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { generated: true, keyHash };
}

/**
 * Writes the configuration to a YAML file.
 * Creates parent directories if they don't exist.
 *
 * @param config - The configuration to write.
 * @param configPath - Path to the YAML config file. Defaults to `getConfigPath()`.
 */
export function writeConfig(
  config: OrionOmegaConfig,
  configPath?: string,
): void {
  const filePath = configPath ?? getConfigPath();

  let yaml: typeof import('js-yaml');
  try {
     
    yaml = require('js-yaml') as typeof import('js-yaml');
  } catch {
    throw new Error(
      'js-yaml is required but not installed. Run: npm install js-yaml',
    );
  }

  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on some filesystems; the mode flag on write is the primary protection
  }
}

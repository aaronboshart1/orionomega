/**
 * @module config/loader
 * Configuration loading, writing, and default generation for OrionOmega.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { OrionOmegaConfig } from './types.js';
import { deepMerge } from '../utils/deep-merge.js';

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
        mode: 'none',
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
      workerTimeout: 300,
      maxRetries: 2,
      planFirst: true,
      checkpointInterval: 30,
      autoResume: false,
      defaultAgentMode: 'orchestrate',
      eventBatching: {
        tuiIntervalMs: 250,
        webIntervalMs: 1000,
        immediateTypes: ['error', 'done', 'finding'],
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
      bind: ['127.0.0.1'],
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
      maxTurns: 50,
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

  const merged = deepMerge(
    defaults as unknown as Record<string, unknown>,
    interpolated,
  ) as unknown as OrionOmegaConfig;

  merged.gateway.bind = normalizeBindAddresses(merged.gateway.bind);
  merged.webui.bind = normalizeBindAddresses(merged.webui.bind);

  if (merged.gateway.auth.mode === 'none' && isNonLocalhostBind(merged.gateway.bind)) {
    console.warn(
      '[security] WARNING: auth mode is "none" but gateway is bound to a non-localhost address (' +
      merged.gateway.bind.join(', ') +
      '). This exposes the gateway without authentication. Set auth.mode to "api-key" or bind to 127.0.0.1.',
    );
  }

  return merged;
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

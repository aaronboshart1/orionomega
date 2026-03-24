/**
 * @module config/types
 * Configuration interfaces for the OrionOmega system.
 */

/** Top-level configuration for OrionOmega. */
export interface OrionOmegaConfig {
  gateway: {
    /** Port to listen on. */
    port: number;
    /** Bind address (e.g. '0.0.0.0' or '127.0.0.1'). */
    bind: string;
    auth: {
      /** Authentication mode. */
      mode: 'api-key' | 'none';
      /** Hashed API key (when mode is 'api-key'). */
      keyHash?: string;
    };
    cors: {
      /** Allowed CORS origins. */
      origins: string[];
    };
  };

  hindsight: {
    /** Hindsight server URL. */
    url: string;
    /** Default memory bank name. */
    defaultBank: string;
    /** Retain memories on successful workflow completion. */
    retainOnComplete: boolean;
    /** Retain memories on workflow error. */
    retainOnError: boolean;
  };

  models: {
    /** LLM provider. */
    provider: 'anthropic';
    /** API key for the provider. */
    apiKey: string;
    /** Default model name. */
    default: string;
    /** Model used for planning. */
    planner: string;
    /** Lightweight model for cheap tasks (intent classification, loop judges). */
    cheap: string;
    /** Profile → model name mapping for workers. */
    workers: Record<string, string>;
  };

  orchestration: {
    /** Maximum depth of nested agent spawns. */
    maxSpawnDepth: number;
    /** Worker timeout in seconds. */
    workerTimeout: number;
    /** Maximum retry attempts per worker. */
    maxRetries: number;
    /** Whether to require planning before execution. */
    planFirst: boolean;
    /** Checkpoint interval in seconds. */
    checkpointInterval: number;
    eventBatching: {
      /** TUI event batching interval in milliseconds. */
      tuiIntervalMs: number;
      /** Web dashboard event batching interval in milliseconds. */
      webIntervalMs: number;
      /** Event types that bypass batching and fire immediately. */
      immediateTypes: string[];
    };
  };

  workspace: {
    /** Workspace directory path. */
    path: string;
    /** Maximum output size (e.g. '10MB'). */
    maxOutputSize: string;
  };

  logging: {
    /** Minimum log level. */
    level: 'error' | 'warn' | 'info' | 'verbose' | 'debug';
    /** Log file path. */
    file: string;
    /** Maximum log file size (e.g. '50MB'). */
    maxSize: string;
    /** Maximum number of rotated log files. */
    maxFiles: number;
    /** Whether to log to console. */
    console: boolean;
  };

  skills: {
    /** Directory containing skill definitions. */
    directory: string;
    /** Whether to auto-load skills on startup. */
    autoLoad: boolean;
  };

  autonomous: {
    /** Whether autonomous mode is enabled. */
    enabled: boolean;
    /** Maximum total spend in USD across the autonomous session. */
    maxBudgetUsd: number;
    /** Maximum duration in minutes. */
    maxDurationMinutes: number;
    /** How often to emit progress summaries (minutes). */
    progressIntervalMinutes: number;
    /** Actions that require human confirmation before executing. */
    humanGates: string[];
    /** If true, auto-start next queued task on workflow completion. */
    autoAdvance: boolean;
  };

  agentSdk: {
    /** Whether the Claude Agent SDK is enabled. */
    enabled: boolean;
    /**
     * Permission mode for the agent SDK.
     * - 'acceptEdits': auto-approve file edits (recommended for orchestration)
     * - 'bypassPermissions': skip all permission prompts (use with caution)
     * - 'default': require approval for each tool
     */
    permissionMode: 'acceptEdits' | 'bypassPermissions' | 'default';
    /**
     * Effort level for the agent SDK.
     * Controls how much effort Claude puts into responses (affects thinking depth).
     */
    effort: 'low' | 'medium' | 'high' | 'max';
    /** Maximum budget in USD per coding agent invocation. */
    maxBudgetUsd?: number;
    /** Maximum agentic turns (tool-use round trips) per invocation. */
    maxTurns?: number;
    /** Additional directories the agent can access beyond the working directory. */
    additionalDirectories?: string[];
  };
}

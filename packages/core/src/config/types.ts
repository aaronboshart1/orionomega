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
}

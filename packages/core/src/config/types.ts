/**
 * @module config/types
 * Configuration interfaces for the OrionOmega system.
 */

/** Top-level configuration for OrionOmega. */
export interface OrionOmegaConfig {
  gateway: {
    /** Port to listen on. */
    port: number;
    /** Bind address(es). A single string or array of strings for multi-interface binding. */
    bind: string | string[];
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
    /**
     * Default wall-clock timeout (seconds) for AGENT and TOOL nodes.
     * Used when a node does not declare its own `timeout`.
     * A floor is applied per node type — see executor.ts.
     */
    workerTimeout: number;
    /**
     * Default wall-clock timeout (seconds) for CODING_AGENT nodes.
     * Coding agents perform multi-turn tool loops (Read/Write/Edit/Bash)
     * and routinely need much longer than non-coding workers. Used when
     * a CODING_AGENT node does not declare its own `timeout`.
     * A floor is applied — see executor.ts.
     */
    codingAgentTimeout: number;
    /**
     * Default timeout (seconds) for in-loop validation commands
     * (build/test/lint executed inside coding mode templates).
     */
    validationTimeout: number;
    /** Maximum retry attempts per worker. */
    maxRetries: number;
    /** Whether to require planning before execution. */
    planFirst: boolean;
    /** Checkpoint interval in seconds. */
    checkpointInterval: number;
    /** Whether to auto-resume interrupted workflows on reconnect. */
    autoResume: boolean;
    /** Default agent mode when no per-message or session mode is set. */
    defaultAgentMode: 'orchestrate' | 'direct' | 'code';
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

  webui: {
    /** Port for the web UI server. */
    port: number;
    /** Bind address(es) for the web UI. */
    bind: string | string[];
  };

  commands: {
    directory: string;
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

  scheduling?: {
    /** Whether task scheduling is enabled. Default: true. */
    enabled: boolean;
    /** Default timezone for scheduled tasks. Default: 'UTC'. */
    timezone: string;
    /** Maximum number of concurrently running scheduled tasks. Default: 3. */
    maxConcurrent: number;
    /** Minimum interval in seconds between any two executions of the same task. Default: 60. */
    minIntervalSec: number;
  };

  /** Coding Mode configuration — transforms OrionOmega into an autonomous coding system. */
  codingMode: {
    /** Whether Coding Mode is active. Default: true. */
    enabled: boolean;
    /** Maximum parallel coding agent workers. Default: 4. */
    maxParallelAgents: number;
    /** Enable/disable individual DAG templates. */
    templates: {
      'feature-implementation': boolean;
      'bug-fix': boolean;
      'refactor': boolean;
      'test-suite': boolean;
      'review-iterate': boolean;
    };
    /** Per-role model ID overrides (optional). Leave empty to use auto-resolved models. */
    models: {
      'codebase-scanner'?: string;
      'architect'?: string;
      'implementer'?: string;
      'stitcher'?: string;
      'test-writer'?: string;
      'validator'?: string;
      'reviewer'?: string;
      'reporter'?: string;
    };
    /** Validation settings. */
    validation: {
      /** Automatically run tests/lint after implementation. Default: true. */
      autoRun: boolean;
      /**
       * Default validation commands. Empty array = auto-detect from package.json/Makefile.
       */
      commands: string[];
    };
    /**
     * Multiply all budget allocations by this factor.
     * 1.0 = default budget; 2.0 = double; 0.5 = half.
     */
    budgetMultiplier: number;
  };
}

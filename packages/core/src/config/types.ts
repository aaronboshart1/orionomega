/**
 * @module config/types
 * Configuration interfaces for the OrionOmega system.
 */

import type { ModelCapabilityOverride } from '../models/model-registry.js';

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
    /**
     * Optional session budget cap (USD) used by the live burn-rate view
     * (Task #245). When set, the UI surfaces how close a session is to the cap
     * and a projected time-to-exhaustion at the current burn rate. Unset = no
     * cap is displayed.
     */
    sessionBudgetCapUsd?: number;
  };

  /**
   * Persistent memory. Backed by the self-hosted Redis `MemoryStore`
   * (see docs/memory-architecture-v2.md). Redis is a hard dependency:
   * there is no external memory server and no API key.
   */
  memory: {
    /** Redis connection settings for the memory store. */
    redis: {
      /** Connection URL, e.g. `redis://localhost:6379`. */
      url: string;
      /** Optional password (or use a `redis://user:pass@host` URL). */
      password?: string;
      /** Optional ACL username. */
      username?: string;
      /** Redis logical database number. Default: 0. */
      db?: number;
      /** Key namespace prefix for every key this store writes. Default: `orionomega`. */
      keyPrefix?: string;
      /** Connect over TLS (`rediss://`). Default: false. */
      tls?: boolean;
    };
    /** Number of recent messages to keep verbatim in the hot window. Default: 20. */
    hotWindowSize?: number;
    /** Max tokens to spend on recalled records per turn. Default: 16384. */
    recallBudgetTokens?: number;
    /** Max total input tokens per turn (hot window + recall + system). Default: 128000. */
    maxTurnTokens?: number;
    /** Token budget for the memory map (scope inventory) block. Default: 1024. */
    memoryMapTokens?: number;
    /** Drop recalled records scoring below this relevance (0–1). Default: 0.3. */
    minRelevance?: number;
    /** Similarity threshold for storage-time deduplication (0–1). Default: 0.85. */
    deduplicationThreshold?: number;
    /** Retain memories on successful workflow completion. */
    retainOnComplete: boolean;
    /** Retain memories on workflow error. */
    retainOnError: boolean;
    /** Write an end-of-session summary record (§12.1). Default: true. */
    sessionSummary?: boolean;
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
    /**
     * Optional declarative overrides for the model capability registry
     * (Task #229). Each entry is keyed by model ID and merged over the built-in
     * defaults and discovery seeds — config takes highest precedence. Use this
     * to correct pricing, output ceilings, beta headers, gating, etc. for a
     * model without a code change.
     */
    registry?: ModelCapabilityOverride[];
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
    /**
     * Maximum retry attempts per worker.
     *
     * Special sentinel: `0` means **unlimited** retries on transient failures
     * — permanent errors (see `classifyError` in `executor.ts`) still
     * short-circuit the loop, and per-attempt timeouts plus the user's Stop
     * button still bound runs. Set a positive integer (e.g. `3`) to cap the
     * number of attempts. Per-node `retries` overrides this and at the
     * per-node level `0` keeps its original meaning of "no retries".
     */
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
    /**
     * Task #238 (R5) — Persistent distributed task queue. Controls how the
     * executor dispatches each topological layer's node jobs. Optional: when
     * absent the executor uses the zero-setup in-process queue, so local dev
     * needs no external infrastructure.
     */
    queue?: {
      /**
       * Dispatch backend. `in-process` (default) runs node jobs in the current
       * process; `redis` persists jobs in Redis (via BullMQ) so they survive a
       * worker restart and can be consumed by separate worker processes.
       */
      backend?: 'in-process' | 'redis';
      /**
       * Redis connection URL for the `redis` backend (e.g.
       * `redis://localhost:6379`). Falls back to the `REDIS_URL` env var; if
       * neither is set the backend degrades to in-process.
       */
      redisUrl?: string;
      /** BullMQ queue name for the `redis` backend (default `orionomega-nodes`). */
      queueName?: string;
      /** Per-process worker concurrency for the `redis` backend (default 8). */
      concurrency?: number;
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
    /** Additional directories the agent can access beyond the working directory. */
    additionalDirectories?: string[];
    /**
     * Native context editing (R4) — the SDK's auto-compaction. When enabled,
     * the Agent SDK auto-trims stale tool calls/results as the context window
     * fills, so long unattended runs continue instead of degrading or failing
     * on context exhaustion. Applied to the long-running orchestration nodes
     * (AGENT and CODING_AGENT) that go through the Agent SDK bridge, pairing
     * the executor's wall-clock timeout floors with auto-trimming.
     *
     * On by default. Set `enabled: false` to turn it off.
     */
    contextEditing?: {
      /** Master switch for native context editing. Default: true. */
      enabled?: boolean;
      /**
       * Optional override for the auto-compact window size (the token budget
       * the SDK keeps after a compaction). Omit to use the SDK default.
       */
      autoCompactWindow?: number;
    };
    /**
     * Task #240 (roadmap R3) — pilot: run a single eligible sub-DAG layer
     * through Anthropic's *native* multi-agent sessions (one `query()` with an
     * `agents` roster + a coordinator) instead of OrionOmega's in-house
     * per-node dispatch. The platform owns context isolation, session
     * threading and persistent follow-ups; the executor keeps owning retries,
     * budgets and checkpointing. This is an experimental substrate gated OFF
     * by default — when disabled the executor behaves exactly as before.
     */
    nativeSessions?: {
      /** Master switch for the native-multi-agent-session pilot. Default: false. */
      enabled?: boolean;
      /**
       * Safety cap on how many CODING_AGENT nodes a single native session
       * will fan out to in one layer. Layers above the cap fall back to the
       * in-house per-node path. Default: 8.
       */
      maxAgentsPerLayer?: number;
    };
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
    /**
     * Complexity-aware tier routing (Task #245). When enabled, low-complexity
     * phases default to a cheaper tier while hard phases still escalate to
     * Opus/Fable. Set `enabled: false` to keep every role on its preferred
     * tier regardless of codebase complexity.
     */
    tierRouting?: {
      enabled: boolean;
    };
  };

  /**
   * Optional coding-mode configuration. Currently used to surface a
   * user-configured default repo directory for CODING_AGENT nodes.
   *
   * If `repoDir` is set, CODING_AGENT nodes that do not declare their own
   * `codingAgent.cwd` will use this path as their working directory. If it
   * is left unset (the default), each CODING_AGENT instead works inside its
   * own per-node output directory under the run dir, so deliverables stay
   * scoped to the run.
   *
   * IMPORTANT: this should point at a real user repo. It must NOT be set to
   * the OrionOmega install directory (e.g. `~/.orionomega/src`) — doing so
   * leaks deliverables into the install tree.
   */
  coding?: {
    /** Absolute path to the default repo for CODING_AGENT nodes. */
    repoDir?: string;
    /**
     * Default remote URL for code-mode runs when the user doesn't include
     * a `repo:<url>` hint in the task. Used by the coding orchestrator's
     * remote-resolver after `repoDir` has been consulted. Should be an
     * HTTPS or SSH URL that `git clone` understands (e.g.
     * `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`).
     */
    defaultRemote?: string;
  };

  /**
   * Task scheduling configuration.
   * Controls the in-process scheduler that fires recurring/one-shot prompts
   * through MainAgent.handleMessage(). All fields are optional and default
   * to sensible values; the scheduler runs with defaults if this section is
   * absent. Set `enabled: false` to disable the scheduler entirely (REST
   * routes will return 503 in that case).
   */
  scheduling?: {
    /** Whether the scheduler engine is enabled. Default: true. */
    enabled?: boolean;
    /** Default IANA timezone for new schedules. Default: 'UTC'. */
    timezone?: string;
    /** Maximum concurrent scheduled-task executions. Default: 3. */
    maxConcurrent?: number;
    /** Minimum interval between executions of any single task (seconds). Default: 60. */
    minIntervalSec?: number;
  };
}

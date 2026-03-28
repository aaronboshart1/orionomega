/**
 * @module types
 * Type definitions for the OrionOmega skills system.
 * Covers skill manifests, settings schemas, loaded skills, tool registration,
 * validation results, and skill execution context.
 */

// ── Settings Schema ────────────────────────────────────────────────────

/**
 * UI rendering groups for skill settings.
 * Maps to collapsible sections in the settings panel.
 */
export enum SkillSettingGroup {
  /** Authentication credentials, API keys, and tokens. */
  Auth = 'auth',
  /** User preferences and behavioral settings. */
  Preferences = 'preferences',
  /** Advanced configuration for power users. */
  Advanced = 'advanced',
}

/**
 * Input field types for skill settings.
 * Controls how a setting is rendered in the UI and validated at runtime.
 */
export enum SkillSettingType {
  /** Plain text input. */
  String = 'string',
  /** Masked password/token input — value is redacted in logs. */
  Password = 'password',
  /** Boolean toggle switch. */
  Boolean = 'boolean',
  /** Single-option dropdown select. */
  Select = 'select',
  /** Numeric input. */
  Number = 'number',
  /** URL input with format validation. */
  URL = 'url',
  /** Multi-line text area. */
  Textarea = 'textarea',
  /** Multi-option select returning a string array. */
  Multiselect = 'multiselect',
}

/**
 * Schema definition for a single skill setting property.
 * Extends JSON Schema draft-07 with `x-ui-*`-style rendering hints
 * encoded as first-class typed fields.
 */
export interface SkillSettingSchema {
  /** The input type, controlling validation and UI widget. */
  type: SkillSettingType | SkillSettingType[];
  /** Short human-readable label shown next to the input. */
  label: string;
  /** Longer description shown as help text below the input. */
  description?: string;
  /** Placeholder text for text-based inputs. */
  placeholder?: string;
  /** Whether the setting must be provided before the skill can be used. */
  required?: boolean;
  /**
   * Default value applied when the user has not provided one.
   * Must be compatible with the declared `type`.
   */
  default?: string | number | boolean | string[];
  /**
   * Which settings panel section this setting belongs to.
   * Defaults to {@link SkillSettingGroup.Preferences} if omitted.
   */
  group?: SkillSettingGroup;
  /**
   * UI widget override for non-obvious renderings.
   * For example, `"secret"` forces a password field regardless of `type`.
   */
  widget?: 'secret' | 'textarea' | 'code' | 'color' | 'file';
  /** Options for {@link SkillSettingType.Select} and {@link SkillSettingType.Multiselect} types. */
  options?: Array<{ label: string; value: string }>;
  /** Additional validation constraints applied at save time. */
  validation?: {
    /** Minimum string length or minimum numeric value. */
    min?: number;
    /** Maximum string length or maximum numeric value. */
    max?: number;
    /** ECMAScript regex pattern the string value must satisfy. */
    pattern?: string;
    /** Closed list of allowed values. */
    enum?: Array<string | number | boolean>;
  };
  /**
   * Rendering order within the group — lower numbers appear first.
   * Settings without an order are sorted after those with one.
   */
  order?: number;
  /** Hide this setting from the UI while still including it in validation. */
  hidden?: boolean;
  /**
   * Name of another setting whose truthy value is required to show this one.
   * When the dependency is falsy this setting is hidden and its value cleared.
   */
  dependsOn?: string;
}

/**
 * The settings schema block embedded in a skill manifest's `settings` field.
 * Describes all user-configurable settings the skill exposes.
 *
 * Structurally equivalent to a JSON Schema draft-07 object type so that
 * standard JSON Schema tooling can validate it out of the box.
 */
export interface SkillSettingsBlock {
  /** Always `"object"` — the settings block is a keyed property map. */
  type: 'object';
  /** Map of setting key to its schema definition. */
  properties: Record<string, SkillSettingSchema>;
  /**
   * Setting keys that are required.
   * These must be present and non-empty before the skill can activate.
   */
  required?: string[];
}

// ── Health & Context ───────────────────────────────────────────────────

/**
 * Machine-readable error codes for health check failures.
 * Used to drive automatic remediation suggestions in the UI.
 */
export type HealthErrorCode =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_MISSING'
  | 'CONFIG_INVALID'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

/**
 * Structured health check result returned by a skill's `getHealth()` method
 * or by parsing the stdout of a `hooks.healthCheck` script.
 */
export interface HealthStatus {
  /** Whether the skill is healthy and ready to handle tool calls. */
  healthy: boolean;
  /** Human-readable status message for display in the UI. */
  message: string;
  /** Machine-readable error code when {@link healthy} is `false`. */
  code?: HealthErrorCode;
  /**
   * Whether this failure is transient and worth auto-retrying.
   * `true` for rate limits and transient network errors; `false` for auth failures.
   */
  retryable?: boolean;
  /** Additional diagnostic key-value pairs for debugging. */
  details?: Record<string, unknown>;
}

/**
 * Structured logger passed to skill lifecycle methods.
 * Secret values must never be passed to any logger method.
 */
export interface SkillLogger {
  /** Low-level debug message — may be suppressed in production. */
  debug(message: string, data?: Record<string, unknown>): void;
  /** Informational message about normal operation. */
  info(message: string, data?: Record<string, unknown>): void;
  /** Non-fatal warning that may affect skill behaviour. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Fatal or unexpected error. */
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Execution context injected into skills at initialization time.
 * Provides structured access to logging, configuration, and secrets.
 *
 * @remarks
 * `config` holds non-sensitive values; `secrets` holds sensitive ones.
 * Secret values are masked in log output and injected to handlers via
 * environment variables (`SKILL_{SKILLNAME}_{FIELDNAME}`) rather than stdin.
 */
export interface SkillContext {
  /** Structured logger — never log values from `secrets`. */
  logger: SkillLogger;
  /**
   * Non-secret configuration values for this skill.
   * Resolved from the manifest defaults merged with the user's saved config.
   */
  config: Record<string, string | number | boolean>;
  /**
   * Secret values such as API keys and tokens.
   * These are sourced from the user's saved config for password-type settings
   * and are redacted in any serialized output.
   */
  secrets: Record<string, string>;
}

// ── Skill Manifest ─────────────────────────────────────────────────────

/**
 * Declares the structure of a skill's `manifest.json`.
 * Every skill directory must contain a manifest conforming to this interface.
 *
 * @remarks
 * All fields added in this version are optional to maintain full backward
 * compatibility with existing manifests — all four default skills remain
 * valid without any changes.
 */
export interface SkillManifest {
  /**
   * Optional pointer to the JSON Schema for editor autocompletion and validation.
   * @example "https://orionomega.dev/schemas/skill-manifest.v1.json"
   */
  $schema?: string;

  /** Unique slug identifier for the skill (e.g. `"github"`, `"weather"`). */
  name: string;
  /** Semantic version string (e.g. `"1.2.3"`). */
  version: string;
  /** Human-readable description of what the skill does. */
  description: string;
  /** Skill author name or handle. */
  author: string;
  /** SPDX license identifier (e.g. `"MIT"`). */
  license: string;
  /** Optional URL to the skill's homepage or documentation. */
  homepage?: string;
  /** Optional source repository URL. */
  repository?: string;
  /**
   * Relative path to a 64×64 SVG or PNG icon for display in the UI.
   * @example "assets/icon.svg"
   */
  icon?: string;

  /** Semver compatibility range for the OrionOmega version (e.g. `">=0.1.0"`). */
  orionomega: string;
  /** Operating systems this skill supports (e.g. `["linux", "darwin"]`). */
  os?: string[];
  /** CPU architectures this skill supports (e.g. `["x64", "arm64"]`). */
  arch?: string[];

  /** External dependencies the skill requires to function. */
  requires: {
    /** CLI commands that must be available on `PATH`. */
    commands?: string[];
    /** Other skill names that must be installed and ready. */
    skills?: string[];
    /** Environment variables that must be set. */
    env?: string[];
    /** Network ports that must be available. */
    ports?: number[];
    /** Systemd services that must be running. */
    services?: string[];
  };

  /** Tools exposed by this skill to the agent. */
  tools?: SkillTool[];

  /**
   * User-configurable settings schema for this skill.
   * Drives form generation in the Web UI and runtime validation at load time.
   * When present, supersedes the legacy `setup.fields` flat array.
   */
  settings?: SkillSettingsBlock;

  /** How this skill is matched to user input. */
  triggers: {
    /** Case-insensitive keywords that activate the skill. */
    keywords?: string[];
    /** Regular expression patterns to match against user input. */
    patterns?: string[];
    /** Slash commands (e.g. `"/gh"`) that activate the skill. */
    commands?: string[];
  };

  /** Optional worker agent configuration when this skill runs as a worker. */
  workerProfile?: {
    /** Preferred model tier or identifier. */
    model?: string;
    /** Tool names available to the worker agent. */
    tools?: string[];
    /** Maximum execution timeout in milliseconds. */
    maxTimeout?: number;
  };

  /** Optional setup configuration for interactive skill setup. */
  setup?: SkillSetup;

  /** Lifecycle hook scripts (paths relative to the skill directory). */
  hooks?: {
    /** Script to run after skill installation. */
    postInstall?: string;
    /** Script to run before the skill is loaded into the agent. */
    preLoad?: string;
    /**
     * Script to run for health checks.
     * Must write a {@link HealthStatus}-shaped JSON object to stdout and exit 0.
     */
    healthCheck?: string;
  };
}

// ── Tool Definitions ───────────────────────────────────────────────────

/** A tool definition within a skill manifest. */
export interface SkillTool {
  /** Unique tool name within the skill (snake_case recommended). */
  name: string;
  /** Human-readable description of what the tool does — used in agent prompts. */
  description: string;
  /**
   * JSON Schema object describing the tool's input parameters.
   * Must have `type: "object"` at the top level.
   */
  inputSchema: Record<string, unknown>;
  /** Path to the handler script, relative to the skill directory. */
  handler: string;
  /** Execution timeout in milliseconds. Defaults to 30 000 ms. */
  timeout?: number;
}

// ── Loaded Skill ───────────────────────────────────────────────────────

/** A fully loaded skill, ready for execution. */
export interface LoadedSkill {
  /** The validated skill manifest. */
  manifest: SkillManifest;
  /** Contents of the skill's `SKILL.md` documentation file. */
  skillDoc: string;
  /** Contents of `prompts/worker.md` if present. */
  workerPrompt?: string;
  /** Registered tool executors for this skill. */
  tools: RegisteredTool[];
  /** Absolute path to the skill directory on disk. */
  skillDir: string;
}

/** A registered tool with an executable handler function. */
export interface RegisteredTool {
  /** Tool name — matches {@link SkillTool.name}. */
  name: string;
  /** Tool description — matches {@link SkillTool.description}. */
  description: string;
  /** JSON Schema for input parameters — matches {@link SkillTool.inputSchema}. */
  inputSchema: Record<string, unknown>;
  /** Execute the tool with the given parameters, returning the handler's output. */
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

// ── Validation ─────────────────────────────────────────────────────────

/** Result of a manifest or dependency validation check. */
export interface ValidationResult {
  /** Whether validation passed with no errors. */
  valid: boolean;
  /** Blocking errors that prevent the skill from loading or saving. */
  errors: string[];
  /** Non-blocking advisory warnings. */
  warnings: string[];
}

/** Result of a skill installation operation. */
export interface SkillInstallResult {
  /** Whether installation succeeded. */
  success: boolean;
  /** Skill name. */
  name: string;
  /** Skill version installed. */
  version: string;
  /** Errors encountered during installation. */
  errors: string[];
  /** Warnings encountered during installation. */
  warnings: string[];
}

// ── Skill Setup & Configuration Types ─────────────────────────────────

/**
 * Authentication method declared in the manifest under `setup.auth.methods[]`.
 * Describes how the user proves their identity to the upstream service.
 */
export interface SkillAuthMethod {
  /** Auth strategy type. */
  type: 'oauth' | 'pat' | 'api-key' | 'login' | 'ssh-key' | 'env';
  /** Human-readable label shown in the setup wizard. */
  label: string;
  /** Brief description of this auth method. */
  description?: string;
  /** CLI command to run for oauth/login flows (e.g. `"gh auth login --web"`). */
  command?: string;
  /** URL where the user can generate a token (for pat/api-key flows). */
  tokenUrl?: string;
  /** Required OAuth scopes or permissions (informational only). */
  scopes?: string[];
  /** Environment variable that stores the credential. */
  envVar?: string;
  /** Command to validate auth is working — exit 0 means valid. */
  validateCommand?: string;
}

/**
 * A configuration field declared in the legacy `setup.fields` array.
 * Rendered as a prompt during interactive CLI setup.
 *
 * @deprecated Prefer the `settings` block in the manifest for new skills.
 *             Existing `setup.fields` arrays are automatically shimmed to
 *             {@link SkillSettingsBlock} at load time.
 */
export interface SkillSetupField {
  /** Field identifier — used as the key in `config.json`. */
  name: string;
  /** Value type. */
  type: 'string' | 'number' | 'boolean' | 'select';
  /** Human-readable label for the setup prompt. */
  label: string;
  /** Help text shown below the prompt. */
  description?: string;
  /** Whether the field must be filled before setup is complete. */
  required: boolean;
  /** Default value. */
  default?: string | number | boolean;
  /** Options for select-type fields. */
  options?: { label: string; value: string }[];
  /** Whether to mask input — use for secrets and tokens. */
  mask?: boolean;
}

/**
 * Skill setup declaration in the manifest.
 * Describes what configuration the skill needs and how to obtain it.
 */
export interface SkillSetup {
  /** Whether setup must be completed before the skill can be used. */
  required: boolean;
  /** Human-readable description of what setup does. */
  description?: string;
  /** Authentication configuration. */
  auth?: {
    /** Available auth methods — the user picks one. */
    methods: SkillAuthMethod[];
  };
  /**
   * Additional configuration fields.
   * @deprecated Prefer `settings` at the manifest level.
   */
  fields?: SkillSetupField[];
  /** Path to a setup handler script for custom validation / post-setup logic. */
  handler?: string;
}

/**
 * Persisted skill configuration.
 * Stored at `~/.orionomega/skills/{name}/config.json`.
 */
export interface SkillConfig {
  /** Skill name — matches `manifest.name`. */
  name: string;
  /** Whether the skill is enabled by the user. */
  enabled: boolean;
  /** Whether setup has been completed and the skill is ready to use. */
  configured: boolean;
  /** Which auth method was chosen (if the skill requires auth). */
  authMethod?: string;
  /** ISO 8601 timestamp of the last setup/config change. */
  configuredAt?: string;
  /**
   * User-provided field values.
   * Secret values are stored here but redacted in API responses.
   */
  fields: Record<string, string | number | boolean>;
}

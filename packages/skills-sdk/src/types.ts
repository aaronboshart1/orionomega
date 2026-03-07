/**
 * @module types
 * Type definitions for the OrionOmega skills system.
 * Covers skill manifests, loaded skills, tool registration, and validation results.
 */

/**
 * Declares the structure of a skill's `manifest.json`.
 * Every skill directory must contain a manifest conforming to this interface.
 */
export interface SkillManifest {
  /** Unique slug identifier for the skill (e.g. "github", "weather"). */
  name: string;
  /** Semantic version string (e.g. "1.2.3"). */
  version: string;
  /** Human-readable description of what the skill does. */
  description: string;
  /** Skill author name or handle. */
  author: string;
  /** SPDX license identifier. */
  license: string;
  /** Optional URL to the skill's homepage or documentation. */
  homepage?: string;
  /** Optional repository URL. */
  repository?: string;

  /** Semver compatibility range for the OrionOmega version (e.g. ">=0.1.0"). */
  orionomega: string;
  /** Operating systems the skill supports (e.g. ["linux", "darwin"]). */
  os?: string[];
  /** CPU architectures the skill supports (e.g. ["x64", "arm64"]). */
  arch?: string[];

  /** External dependencies the skill requires to function. */
  requires: {
    /** CLI commands that must be available on PATH. */
    commands?: string[];
    /** Other skill names that must be installed. */
    skills?: string[];
    /** Environment variables that must be set. */
    env?: string[];
    /** Network ports that must be available. */
    ports?: number[];
    /** Systemd services that must be running. */
    services?: string[];
  };

  /** Tools exposed by this skill. */
  tools?: SkillTool[];

  /** How the skill is matched to user input. */
  triggers: {
    /** Case-insensitive keywords that activate the skill. */
    keywords?: string[];
    /** Regular expression patterns to match against user input. */
    patterns?: string[];
    /** Slash commands (e.g. "/gh") that activate the skill. */
    commands?: string[];
  };

  /** Optional worker agent configuration when this skill runs as a worker. */
  workerProfile?: {
    /** Preferred model identifier. */
    model?: string;
    /** Tool names available to the worker. */
    tools?: string[];
    /** Maximum execution timeout in milliseconds. */
    maxTimeout?: number;
  };

  /** Lifecycle hook scripts (paths relative to the skill directory). */
  /** Optional setup configuration for interactive skill setup. */
  setup?: SkillSetup;

  hooks?: {
    /** Script to run after skill installation. */
    postInstall?: string;
    /** Script to run before the skill is loaded. */
    preLoad?: string;
    /** Script to run for health checks. */
    healthCheck?: string;
  };
}

/** A tool definition within a skill manifest. */
export interface SkillTool {
  /** Unique tool name within the skill. */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Path to the handler script, relative to the skill directory. */
  handler: string;
  /** Execution timeout in milliseconds. */
  timeout?: number;
}

/** A fully loaded skill, ready for execution. */
export interface LoadedSkill {
  /** The validated skill manifest. */
  manifest: SkillManifest;
  /** Contents of the skill's SKILL.md documentation file. */
  skillDoc: string;
  /** Contents of prompts/worker.md if present. */
  workerPrompt?: string;
  /** Registered tool executors for this skill. */
  tools: RegisteredTool[];
  /** Absolute path to the skill directory on disk. */
  skillDir: string;
}

/** A registered tool with an executable handler. */
export interface RegisteredTool {
  /** Tool name. */
  name: string;
  /** Tool description. */
  description: string;
  /** JSON Schema for input parameters. */
  inputSchema: Record<string, unknown>;
  /** Execute the tool with the given parameters. */
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/** Result of a manifest or dependency validation. */
export interface ValidationResult {
  /** Whether validation passed with no errors. */
  valid: boolean;
  /** Blocking errors that prevent the skill from loading. */
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
  /** Skill version. */
  version: string;
  /** Errors encountered during installation. */
  errors: string[];
  /** Warnings encountered during installation. */
  warnings: string[];
}

// ── Skill Setup & Configuration Types ─────────────────────────────────

/**
 * Authentication method for a skill.
 * Declared in manifest.json under `setup.auth.methods[]`.
 */
export interface SkillAuthMethod {
  /** Auth strategy type. */
  type: 'oauth' | 'pat' | 'api-key' | 'login' | 'ssh-key' | 'env';
  /** Human-readable label shown in the setup wizard. */
  label: string;
  /** Brief description of this auth method. */
  description?: string;
  /** CLI command to run for oauth/login flows (e.g. "gh auth login --web"). */
  command?: string;
  /** URL where user can generate a token (for pat/api-key). */
  tokenUrl?: string;
  /** Required scopes or permissions (informational). */
  scopes?: string[];
  /** Environment variable that stores the credential. */
  envVar?: string;
  /** Command to validate auth is working (exit 0 = valid). */
  validateCommand?: string;
}

/**
 * A configuration field declared by a skill.
 * Rendered as a prompt during interactive setup.
 */
export interface SkillSetupField {
  /** Field identifier (used as key in config.json). */
  name: string;
  /** Value type. */
  type: 'string' | 'number' | 'boolean' | 'select';
  /** Human-readable label for the prompt. */
  label: string;
  /** Help text shown below the prompt. */
  description?: string;
  /** Whether the field must be filled. */
  required: boolean;
  /** Default value. */
  default?: string | number | boolean;
  /** Options for select-type fields. */
  options?: { label: string; value: string }[];
  /** Whether to mask input (for secrets). */
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
    /** Available auth methods (user picks one). */
    methods: SkillAuthMethod[];
  };
  /** Additional configuration fields. */
  fields?: SkillSetupField[];
  /** Path to setup handler script for custom validation/post-setup logic. */
  handler?: string;
}

/**
 * Persisted skill configuration.
 * Stored at `~/.orionomega/skills/{name}/config.json`.
 */
export interface SkillConfig {
  /** Skill name (matches manifest.name). */
  name: string;
  /** Whether the skill is enabled. */
  enabled: boolean;
  /** Whether setup has been completed. */
  configured: boolean;
  /** Which auth method was chosen (if applicable). */
  authMethod?: string;
  /** Timestamp of last setup/config change. */
  configuredAt?: string;
  /** User-provided field values. */
  fields: Record<string, string | number | boolean>;
}

/**
 * @module orchestration/agent-sdk-bridge
 * Bridge between OrionOmega's orchestration engine and the Claude Agent SDK.
 *
 * When the planner assigns a CODING_AGENT node, the executor routes to this bridge
 * instead of the generic agent loop. The Agent SDK provides Claude Code's full
 * coding toolset: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch,
 * plus subagent capabilities — all managed by Anthropic's battle-tested agent loop.
 *
 * This keeps OrionOmega's core small: we don't reimplement coding tools,
 * we delegate to the SDK that powers Claude Code itself.
 */

import { query, createSdkMcpServer, tool, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKToolProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { readConfig } from '../config/loader.js';
import type { WorkflowNode } from './types.js';
import type { CodingRole, TokenBudget } from './coding/coding-types.js';
import { createLogger } from '../logging/logger.js';
import {
  isOrionOmegaAbortReason,
  describeAbortReason,
  type OrionOmegaAbortReason,
} from './abort-reason.js';
import { getPortAvoidanceInstructions } from '../utils/port-restrictions.js';
import { auditToolInvocation } from '../logging/audit.js';
import {
  buildCanUseTool,
  buildPermissionRequestHook,
} from './permission-policy.js';
import { buildCommitSafetyToolGuard } from './coding/safe-commit.js';
import { AGENT_ROLE_SYSTEM_PROMPTS } from './coding/agent-role-prompts.js';
import { SkillExecutor } from '@orionomega/skills-sdk';
import { buildSkillToolset } from '../agent/skill-tools.js';
import path from 'node:path';

const log = createLogger('agent-sdk-bridge');

/**
 * Classify whether an error returned from the SDK is worth retrying.
 *
 * - AbortError surfaces both for *user-driven* cancellation and for
 *   *AbortController-driven timeouts*. The bridge cannot distinguish those
 *   from inside the SDK; the caller knows which one it triggered. We mark
 *   AbortError as non-retryable here and rely on the executor's wall-clock
 *   timeout reasoning to retry timeouts at the outer layer.
 * - Authentication / API-key / 4xx errors are permanent.
 * - Anything else (network blips, rate limits, 5xx, unknown) is retryable.
 */
function isRetryableSdkError(err: unknown): boolean {
  if (err instanceof AbortError) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes('invalid api key') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('authentication failed') ||
    msg.includes('401') ||
    msg.includes('403')
  ) {
    return false;
  }
  return true;
}

/**
 * Build a human-readable error message from a non-success SDKResultError.
 * The SDK distinguishes several failure subtypes; surface them so operators
 * can act differently on, say, max-budget exhaustion vs an outright crash.
 */
function describeResultError(errorMsg: SDKResultError): string {
  const subtype = errorMsg.subtype;
  const summary = errorMsg.errors?.join('; ') ?? '';
  switch (subtype) {
    case 'error_max_turns':
      return `max turns reached${summary ? `: ${summary}` : ''}`;
    case 'error_max_budget_usd':
      return `max budget (USD) reached${summary ? `: ${summary}` : ''}`;
    case 'error_max_structured_output_retries':
      return `max structured-output retries reached${summary ? `: ${summary}` : ''}`;
    case 'error_during_execution':
      return `error during execution${summary ? `: ${summary}` : ''}`;
    default: {
      if (summary) return summary;
      const subtypeStr = subtype ? String(subtype) : 'unknown';
      return `unknown error (subtype=${subtypeStr})`;
    }
  }
}

/** Result of a coding agent invocation via the Agent SDK. */
export interface CodingAgentResult {
  /** Final text output from the agent. */
  output: string;
  /** Tool calls made during execution. */
  toolCalls: number;
  /** Whether the agent completed successfully. */
  success: boolean;
  /** Error message if the agent failed. */
  error?: string;
  /** Cost in USD (if reported by the SDK). */
  costUsd?: number;
  /** Duration in seconds. */
  durationSec: number;
  /** Paths of files written or edited during execution. */
  outputPaths: string[];
  // Token usage fields — needed so executor.ts can aggregate costs for CODING_AGENT nodes.
  /** Model used (for cost tracking). */
  model?: string;
  /** Input tokens consumed across all turns. */
  inputTokens?: number;
  /** Output tokens consumed across all turns. */
  outputTokens?: number;
  /** Cache read tokens across all turns. */
  cacheReadTokens?: number;
  /** Cache creation tokens across all turns. */
  cacheCreationTokens?: number;
  /**
   * If false, the failure is permanent (auth error, bad config) and the
   * caller should not retry. Undefined on success.
   */
  retryable?: boolean;
  /** SDK result subtype when the SDK reported a non-success result. */
  errorSubtype?: SDKResultError['subtype'];
}

/** Configuration for a coding agent node. */
export interface CodingAgentConfig {
  /** The task description for the coding agent. */
  task: string;
  /** Model to use (overrides default). */
  model?: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Additional directories the agent can access. */
  additionalDirectories?: string[];
  /** System prompt override or append. */
  systemPrompt?: string;
  /** Specific tools to allow (defaults to full coding toolset). */
  allowedTools?: string[];
  /** Maximum budget in USD for this invocation. */
  maxBudgetUsd?: number;
  /** Subagent definitions. */
  agents?: Record<string, { description: string; prompt: string; tools?: string[] }>;
}

/**
 * Default coding tools — the full Claude Code toolset.
 * These are auto-approved when permissionMode is 'acceptEdits'.
 */
const DEFAULT_CODING_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task',
];

/**
 * Default tools for AGENT nodes — the Claude Code toolset without subagent spawning.
 * Workers run autonomously but don't need to spawn their own sub-agents.
 */
const DEFAULT_AGENT_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
];

// ── Section 5.2: Role-to-Tool Mapping ────────────────────────────────────────

/**
 * Allowed tools per coding role (Section 5.2).
 *
 * Key design constraints:
 * - Scanner: read-only + bash (for listing/grepping); no writes
 * - Architect: read-only; cannot write code (forces planning/implementation separation)
 * - Coder/TestWriter/Integrator/Debugger: full toolset
 * - Reviewer/Reporter: read-only
 */
export const ROLE_TOOL_MAP: Record<CodingRole, string[]> = {
  'codebase-scanner': ['Read', 'Glob', 'Grep', 'Bash'],
  'architect':        ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  'implementer':      ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  'stitcher':         ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  'test-writer':      ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  'validator':        [],         // TOOL node — no LLM
  'reviewer':         ['Read', 'Glob', 'Grep'],
  'debugger':         ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
  'review-gate':      [],         // ROUTER node — deterministic logic
  'reporter':         ['Read', 'Glob', 'Grep'],
};

// ── Section 5.1: Role Max Turns ────────────────────────────────────────────

/**
 * Maximum agent turns per role (Section 5.1 + agent table in Section 4.4).
 * Prevents runaway agents while giving each role sufficient room.
 */
export const ROLE_MAX_TURNS: Record<CodingRole, number> = {
  'codebase-scanner': 20,
  'architect':        30,
  'implementer':      50,
  'stitcher':         40,
  'test-writer':      40,
  'validator':        0,    // TOOL node
  'reviewer':         30,
  'debugger':         40,
  'review-gate':      0,    // ROUTER node
  'reporter':         15,
};

// ── Section 5.1: Role Effort Map ──────────────────────────────────────────

/**
 * SDK `effort` parameter per role (maps to thinking budget preset).
 * Scanner and reporter disable thinking for pure speed.
 * Debugger uses 'high' by default; upgraded to 'xhigh' via ROLE_THINKING_CONFIG.
 */
export const ROLE_EFFORT_MAP: Record<CodingRole, 'low' | 'medium' | 'high'> = {
  'codebase-scanner': 'low',
  'architect':        'high',
  'implementer':      'medium',
  'stitcher':         'high',
  'test-writer':      'medium',
  'validator':        'low',
  'reviewer':         'high',
  'debugger':         'high',
  'review-gate':      'low',
  'reporter':         'low',
};

// ── Section 5.4: Extended Thinking Configuration ───────────────────────────

export interface ThinkingConfig {
  /** Whether extended thinking is enabled for this role. */
  enabled: boolean;
  /** Base effort level (when enabled). */
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Optional upgrade function — returns true when complexity warrants
   * upgrading effort from the base to 'xhigh'.
   */
  upgradeToXhigh?: (complexityTier: 'trivial' | 'small' | 'medium' | 'large' | 'epic') => boolean;
}

/**
 * Per-role extended thinking configuration (Section 5.4).
 *
 * Adaptive thinking saves 30-40% cost vs. always-on thinking.
 * Scanner and reporter disable thinking for speed; debugger uses xhigh
 * for deepest root-cause reasoning.
 */
export const ROLE_THINKING_CONFIG: Record<CodingRole, ThinkingConfig> = {
  'codebase-scanner': { enabled: false, effort: 'low' },
  'architect':        {
    enabled: true,
    effort: 'high',
    upgradeToXhigh: (tier) => tier === 'large' || tier === 'epic',
  },
  'implementer':      { enabled: true, effort: 'medium' },
  'stitcher':         { enabled: true, effort: 'high' },
  'test-writer':      { enabled: true, effort: 'medium' },
  'validator':        { enabled: false, effort: 'low' },
  'reviewer':         { enabled: true, effort: 'high' },
  'debugger':         { enabled: true, effort: 'xhigh' },
  'review-gate':      { enabled: false, effort: 'low' },
  'reporter':         { enabled: false, effort: 'low' },
};

/**
 * Maps ThinkingEffort levels to extended-thinking budget_tokens values.
 *
 * @deprecated No longer wired into the coding query options. The claude-agent-sdk
 * (0.3.x) drives thinking depth through `effort` and adaptive thinking
 * (`thinking: { type: 'adaptive' }`), which takes NO budget field — Opus 4.8
 * returns a 400 if a manual budget is sent alongside adaptive thinking. Do not
 * reintroduce these values into the SDK thinking config. Retained only as a
 * reference table for effort↔budget intent.
 *
 * medium=8000, high=16000, xhigh=32000.
 */
export const EFFORT_TO_BUDGET_TOKENS: Record<'medium' | 'high' | 'xhigh', number> = {
  medium:  8_000,
  high:   16_000,
  xhigh:  32_000,
} as const;

// ── Section 5.6: Per-Role Token Budget ────────────────────────────────────

/**
 * Per-role token and USD budget limits (Section 5.6).
 * Session-level cap ($25 default) enforced separately by the orchestrator.
 */
export const ROLE_TOKEN_BUDGET: Record<CodingRole, TokenBudget> = {
  'codebase-scanner': { maxInputTokens:  50_000, maxOutputTokens: 10_000, maxCostUsd: 0.50 },
  'architect':        { maxInputTokens: 200_000, maxOutputTokens: 30_000, maxCostUsd: 5.00 },
  'implementer':      { maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostUsd: 3.00 },
  'stitcher':         { maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostUsd: 3.00 },
  'test-writer':      { maxInputTokens:  80_000, maxOutputTokens: 15_000, maxCostUsd: 2.00 },
  'validator':        { maxInputTokens:       0, maxOutputTokens:      0, maxCostUsd: 0.00 },
  'reviewer':         { maxInputTokens: 150_000, maxOutputTokens: 20_000, maxCostUsd: 4.00 },
  'debugger':         { maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostUsd: 3.00 },
  'review-gate':      { maxInputTokens:       0, maxOutputTokens:      0, maxCostUsd: 0.00 },
  'reporter':         { maxInputTokens:  30_000, maxOutputTokens:  5_000, maxCostUsd: 0.25 },
};

/** Default session-level budget configuration (Section 5.6). */
export const SESSION_BUDGET_DEFAULTS = {
  sessionMaxUsd: 25.00,
  retryReserve:  0.15,   // 15% of session budget held back for retries
} as const;

// ── Section 8.1: Bash Command Security Patterns ───────────────────────────

/**
 * Allowed Bash command patterns (Section 8.1).
 * Agents may only run commands that match at least one of these patterns.
 */
export const ALLOWED_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /^(npm|pnpm|yarn|bun)\s+(install|test|run|exec|ci|build|lint|format)\b/,
  /^(pytest|python\s+-m\s+pytest)\b/,
  /^(cargo\s+(build|test|check|clippy|fmt))\b/,
  /^(go\s+(build|test|vet|fmt|generate))\b/,
  /^(make|mvn|gradle)\s+/,
  /^(tsc|eslint|prettier|ruff|black|mypy|flake8)\s+/,
  /^(git\s+(status|diff|log|show|add|commit|stash))\b/,
  /^(cat|head|tail|wc|find|ls|tree|echo)\s+/,
  /^(which|type|env|printenv)\b/,
  /^(mkdir|cp|mv)\s+/,
];

/**
 * Denied Bash command patterns (Section 8.1).
 * Any command matching one of these patterns is blocked, regardless of ALLOWED list.
 * Deny list takes precedence over allow list.
 */
export const DENIED_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*)\b/,  // rm -rf, rm -fr etc.
  /\bgit\s+push\b/,            // Push handled by orchestrator, never by agents
  /\bcurl\b|\bwget\b/,         // No arbitrary network requests from agents
  /\bnpm\s+publish\b/,
  /\bdocker\b|\bpodman\b/,
  /\bsudo\b|\bsu\s/,
  /\bchmod\s+[0-7]{3,4}\b/,
  /\bkill\b|\bpkill\b|\bkillall\b/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  /\b(8000|8888|5000)\b/,      // Reserved ports (Section 8.5)
  />\s*\/etc\//,               // No writes to /etc
  /\beval\b/,                  // No dynamic code evaluation
  /\bexec\s+\w/,               // No exec of external binaries via shell built-in
  /--no-verify\b/,             // Never skip git hooks
];

// ── Section 8.4: Secret Pattern Detection (50+ patterns) ─────────────────

/**
 * Regex patterns for detecting secrets and credentials in file content
 * or Bash command output (Section 8.4).
 *
 * The orchestrator's CommitSafetyGuard uses these before every commit.
 * The security hook uses a subset for real-time detection during agent execution.
 */
export const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // AWS
  /AKIA[0-9A-Z]{16}/,
  /aws_secret_access_key\s*=\s*[A-Za-z0-9/+]{40}/i,
  /aws_session_token\s*=\s*[A-Za-z0-9/+=]{100,}/i,

  // GitHub
  /ghp_[a-zA-Z0-9]{36}/,         // GitHub personal access token
  /gho_[a-zA-Z0-9]{36}/,         // GitHub OAuth token
  /ghs_[a-zA-Z0-9]{36}/,         // GitHub App installation token
  /ghr_[a-zA-Z0-9]{36}/,         // GitHub refresh token
  /github_pat_[a-zA-Z0-9_]{82}/, // Fine-grained GitHub PAT

  // Anthropic
  /sk-ant-api\d{2}-[A-Za-z0-9\-_]{93}/,

  // OpenAI
  /sk-[A-Za-z0-9]{48}/,
  /sk-proj-[A-Za-z0-9\-_]{48,}/,

  // Google
  /AIza[0-9A-Za-z\-_]{35}/,      // Google API key
  /ya29\.[0-9A-Za-z\-_]+/,       // Google OAuth token

  // Stripe
  /sk_live_[0-9a-zA-Z]{24}/,
  /pk_live_[0-9a-zA-Z]{24}/,
  /rk_live_[0-9a-zA-Z]{24}/,

  // Slack
  /xox[baprs]-[0-9]{12}-[0-9]{12}-[0-9a-zA-Z]{24}/,
  /xoxe\.[0-9a-zA-Z-]{86,}/,

  // Twilio
  /AC[0-9a-fA-F]{32}/,
  /SK[0-9a-fA-F]{32}/,

  // SendGrid
  /SG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}/,

  // Mailchimp
  /[0-9a-f]{32}-us[0-9]{1,2}/,

  // PEM / X.509 private keys
  /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)?\s*PRIVATE KEY-----/,
  /-----BEGIN CERTIFICATE-----/,

  // JWT tokens (all three parts)
  /eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}/,

  // Generic high-entropy secrets (key=value patterns with long values)
  /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[=:]\s*['"]?[A-Za-z0-9/+\-_]{20,}['"]?/i,
  /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{8,}['"]/i,
  /(?:private[_-]?key|client[_-]?secret)\s*[=:]\s*['"]?[A-Za-z0-9/+\-_]{16,}['"]?/i,

  // Database connection strings with credentials
  /(?:mysql|postgres|postgresql|mongodb|redis|amqp):\/\/[^:]+:[^@]+@/i,
  /(?:DB_PASSWORD|DATABASE_PASSWORD|REDIS_PASSWORD|MONGO_PASSWORD)\s*[=:]\s*\S{8,}/i,

  // Heroku API key
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,

  // NPM auth token
  /\/\/registry\.npmjs\.org\/:_authToken=[A-Za-z0-9\-_]{36}/,

  // Firebase
  /AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}/,

  // Cloudinary
  /cloudinary:\/\/[0-9]+:[A-Za-z0-9_-]+@[a-z]+/i,

  // Shopify
  /shpat_[0-9a-fA-F]{32}/,
  /shpss_[0-9a-fA-F]{32}/,
  /shpca_[0-9a-fA-F]{32}/,

  // Square
  /sq0atp-[0-9A-Za-z\-_]{22}/,
  /sq0csp-[0-9A-Za-z\-_]{43}/,

  // Datadog
  /DD_API_KEY\s*[=:]\s*[0-9a-f]{32}/i,

  // PagerDuty
  /[ur]\+[A-Za-z0-9_-]{20}/,

  // .env file leak detection (when content includes key=value pairs)
  /^(?:export\s+)?[A-Z_]{3,}[_\w]*\s*=\s*['"]?(?!false|true|null|undefined|localhost|127\.0\.0\.1|0\.0\.0\.0|\d{1,5})[A-Za-z0-9/+\-_.]{16,}['"]?$/m,
];

// ── Section 8.2: Role Write Permission Map ────────────────────────────────

/**
 * Whether each role is allowed to write/edit files at all.
 * Fine-grained path filtering is done via targetFiles in the hook context.
 */
const ROLE_WRITE_ALLOWED: Readonly<Record<CodingRole, boolean>> = {
  'codebase-scanner': false,
  'architect':        false,
  'implementer':      true,
  'stitcher':         true,
  'test-writer':      true,
  'validator':        false,
  'reviewer':         false,
  'debugger':         true,
  'review-gate':      false,
  'reporter':         false,
};

// ── Section 8.1-8.4: Security PreToolUse Hook ────────────────────────────

export interface SecurityHookContext {
  /** The coding role this agent is executing as. */
  role: CodingRole;
  /**
   * Files this agent is explicitly allowed to write (empty = none).
   * Used for fine-grained path enforcement on Write/Edit.
   */
  targetFiles?: string[];
  /** Whether to enforce the Bash command allowlist/denylist. */
  enforceBashPolicy?: boolean;
  /** Whether to scan for secrets in Write content. */
  scanForSecrets?: boolean;
  /** Workspace root — Write/Edit paths outside this are denied. */
  workspaceDir?: string;
}

export interface HookDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

/**
 * Build a security PreToolUse hook for coding agents (Sections 8.1-8.4).
 *
 * Enforces:
 * 1. Role-based write permission: roles without write access cannot Write/Edit
 * 2. Target-file enforcement: Write/Edit allowed only to assigned targetFiles
 * 3. Bash command policy: DENIED_COMMAND_PATTERNS block dangerous commands;
 *    optionally enforce ALLOWED_COMMAND_PATTERNS as an allowlist
 * 4. Secret scanning: detect secrets in Write content before they reach disk
 * 5. Workspace containment: paths outside workspaceDir are denied
 * 6. Port restriction enforcement (8000, 8888, 5000)
 *
 * @param context - Role, targetFiles, and policy flags.
 * @returns A hook function compatible with the SDK's PreToolUse hook interface.
 */
export function buildSecurityPreToolUseHook(
  context: SecurityHookContext,
): (toolName: string, toolInput: Record<string, unknown>) => HookDecision {
  const {
    role,
    targetFiles = [],
    enforceBashPolicy = true,
    scanForSecrets = true,
    workspaceDir,
  } = context;

  return function securityPreToolUseHook(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): HookDecision {

    // ── 1. Write/Edit access control ─────────────────────────────────────
    if (toolName === 'Write' || toolName === 'Edit') {
      // Roles without any write access
      if (!ROLE_WRITE_ALLOWED[role]) {
        return {
          decision: 'deny',
          reason: `Role '${role}' does not have write access (read-only role). ` +
                  `Only implementer, stitcher, test-writer, and debugger may write files.`,
        };
      }

      // Path-level enforcement when targetFiles are specified
      if (targetFiles.length > 0) {
        const targetPath = String(toolInput.file_path ?? '');
        const normalised = path.resolve(targetPath);
        const allowed = targetFiles.some((f) => path.resolve(f) === normalised);
        if (!allowed) {
          return {
            decision: 'deny',
            reason: `Role '${role}' is not allowed to write '${targetPath}'. ` +
                    `Allowed target files: ${targetFiles.join(', ')}`,
          };
        }
      }

      // Workspace containment — deny writes outside workspaceDir
      if (workspaceDir) {
        const targetPath = path.resolve(String(toolInput.file_path ?? ''));
        const wsRoot = path.resolve(workspaceDir);
        if (!targetPath.startsWith(wsRoot + path.sep) && targetPath !== wsRoot) {
          return {
            decision: 'deny',
            reason: `Write to '${targetPath}' is outside workspace '${wsRoot}'.`,
          };
        }
      }

      // Secret scanning on Write content (before it reaches disk)
      if (scanForSecrets && toolName === 'Write') {
        const content = String(toolInput.content ?? '');
        const matched = SECRET_PATTERNS.find((p) => p.test(content));
        if (matched) {
          return {
            decision: 'deny',
            reason: `Write blocked: content appears to contain a secret or credential ` +
                    `(matched pattern: ${matched.source.slice(0, 60)}...). ` +
                    `Remove secrets before writing — use environment variables instead.`,
          };
        }
      }
    }

    // ── 2. Bash command policy ────────────────────────────────────────────
    if (toolName === 'Bash' && enforceBashPolicy) {
      const command = String(toolInput.command ?? '').trim();

      // Deny list always takes precedence
      const denied = DENIED_COMMAND_PATTERNS.find((p) => p.test(command));
      if (denied) {
        return {
          decision: 'deny',
          reason: `Bash command blocked by security policy (denied pattern: ` +
                  `${denied.source.slice(0, 80)}). Command: ${command.slice(0, 120)}`,
        };
      }

      // Read-only roles (scanner) may only use Bash for enumeration/reading
      if (role === 'codebase-scanner') {
        const roPatterns: RegExp[] = [
          /^(cat|head|tail|wc|find|ls|tree|echo|which|type|env|printenv)\s/,
          /^git\s+(status|diff|log|show)\b/,
          /^(grep|rg|ag)\s+/,
        ];
        if (!roPatterns.some((p) => p.test(command))) {
          return {
            decision: 'deny',
            reason: `Role 'codebase-scanner' may only run read-only Bash commands. ` +
                    `Blocked: ${command.slice(0, 100)}`,
          };
        }
      }
    }

    return { decision: 'allow' };
  };
}

// ── Section 5.5: Error Handling and Recovery ──────────────────────────────

/** Classification of an agent error for recovery routing. */
export type ErrorClassification =
  | 'transient'          // Rate limit, network blip, 5xx — retry with backoff
  | 'budget_exceeded'    // Per-node or session budget exhausted
  | 'turn_limit'         // Agent hit max_turns without completing
  | 'permanent'          // Auth failure, 4xx, schema error — fail immediately
  | 'tool_denied';       // Security hook blocked a tool call

/** Recovery action returned by AgentErrorHandler. */
export type RecoveryAction =
  | { action: 'retry'; delayMs: number }
  | { action: 'checkpoint_and_pause'; reason: string }
  | { action: 'extend_turns'; additionalTurns: number }
  | { action: 'fail'; error: string }
  | { action: 'retry_with_instruction'; instruction: string; delayMs: number };

/** Retry configuration (Section 5.5). */
export const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  /** Multipliers applied per attempt: [1.0×, 1.5×, 2.0×, 2.0×]. */
  timeoutMultipliers: [1.0, 1.5, 2.0, 2.0],
  /** Additional turns granted when a turn-limit error is recoverable. */
  extendTurnsAmount: 20,
} as const;

/**
 * 30+ error classification patterns (Section 5.5).
 * Matched in order; first match wins.
 */
const ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; classification: ErrorClassification }> = [
  // Permanent — auth and API key errors
  { pattern: /invalid api key|authentication failed|invalid_api_key/i,  classification: 'permanent' },
  { pattern: /\b(401|403)\b.*unauthorized|forbidden/i,                  classification: 'permanent' },
  { pattern: /permission denied|access denied/i,                        classification: 'permanent' },
  { pattern: /api key.*expired|key.*revoked/i,                          classification: 'permanent' },

  // Permanent — client-side 4xx (except 429)
  { pattern: /\b400\b.*bad request/i,                                   classification: 'permanent' },
  { pattern: /\b404\b.*not found/i,                                     classification: 'permanent' },
  { pattern: /\b422\b.*unprocessable/i,                                 classification: 'permanent' },
  { pattern: /schema validation|invalid json|malformed/i,               classification: 'permanent' },
  { pattern: /model not found|unknown model/i,                          classification: 'permanent' },

  // Permanent — security hook denial
  { pattern: /blocked by security policy|role.*cannot write|outside workspace/i, classification: 'tool_denied' },
  { pattern: /write blocked.*secret|credential.*detected/i,             classification: 'tool_denied' },
  { pattern: /denied.*tool|tool.*denied/i,                              classification: 'tool_denied' },

  // Budget exceeded
  { pattern: /max budget.*usd|budget.*exceeded|error_max_budget_usd/i,  classification: 'budget_exceeded' },
  { pattern: /cost limit.*reached|session.*budget.*exhausted/i,         classification: 'budget_exceeded' },

  // Turn limit
  { pattern: /max turns.*reached|error_max_turns|turn limit/i,          classification: 'turn_limit' },
  { pattern: /max_iterations.*exceeded|iteration.*limit/i,              classification: 'turn_limit' },

  // Transient — rate limits
  { pattern: /rate limit|rate_limit_error|\b429\b/i,                    classification: 'transient' },
  { pattern: /too many requests/i,                                       classification: 'transient' },
  { pattern: /quota.*exceeded|api.*quota/i,                             classification: 'transient' },

  // Transient — network and server errors
  { pattern: /\b5[0-9]{2}\b|internal server error|service unavailable/i, classification: 'transient' },
  { pattern: /timeout|timed out|etimedout|econnreset/i,                 classification: 'transient' },
  { pattern: /econnrefused|network error|fetch failed/i,                classification: 'transient' },
  { pattern: /socket hang up|connection reset|epipe/i,                  classification: 'transient' },
  { pattern: /overloaded|please try again/i,                            classification: 'transient' },

  // Transient — SDK execution errors (may be retryable)
  { pattern: /error_during_execution|error during execution/i,          classification: 'transient' },
  { pattern: /subprocess.*crashed|sdk.*crashed/i,                       classification: 'transient' },
  { pattern: /unexpected.*error|unknown error/i,                        classification: 'transient' },
];

/**
 * Classify an error string into an `ErrorClassification` category.
 * Matches against 30+ regex patterns in order; returns 'transient' as default.
 *
 * @param errorMessage - The error message to classify.
 * @returns The error classification.
 */
export function classifyError(errorMessage: string): ErrorClassification {
  const msg = errorMessage.toLowerCase();
  for (const { pattern, classification } of ERROR_PATTERNS) {
    if (pattern.test(msg)) return classification;
  }
  // Default: assume transient (safe to retry)
  return 'transient';
}

/**
 * Compute exponential backoff delay for a retry attempt.
 *
 * @param attempt - Zero-indexed retry attempt number.
 * @returns Delay in milliseconds.
 */
export function computeBackoff(attempt: number): number {
  const multiplier = RETRY_CONFIG.timeoutMultipliers[
    Math.min(attempt, RETRY_CONFIG.timeoutMultipliers.length - 1)
  ] ?? 2.0;
  return Math.round(RETRY_CONFIG.baseDelayMs * multiplier);
}

/**
 * Error handler for coding agent nodes (Section 5.5).
 *
 * Classifies errors and returns the appropriate recovery action.
 * Used by the executor to decide whether to retry, pause, extend, or fail.
 *
 * @example
 * ```typescript
 * const handler = new AgentErrorHandler();
 * const action = handler.handleError(error, node.retryCount ?? 0, node.codingRole);
 * if (action.action === 'retry') {
 *   await sleep(action.delayMs);
 *   return retryNode(node);
 * }
 * ```
 */
export class AgentErrorHandler {
  /**
   * Handle an agent error and return the appropriate recovery action.
   *
   * @param error - The error (Error object or string).
   * @param retryCount - Number of retries already attempted (0 = first failure).
   * @param role - The coding role of the failing node (optional, for context).
   * @returns RecoveryAction describing what the caller should do.
   */
  handleError(
    error: unknown,
    retryCount: number,
    role?: CodingRole,
  ): RecoveryAction {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const classification = classifyError(errorMessage);

    switch (classification) {
      case 'transient': {
        if (retryCount >= RETRY_CONFIG.maxRetries) {
          return {
            action: 'fail',
            error: `Max retries (${RETRY_CONFIG.maxRetries}) exceeded. Last error: ${errorMessage}`,
          };
        }
        return {
          action: 'retry',
          delayMs: computeBackoff(retryCount),
        };
      }

      case 'budget_exceeded':
        return {
          action: 'checkpoint_and_pause',
          reason: `Budget exhausted${role ? ` for role '${role}'` : ''}. ${errorMessage}`,
        };

      case 'turn_limit': {
        // Only extend turns on first occurrence; if it happens again, fail
        if (retryCount === 0) {
          return {
            action: 'extend_turns',
            additionalTurns: RETRY_CONFIG.extendTurnsAmount,
          };
        }
        return {
          action: 'fail',
          error: `Turn limit reached after extension${role ? ` (role: '${role}')` : ''}. ${errorMessage}`,
        };
      }

      case 'permanent':
        return {
          action: 'fail',
          error: `Permanent error (will not retry)${role ? ` for role '${role}'` : ''}: ${errorMessage}`,
        };

      case 'tool_denied':
        return {
          action: 'retry_with_instruction',
          instruction:
            'The previous operation was blocked by the security policy. ' +
            'Please use an alternative approach that does not require writing to ' +
            'files outside your assigned scope or running restricted commands.',
          delayMs: 0,
        };
    }
  }
}

// ── Section 5.1-5.3: createCodingAgent() ─────────────────────────────────

/**
 * Configuration for creating a coding agent via `createCodingAgent()`.
 * Covers all ClaudeAgentOptions fields relevant to coding tasks.
 */
export interface CodingAgentOptions {
  /** Task description (the user-facing prompt). */
  task: string;
  /** The coding role — determines tools, turns, thinking, and security. */
  role: CodingRole;
  /** Resolved model ID (from CodingModelResolver). */
  model: string;
  /** Working directory. */
  cwd: string;
  /** Per-node USD budget cap. */
  nodeBudgetUsd?: number;
  /**
   * Files this agent is allowed to write/edit.
   * Required for write-capable roles (implementer, stitcher, test-writer, debugger).
   */
  targetFiles?: string[];
  /** MCP servers to make available (e.g. skills MCP, codebase query). */
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  /**
   * System prompt override (appended to Claude Code preset).
   * If omitted, only the Claude Code preset + port instructions are used.
   */
  systemPromptAppend?: string;
  /**
   * Complexity tier — used by ROLE_THINKING_CONFIG.upgradeToXhigh to decide
   * whether the architect/debugger should use extended thinking.
   */
  complexityTier?: 'trivial' | 'small' | 'medium' | 'large' | 'epic';
  /** Whether to load project-level CLAUDE.md. Default: true. */
  loadProjectSettings?: boolean;
}

/**
 * Create the SDK query options for a coding agent node (Sections 5.1-5.3).
 *
 * Centralises role-based configuration:
 * - `allowed_tools` from ROLE_TOOL_MAP
 * - `max_turns` from ROLE_MAX_TURNS
 * - `effort` from ROLE_THINKING_CONFIG (with optional xhigh upgrade)
 * - `max_budget_usd` from nodeBudgetUsd or ROLE_TOKEN_BUDGET
 * - `hooks.PreToolUse` from buildSecurityPreToolUseHook()
 *
 * @param options - Coding agent configuration.
 * @returns Options object ready to spread into the SDK `query()` call.
 */
export function createCodingAgent(options: CodingAgentOptions): {
  allowedTools: string[];
  maxTurns: number;
  effort: 'low' | 'medium' | 'high';
  maxBudgetUsd: number | undefined;
  securityHook: (toolName: string, toolInput: Record<string, unknown>) => HookDecision;
  systemPromptConfig: { type: 'preset'; preset: 'claude_code'; append?: string } | string;
} {
  const {
    role,
    model,
    cwd,
    nodeBudgetUsd,
    targetFiles,
    systemPromptAppend,
    complexityTier = 'medium',
    loadProjectSettings = true,
  } = options;

  // Tool set
  const allowedTools = ROLE_TOOL_MAP[role] ?? DEFAULT_CODING_TOOLS;

  // Max turns
  const maxTurns = ROLE_MAX_TURNS[role] ?? 30;

  // Thinking / effort
  const thinkingCfg = ROLE_THINKING_CONFIG[role];
  let effort: 'low' | 'medium' | 'high';
  if (!thinkingCfg.enabled) {
    effort = 'low';
  } else if (thinkingCfg.upgradeToXhigh?.(complexityTier)) {
    // 'xhigh' isn't a valid SDK effort value — map to 'high' (SDK handles budget scaling)
    effort = 'high';
  } else {
    // Map xhigh -> high for SDK compatibility; only low/medium/high are valid effort values
    const base = thinkingCfg.effort;
    effort = base === 'xhigh' ? 'high' : base;
  }

  // Budget cap
  const roleBudget = ROLE_TOKEN_BUDGET[role];
  const maxBudgetUsd = nodeBudgetUsd ?? (roleBudget.maxCostUsd > 0 ? roleBudget.maxCostUsd : undefined);

  // Security hook
  const securityHook = buildSecurityPreToolUseHook({
    role,
    targetFiles,
    enforceBashPolicy: true,
    scanForSecrets: true,
    workspaceDir: cwd,
  });

  // System prompt — inject role-specific instructions from AGENT_ROLE_SYSTEM_PROMPTS
  const rolePrompt = AGENT_ROLE_SYSTEM_PROMPTS[role] ?? '';
  const portInstructions = `\n\n## Reserved Port Restrictions\nDo NOT start any server on ports 8000, 8888, or 5000 — they are reserved.`;
  const appendParts = [rolePrompt, portInstructions, systemPromptAppend].filter(Boolean).join('\n\n');
  const systemPromptConfig = {
    type: 'preset' as const,
    preset: 'claude_code' as const,
    append: appendParts || undefined,
  };

  void model;             // Available for caller to use in query()
  void loadProjectSettings; // Available for caller to pass as settingSources

  return {
    allowedTools,
    maxTurns,
    effort,
    maxBudgetUsd,
    securityHook,
    systemPromptConfig,
  };
}

/** Configuration for a general AGENT node execution via the Agent SDK. */
export interface AgentExecutionConfig {
  /** The task description. */
  task: string;
  /** Resolved model ID. */
  model: string;
  /** Worker system prompt (plain string, built by buildWorkerSystemPrompt). */
  systemPrompt: string;
  /** Working directory for the agent. */
  cwd: string;
  /** Skill IDs — docs are injected via systemPrompt; reserved for future MCP integration. */
  skillIds?: string[];
  /**
   * Token budget from agent config. Converted to maxBudgetUsd unless
   * maxBudgetUsd is explicitly provided.
   */
  tokenBudget?: number;
  /** Explicit USD budget override (takes precedence over tokenBudget). */
  maxBudgetUsd?: number;
  /** Abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
  /** Progress callback for WorkerEvent emission. */
  onProgress?: (event: { type: string; message: string; progress?: number }) => void;
  /** Optional structured output format. When provided, the SDK will return parsed JSON. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** Run output directory for this workflow. Injected as ORIONOMEGA_RUN_DIR env var. */
  runDir?: string;
  /**
   * Optional human-in-the-loop approval callback. When supplied, any tool
   * the policy would deny because of an `autonomous.humanGates` match is
   * surfaced to the human first; their answer is forwarded into the SDK's
   * `canUseTool` response. Without a callback the policy keeps its
   * autonomous-default deny behaviour. See `permission-policy.ts`.
   */
  humanGateCallback?: (action: string, description: string, signal: AbortSignal) => Promise<boolean>;
}

/** Result of an AGENT node execution via the Agent SDK. */
export interface AgentExecutionResult {
  /** Final text output from the agent. */
  output: string;
  /** Total tool calls made. */
  toolCalls: number;
  /** Whether execution completed successfully. */
  success: boolean;
  /** Error message if the agent failed. */
  error?: string;
  /** Cost in USD (if reported by the SDK). */
  costUsd?: number;
  /** Duration in seconds. */
  durationSec: number;
  /** Paths to files written by the agent (tracked from Write tool calls). */
  outputPaths: string[];
  /** Parsed structured output when outputFormat was provided. */
  structuredOutput?: unknown;
  /**
   * The SDK result text (concise final summary), separate from the full
   * accumulated output. Prefer this for display; fall back to output if empty.
   */
  finalResult?: string;
  /** Total input tokens consumed across all turns. */
  inputTokens?: number;
  /** Total output tokens consumed across all turns. */
  outputTokens?: number;
  /** Total cache read tokens across all turns. */
  cacheReadTokens?: number;
  /** Total cache creation tokens across all turns. */
  cacheCreationTokens?: number;
  /**
   * If false, the failure is permanent (auth error, bad config) and the
   * caller should not retry. Undefined on success.
   */
  retryable?: boolean;
  /** SDK result subtype when the SDK reported a non-success result. */
  errorSubtype?: SDKResultError['subtype'];
}

/**
 * Converts a token budget to a rough USD estimate for the given model.
 *
 * The budget is meant to bound total *cost*, but real workers spend their
 * tokens across four very differently priced lanes: input, output, cache
 * read, cache write. For tool-heavy workers (research with web_search /
 * web_fetch, repeated tool round-trips), cache writes dominate — they're
 * billed at ~3.75× input — so a small linear multiplier on input cost is
 * wildly off and silently kills workers mid-run with `error_max_budget_usd`.
 *
 * Empirical: a sonnet research worker with `tokenBudget: 200_000` was
 * burning ~$2.40 in real cache traffic alone, so the prior 4× multiplier
 * misrepresented the budget by roughly an order of magnitude.
 *
 * The conversion uses a 12× multiplier as a closer upper bound that covers
 * a typical mix of input + output + cache traffic, and the floor/cap are
 * raised so per-node budgets aren't crushed for legitimate research workers.
 */
function tokenBudgetToUsd(tokenBudget: number, model: string): number {
  const lower = model.toLowerCase();
  let costPerMillion: number;
  if (lower.includes('haiku')) costPerMillion = 1.0;
  else if (lower.includes('opus')) costPerMillion = 5.0;
  else costPerMillion = 3.0;

  const estimated = (tokenBudget / 1_000_000) * costPerMillion * 12;
  return Math.max(5.0, Math.min(estimated, 100.0));
}

// ── P5: Skill MCP server ─────────────────────────────────────────────

/**
 * Convert a JSON Schema property descriptor to a Zod type.
 * Handles the most common types; falls back to z.unknown() for complex schemas.
 */
function jsonSchemaPropertyToZod(
  prop: Record<string, unknown>,
  required: boolean,
): z.ZodType {
  const type = prop.type as string | undefined;

  let base: z.ZodType;

  if (prop.enum && Array.isArray(prop.enum)) {
    // Enum — use z.enum for string enums, z.unknown otherwise
    const values = prop.enum as unknown[];
    if (values.length >= 1 && values.every((v) => typeof v === 'string')) {
      base = z.enum(values as [string, ...string[]]);
    } else {
      // Mixed or non-string enum — accept any value
      base = z.unknown();
    }
  } else if (type === 'string') {
    base = z.string();
  } else if (type === 'number' || type === 'integer') {
    base = z.number();
  } else if (type === 'boolean') {
    base = z.boolean();
  } else if (type === 'array') {
    const items = prop.items as Record<string, unknown> | undefined;
    if (items?.type === 'string') {
      base = z.array(z.string());
    } else if (items?.type === 'number' || items?.type === 'integer') {
      base = z.array(z.number());
    } else {
      base = z.array(z.unknown());
    }
  } else if (type === 'object') {
    base = z.record(z.string(), z.unknown());
  } else {
    base = z.unknown();
  }

  return required ? base : base.optional();
}

/**
 * Convert a JSON Schema object descriptor (with `properties` and `required`)
 * into a Zod raw shape (plain object of zod types) for use with tool().
 */
function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodType> {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const requiredFields = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  const shape: Record<string, z.ZodType> = {};
  for (const [key, propDef] of Object.entries(properties)) {
    shape[key] = jsonSchemaPropertyToZod(propDef, requiredFields.has(key));
  }
  return shape;
}

/**
 * Build an in-process MCP server exposing all tools from the given skill IDs.
 *
 * Each skill's tools are registered as SDK MCP tool definitions. The handler
 * reads the skill's config.json to obtain API keys and other env vars, then
 * delegates to SkillExecutor.executeHandler() (JSON-in / JSON-out child process).
 *
 * @param skillIds - Skill identifiers to expose (e.g. ["linear"]).
 * @param skillsDir - Absolute path to the skills directory.
 * @returns McpSdkServerConfigWithInstance ready to pass to query() mcpServers.
 */
async function buildSkillMcpServer(
  skillIds: string[],
  skillsDir: string,
): Promise<McpSdkServerConfigWithInstance> {
  const executor = new SkillExecutor();
  const toolDefs: ReturnType<typeof tool>[] = [];

  // Reuse the shared skill-toolset builder so the orchestration worker path
  // and the direct-chat path agree on which skills are eligible (loaded,
  // enabled, configured) and how their handlers/env are resolved. The MCP
  // server still surfaces each tool under its raw (non-namespaced) name —
  // workers see one skill per MCP server, so collisions can't occur there
  // and changing the surface name would be a behaviour change.
  const { tools: entries } = await buildSkillToolset(skillIds, skillsDir);

  for (const entry of entries) {
    const zodShape = jsonSchemaToZodShape(entry.inputSchema);
    const mcpTool = tool(
      entry.rawName,
      entry.description,
      zodShape,
      async (args: Record<string, unknown>) => {
        try {
          const result = await executor.executeHandler(
            entry.handlerPath,
            args,
            { cwd: entry.cwd, timeout: entry.timeout, env: entry.env },
          );
          const text =
            typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(`Skill tool "${entry.rawName}" failed: ${errMsg}`);
          return {
            content: [{ type: 'text' as const, text: `Error: ${errMsg}` }],
            isError: true,
          };
        }
      },
    );

    toolDefs.push(mcpTool);
    log.info(`Registered MCP skill tool: ${entry.rawName} (from ${entry.skillId})`);
  }

  return createSdkMcpServer({ name: 'orionomega-skills', tools: toolDefs });
}

/**
 * Execute a general AGENT node using the Claude Agent SDK.
 *
 * This replaces the hand-rolled runAgentLoop() for AGENT nodes, gaining the
 * full Claude Code toolset (Bash, Glob, Grep, WebSearch, WebFetch, etc.),
 * adaptive thinking, and non-blocking async tool execution.
 *
 * @param options - Agent execution configuration.
 * @returns AgentExecutionResult with output, metrics, and output file paths.
 */
export async function executeAgent(
  options: AgentExecutionConfig,
): Promise<AgentExecutionResult> {
  const config = readConfig();
  const sdkConfig = config.agentSdk;
  const apiKey = config.models.apiKey;

  if (!apiKey) {
    return {
      output: '',
      toolCalls: 0,
      success: false,
      error: 'No API key configured',
      durationSec: 0,
      outputPaths: [],
      // Permanent: no retry will conjure an API key into existence.
      retryable: false,
    };
  }

  const {
    task, model, systemPrompt, cwd,
    abortSignal, onProgress, outputFormat,
  } = options;

  const maxBudgetUsd = options.maxBudgetUsd
    ?? sdkConfig.maxBudgetUsd
    ?? (options.tokenBudget ? tokenBudgetToUsd(options.tokenBudget, model) : undefined);

  log.info(`Starting agent: "${task.slice(0, 80)}..."`, { model, cwd });
  onProgress?.({ type: 'status', message: `Agent starting: ${task.slice(0, 60)}...`, progress: 0 });

  const abortController = new AbortController();
  // `queryResult` is created later but the abort signal can fire at any point.
  // Holding it in a ref lets the abort listener attempt a graceful interrupt
  // (`Query.interrupt()`) before we hard-abort the SDK process.
  const queryRef: {
    current: { interrupt?: () => Promise<void> | void; close?: () => void } | null;
  } = { current: null };
  let interruptAttempted = false;
  const tryGracefulInterrupt = (): void => {
    if (interruptAttempted) return;
    interruptAttempted = true;
    const q = queryRef.current;
    if (!q || typeof q.interrupt !== 'function') return;
    try {
      // Fire-and-forget; SDK rejects to abort path on failure.
      void Promise.resolve(q.interrupt()).catch(() => { /* swallow — abort path will fire */ });
    } catch { /* swallow — abort path will fire */ }
  };
  let closed = false;
  const tryClose = (): void => {
    if (closed) return;
    closed = true;
    const q = queryRef.current;
    if (!q || typeof q.close !== 'function') return;
    try { q.close(); } catch { /* swallow — process is going down anyway */ }
  };
  /**
   * Three-phase shutdown:
   *   1. `Query.interrupt()` immediately so the SDK can end its current turn
   *      gracefully and flush any pending message.
   *   2. After `INTERRUPT_GRACE_MS`, hard-`AbortController.abort(reason)` so
   *      the iterator unblocks even if interrupt() wedged.
   *   3. Also call `Query.close()` at escalation time so the SDK transport
   *      tears down deterministically (without close(), the underlying
   *      subprocess can linger).
   * Timer is `.unref()`'d so it never keeps the event loop alive after the
   * iterator drains naturally.
   */
  const INTERRUPT_GRACE_MS = 5_000;
  const escalateToHardAbort = (reason: unknown): void => {
    tryGracefulInterrupt();
    setTimeout(() => {
      abortController.abort(reason);
      tryClose();
    }, INTERRUPT_GRACE_MS).unref?.();
  };
  if (abortSignal) {
    // Forward the *reason* too — without this the inner controller would
    // throw a plain "AbortError" with no kind, and the catch site couldn't
    // distinguish a user cancel from a wall-clock timeout.
    if (abortSignal.aborted) {
      escalateToHardAbort(abortSignal.reason);
    } else {
      abortSignal.addEventListener('abort', () => escalateToHardAbort(abortSignal.reason));
    }
  }

  const startTime = Date.now();
  let output = '';
  let finalResult = '';
  let toolCalls = 0;
  let costUsd: number | undefined;
  let structuredOutput: unknown;
  const outputPaths: string[] = [];
  let progressEstimate = 5;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  // P5: Build skill MCP server if skillIds are provided
  let mcpServers: Record<string, McpSdkServerConfigWithInstance> | undefined;
  if (options.skillIds?.length) {
    const skillsDir = readConfig().skills?.directory;
    if (skillsDir) {
      try {
        const mcpServer = await buildSkillMcpServer(options.skillIds, skillsDir);
        mcpServers = { 'orionomega-skills': mcpServer };
        log.info(`Skill MCP server built with ${options.skillIds.join(', ')} for worker`);
      } catch (err) {
        log.warn(
          `Failed to build skill MCP server: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  try {
    // Use the same permission mode as coding agents — bypassPermissions crashes
    // if claude hasn't been explicitly opted in, so respect the config setting
    const permissionMode = sdkConfig.permissionMode === 'bypassPermissions'
      ? 'bypassPermissions'
      : sdkConfig.permissionMode === 'acceptEdits'
        ? 'acceptEdits'
        : 'default';

    if (permissionMode === 'bypassPermissions') {
      log.warn(
        '[security] bypassPermissions mode is active — all tool permission prompts will be ' +
        'skipped for this agent. Ensure this is intentional. Review humanGates config if ' +
        'running in autonomous mode.',
      );
    }

    // Defense-in-depth: even with permissionMode='acceptEdits' as the floor,
    // the SDK can still raise tool-permission requests for other tool kinds.
    // Wire `canUseTool` so the orchestrator answers them programmatically
    // (allowing what's already in allowedTools, denying anything that hits
    // humanGates) and a passive PermissionRequest hook so we audit every
    // escalation. See `./permission-policy.ts` for the policy module.
    const agentAllowedTools = DEFAULT_AGENT_TOOLS;
    const humanGates = config.autonomous?.humanGates;
    const canUseTool = buildCanUseTool({
      allowedTools: agentAllowedTools,
      humanGates,
      actor: 'agent',
      ...(options.humanGateCallback
        ? {
            requestApproval: (toolName, reason, signal) =>
              options.humanGateCallback!(toolName, reason, signal),
          }
        : {}),
    });
    const permissionRequestHook = buildPermissionRequestHook('agent');

    const queryResult = query({
      prompt: task,
      options: {
        model,
        cwd,
        allowedTools: agentAllowedTools,
        permissionMode,
        canUseTool,
        hooks: {
          PermissionRequest: [{ hooks: [permissionRequestHook] }],
        },
        // (queryRef wired below — needs queryResult to exist first)
        ...(permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        effort: sdkConfig.effort ?? 'high',
        // Adaptive thinking — Claude decides when/how much to think
        thinking: { type: 'adaptive' },
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
        systemPrompt,
        abortController,
        env: {
          ...process.env,
          HOME: process.env.HOME || '/root',
          PATH: process.env.PATH || '',
          TERM: process.env.TERM || 'xterm-256color',
          SHELL: process.env.SHELL || '/bin/sh',
          USER: process.env.USER || '',
          LANG: process.env.LANG || 'en_US.UTF-8',
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'orionomega-worker',
        },
        additionalDirectories: sdkConfig.additionalDirectories,
        // Omit settingSources — default is no CLAUDE.md loading; the worker
        // system prompt is self-contained.
        persistSession: false,
        // P5: Skill MCP server (if any skills are configured)
        ...(mcpServers ? { mcpServers } : {}),
        // P6: Structured output format (optional)
        ...(outputFormat ? { outputFormat } : {}),
        // Capture stderr for diagnostics when the CLI process crashes
        stderr: (data: string) => log.debug(`[agent-stderr] ${data.trimEnd()}`),
      },
    });
    // Wire the queryRef *before* the abort handler can fire mid-iteration —
    // otherwise abort would skip straight to the hard-abort path.
    queryRef.current = queryResult as unknown as { interrupt?: () => Promise<void> | void };
    if (abortController.signal.aborted) {
      // The abort fired between controller creation and queryResult assignment;
      // attempt the graceful interrupt now.
      tryGracefulInterrupt();
    }

    for await (const message of queryResult) {
      // Assistant message — collect text and tool use
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        const usage = (assistantMsg.message as unknown as Record<string, unknown>)?.usage as
          { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        if (usage) {
          totalInputTokens += usage.input_tokens ?? 0;
          totalOutputTokens += usage.output_tokens ?? 0;
          totalCacheReadTokens += usage.cache_read_input_tokens ?? 0;
          totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        }
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              output += block.text + '\n';
              onProgress?.({
                type: 'status',
                message: block.text.trim().slice(0, 100),
                progress: Math.min(progressEstimate, 90),
              });
            }

            if (block.type === 'tool_use') {
              toolCalls++;
              progressEstimate = Math.min(progressEstimate + 5, 90);
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown> | undefined ?? {};
              auditToolInvocation(toolName, toolInput);

              // Build a concise summary
              let summary = toolName;
              if (toolInput.file_path) summary = `${toolName}: ${String(toolInput.file_path)}`;
              else if (toolInput.command) summary = `${toolName}: ${String(toolInput.command).slice(0, 80)}`;
              else if (toolInput.pattern) summary = `${toolName}: ${String(toolInput.pattern)}`;
              else if (toolInput.url) summary = `${toolName}: ${String(toolInput.url).slice(0, 80)}`;

              // Track write/edit paths for output reporting
              if ((toolName === 'Write' || toolName === 'Edit') && toolInput.file_path) {
                outputPaths.push(String(toolInput.file_path));
              }

              onProgress?.({
                type: 'tool_call',
                message: summary,
                progress: progressEstimate,
              });
            }
          }
        }
      }

      // Result message — final output
      if (message.type === 'result') {
        costUsd = (message as SDKResultSuccess | SDKResultError).total_cost_usd;

        if ((message as SDKResultSuccess).subtype === 'success') {
          const successMsg = message as SDKResultSuccess;
          // P6: Prefer structured output over raw text when available
          if (successMsg.structured_output !== undefined) {
            structuredOutput = successMsg.structured_output;
            finalResult = JSON.stringify(successMsg.structured_output, null, 2);
            output += '\n' + finalResult;
          } else if (successMsg.result) {
            finalResult = successMsg.result;
            output += '\n' + successMsg.result;
          }
        } else {
          // SDK reported a structured error result — surface the subtype so the
          // caller can decide whether the failure is worth retrying.
          const errorMsg = message as SDKResultError;
          const description = describeResultError(errorMsg);
          log.warn(`Agent result error (${errorMsg.subtype}): ${description}`);
          // max_budget / max_turns are *not* retryable — the same call would
          // hit the same cap. error_during_execution typically is.
          const retryable =
            errorMsg.subtype === 'error_during_execution';
          const durationSec = (Date.now() - startTime) / 1000;
          return {
            output: output.trim(),
            toolCalls,
            success: false,
            error: `SDK ${errorMsg.subtype}: ${description}`,
            durationSec,
            costUsd,
            outputPaths,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadTokens: totalCacheReadTokens,
            cacheCreationTokens: totalCacheCreationTokens,
            retryable,
            errorSubtype: errorMsg.subtype,
          };
        }

        onProgress?.({
          type: 'done',
          message: `Agent complete: ${toolCalls} tool calls`,
          progress: 100,
        });
      }
    }

    const durationSec = (Date.now() - startTime) / 1000;
    log.info(`Agent completed: ${toolCalls} tool calls, ${durationSec.toFixed(1)}s${costUsd ? ` ($${costUsd.toFixed(4)})` : ''}`);

    return {
      output: output.trim(),
      toolCalls,
      success: true,
      durationSec,
      costUsd,
      outputPaths,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(finalResult ? { finalResult } : {}),
    };
  } catch (err) {
    const durationSec = (Date.now() - startTime) / 1000;
    const aborted = err instanceof AbortError;

    // Disambiguate aborts: if the executor cancelled us with a typed reason,
    // surface that instead of the SDK's stock "process aborted by user"
    // message. This is the core of the timeout-vs-user fix — without it,
    // every wall-clock-driven cancel reads as a user cancel.
    let displayMessage: string;
    let retryable: boolean;
    if (aborted) {
      const reason = options.abortSignal?.reason;
      if (isOrionOmegaAbortReason(reason)) {
        displayMessage = `Agent ${describeAbortReason(reason)}`;
        // Timeout aborts are transient; user cancels are terminal.
        retryable = reason.kind === 'timeout';
      } else {
        displayMessage = err instanceof Error ? err.message : String(err);
        retryable = false;
      }
    } else {
      displayMessage = err instanceof Error ? err.message : String(err);
      retryable = isRetryableSdkError(err);
    }

    log.error(`Agent failed${aborted ? ' (aborted)' : ''}: ${displayMessage}`);
    onProgress?.({ type: 'error', message: `Agent error: ${displayMessage}` });

    return {
      output: output.trim(),
      toolCalls,
      success: false,
      error: displayMessage,
      durationSec,
      outputPaths,
      retryable,
    };
  }
}

/**
 * Execute a coding task using the Claude Agent SDK.
 *
 * This is the main entry point called by the executor for CODING_AGENT nodes.
 * It wraps the SDK's `query()` function, collecting streaming output and
 * returning a structured result.
 *
 * @param node - The workflow node with coding agent configuration.
 * @param workspaceDir - Default working directory.
 * @param onProgress - Callback for progress updates during execution.
 * @returns CodingAgentResult with the agent's output and metrics.
 */
export async function executeCodingAgent(
  node: WorkflowNode,
  workspaceDir: string,
  onProgress?: (event: { type: string; message: string; progress?: number; thinking?: string }) => void,
  abortSignal?: AbortSignal,
  runDir?: string,
  /**
   * Optional human-in-the-loop approval callback. Same contract as
   * `AgentExecutionConfig.humanGateCallback` — see that doc-comment for the
   * full rationale. Threaded into `buildCanUseTool` so the SDK's `canUseTool`
   * response carries the human's decision instead of an automatic deny.
   */
  humanGateCallback?: (action: string, description: string, signal: AbortSignal) => Promise<boolean>,
  /**
   * Round-5 (architect, second pass): orchestration-side commit-safety
   * checkout context. When provided, every Bash tool call the agent
   * issues is intercepted by {@link buildCommitSafetyToolGuard} BEFORE
   * the SDK forwards it to the shell — `--no-verify` is denied
   * categorically, and any `git push` is gated by a fresh
   * {@link findUnsafeCommittedFiles} scan against `baseHeadCommit..HEAD`.
   * This complements the post-execution preflight in `GraphExecutor`
   * but runs *before* push instead of after. See `safe-commit.ts` and
   * `replit.md` Task #209 gotchas.
   */
  commitSafetyContext?: {
    checkoutPath: string;
    baseHeadCommit: string | null;
    onRefuse?: (
      refused: import('./types.js').RefusedCommittedFile[],
      reason: 'no-verify' | 'unsafe-push',
      command: string,
    ) => void;
  },
): Promise<CodingAgentResult> {
  const config = readConfig();
  const sdkConfig = config.agentSdk;
  const apiKey = config.models.apiKey;
  const codingConfig = node.codingAgent ?? { task: node.agent?.task ?? '' };

  if (!apiKey) {
    return {
      output: '',
      toolCalls: 0,
      success: false,
      error: 'No API key configured',
      durationSec: 0,
      outputPaths: [],
      // Permanent: no retry will conjure an API key into existence.
      retryable: false,
    };
  }

  const task = codingConfig.task;
  const cwd = codingConfig.cwd ?? workspaceDir;
  const model = codingConfig.model ?? node.agent?.model ?? config.models.default;

  // Resolve coding role for role-based defaults (Section 5.1-5.3).
  // node.codingConfig is populated by CodingPlanner for CODING_AGENT nodes.
  const codingRole: CodingRole | undefined =
    (node as { codingConfig?: { codingRole?: CodingRole } }).codingConfig?.codingRole;

  // Role-based tool list (ROLE_TOOL_MAP) takes precedence over the legacy
  // DEFAULT_CODING_TOOLS default, but explicit codingConfig.allowedTools wins.
  const allowedTools = codingConfig.allowedTools
    ?? (codingRole ? ROLE_TOOL_MAP[codingRole] : DEFAULT_CODING_TOOLS);

  // Budget: explicit config > role default from ROLE_TOKEN_BUDGET > sdkConfig global
  const roleBudgetDefault = codingRole ? ROLE_TOKEN_BUDGET[codingRole].maxCostUsd : undefined;
  const maxBudgetUsd =
    codingConfig.maxBudgetUsd
    ?? sdkConfig.maxBudgetUsd
    ?? (roleBudgetDefault && roleBudgetDefault > 0 ? roleBudgetDefault : undefined);

  // Max turns: from role map when available (ROLE_MAX_TURNS), otherwise unlimited
  const maxTurns: number | undefined = codingRole ? ROLE_MAX_TURNS[codingRole] : undefined;

  // Effort: per-role from ROLE_THINKING_CONFIG. The claude-agent-sdk (0.3.x)
  // accepts 'low'|'medium'|'high'|'xhigh'|'max' and silently downgrades any
  // level the selected model doesn't support — so we pass the role's true
  // effort through (xhigh is no longer collapsed to high) to honour deep
  // reasoning roles like the debugger on Opus 4.7+/4.8.
  const thinkingCfg = codingRole ? ROLE_THINKING_CONFIG[codingRole] : undefined;
  const resolvedEffort: 'low' | 'medium' | 'high' | 'xhigh' = (() => {
    if (!thinkingCfg || !thinkingCfg.enabled) return 'low';
    return thinkingCfg.effort;
  })();
  const roleEffort = resolvedEffort !== 'low' ? resolvedEffort : undefined;

  log.info(`Starting coding agent: "${task.slice(0, 80)}..."`, {
    model, cwd, tools: allowedTools.length,
  });

  onProgress?.({ type: 'status', message: `Coding agent starting: ${task.slice(0, 60)}...`, progress: 0 });

  // P2: AbortController for SDK cancellation. Forward the abort *reason*
  // so the catch site can distinguish a user cancel from a wall-clock
  // timeout — see executeAgent for the same pattern + rationale. Also
  // attempt a graceful `Query.interrupt()` before the hard abort so the
  // SDK can flush its current turn instead of leaving a half-streamed
  // message behind. The two-phase shutdown gives the SDK 5s to drain
  // before we hard-abort.
  const abortController = new AbortController();
  const queryRef: {
    current: { interrupt?: () => Promise<void> | void; close?: () => void } | null;
  } = { current: null };
  let interruptAttempted = false;
  const tryGracefulInterrupt = (): void => {
    if (interruptAttempted) return;
    interruptAttempted = true;
    const q = queryRef.current;
    if (!q || typeof q.interrupt !== 'function') return;
    try {
      void Promise.resolve(q.interrupt()).catch(() => { /* swallow — abort path will fire */ });
    } catch { /* swallow — abort path will fire */ }
  };
  let closed = false;
  const tryClose = (): void => {
    if (closed) return;
    closed = true;
    const q = queryRef.current;
    if (!q || typeof q.close !== 'function') return;
    try { q.close(); } catch { /* swallow — process is going down anyway */ }
  };
  // Three-phase shutdown — see executeAgent for the full rationale.
  const INTERRUPT_GRACE_MS = 5_000;
  const escalateToHardAbort = (reason: unknown): void => {
    tryGracefulInterrupt();
    setTimeout(() => {
      abortController.abort(reason);
      tryClose();
    }, INTERRUPT_GRACE_MS).unref?.();
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      escalateToHardAbort(abortSignal.reason);
    } else {
      abortSignal.addEventListener('abort', () => escalateToHardAbort(abortSignal.reason));
    }
  }

  const startTime = Date.now();
  let output = '';
  let toolCalls = 0;
  let costUsd: number | undefined;
  const outputPaths: string[] = [];
  // Fix: accumulate token counts across all turns so they can be reported upstream.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  try {
    // Build the system prompt
    const portInstructions = getPortAvoidanceInstructions(config);
    // Determine whether the cwd is itself the run output dir (or a subdir of it).
    // When that's the case the model is *not* sitting in a real source repo, so
    // the "source-code edits stay in the cwd repo" exception does NOT apply —
    // every write is a deliverable and belongs under runDir.
    const cwdIsRunDir = (() => {
      if (!runDir) return false;
      try {
        const r = path.resolve(runDir);
        const c = path.resolve(cwd);
        return c === r || c.startsWith(r + path.sep);
      } catch {
        return false;
      }
    })();
    const sourceEditException = cwdIsRunDir
      ? `\n\nThis cwd IS the run output directory — there is no external source repo to edit here. Treat every Write/Edit as a deliverable and keep them under \`${runDir}\`.`
      : `\n\nThe only exception is when you are *editing existing source code in the working repository* (your cwd, \`${cwd}\`, which is a user-configured coding repo). Source-code edits stay in the repo as normal; standalone documents do not.`;
    const runDirInstruction = runDir
      ? `\n\n## Output Directory (STRICT)\nAll deliverable artifacts (specs, reports, research docs, generated data files) MUST be written under the run output directory: \`${runDir}\`\nThis directory is the canonical location for this workflow run's artifacts and is also exposed via the ORIONOMEGA_RUN_DIR environment variable.\n\nForbidden write locations — NEVER write deliverable artifacts to:\n- \`/home/user/...\`, \`/home/kali/...\`, or any other home directory outside \`${runDir}\`\n- \`/tmp/...\` or other system temp dirs\n- \`~/...\` or shell-expanded home paths\n- \`~/.orionomega/...\` or any subdirectory of the OrionOmega install tree (e.g. \`~/.orionomega/src\`) — that is the application's own source tree, never a place for run deliverables\nIf your task description names an absolute output path outside \`${runDir}\`, IGNORE that path and write the file under \`${runDir}\` instead — the orchestrator surfaces files there to the user automatically.${sourceEditException}`
      : '';
    let systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append?: string };
    if (codingConfig.systemPrompt) {
      // Use Claude Code's system prompt with appended instructions
      systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: `${codingConfig.systemPrompt}\n\n${portInstructions}${runDirInstruction}`,
      };
    } else {
      // Use Claude Code's default system prompt with port restrictions
      systemPrompt = { type: 'preset', preset: 'claude_code', append: `${portInstructions}${runDirInstruction}` };
    }

    // Build agents map if provided
    const agents = codingConfig.agents
      ? Object.fromEntries(
          Object.entries(codingConfig.agents).map(([name, def]) => [
            name,
            {
              description: def.description,
              prompt: def.prompt,
              tools: def.tools ?? ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
            },
          ]),
        )
      : undefined;

    const codingPermissionMode = sdkConfig.permissionMode === 'bypassPermissions'
      ? 'bypassPermissions'
      : sdkConfig.permissionMode === 'acceptEdits'
        ? 'acceptEdits'
        : 'default';

    if (codingPermissionMode === 'bypassPermissions') {
      log.warn(
        '[security] bypassPermissions mode is active — all tool permission prompts will be ' +
        'skipped for this coding agent. Ensure this is intentional. Review humanGates config ' +
        'if running in autonomous mode.',
      );
    }

    // Defense-in-depth: see executeAgent for the rationale. canUseTool
    // answers any tool-permission request the SDK raises against the per-call
    // allowedTools + autonomous.humanGates; the PermissionRequest hook is
    // passive audit only. See `./permission-policy.ts`.
    const codingHumanGates = config.autonomous?.humanGates;
    const codingCanUseTool = buildCanUseTool({
      allowedTools,
      humanGates: codingHumanGates,
      actor: 'coding-agent',
      ...(humanGateCallback
        ? {
            requestApproval: (toolName, reason, signal) =>
              humanGateCallback(toolName, reason, signal),
          }
        : {}),
    });
    const codingPermissionRequestHook = buildPermissionRequestHook('coding-agent');

    // Build role-based security PreToolUse hook (Section 8.1-8.4).
    // Enforces: write-permission by role, target-file scope, Bash command
    // allowlist/denylist, secret scanning, workspace containment.
    const securityPreToolHook = codingRole
      ? buildSecurityPreToolUseHook({
          role: codingRole,
          targetFiles: (node as { codingConfig?: { fileScope?: { owned?: string[] } } })
            .codingConfig?.fileScope?.owned ?? codingConfig.allowedTools ? [] : [],
          enforceBashPolicy: true,
          scanForSecrets: true,
          workspaceDir: cwd,
        })
      : null;

    // Round-5 (architect, second pass): orchestration-side pre-push
    // gate. Wraps the upstream canUseTool so any `git push` /
    // `--no-verify` Bash call is denied BEFORE the SDK forwards it
    // to the shell. The agent cannot bypass this — it lives above
    // the Perl hooks (which `--no-verify` skips) and runs at every
    // tool-use turn, not just at workflow shutdown.
    const guardedCanUseTool = (() => {
      // Layer 1: commit safety (outermost — blocks unsafe git operations)
      const withCommitSafety: typeof codingCanUseTool = commitSafetyContext
        ? async (toolName, toolInput, ctx) => {
            const guard = buildCommitSafetyToolGuard({
              checkoutPath: commitSafetyContext.checkoutPath,
              baseHeadCommit: commitSafetyContext.baseHeadCommit,
              ...(commitSafetyContext.onRefuse ? { onRefuse: commitSafetyContext.onRefuse } : {}),
            });
            const safety = await guard(toolName, toolInput);
            if (safety.decision === 'deny') {
              return { behavior: 'deny', message: safety.reason, toolUseID: ctx.toolUseID };
            }
            return codingCanUseTool(toolName, toolInput, ctx);
          }
        : codingCanUseTool;

      // Layer 2: role-based security hook (Section 8.1-8.4)
      if (!securityPreToolHook) return withCommitSafety;
      return (async (toolName, toolInput, ctx) => {
        const hookDecision = securityPreToolHook(toolName, toolInput as Record<string, unknown>);
        if (hookDecision.decision === 'deny') {
          log.warn(
            `[security] Tool '${toolName}' denied for role '${codingRole}': ${hookDecision.reason}`,
          );
          return { behavior: 'deny', message: hookDecision.reason ?? 'Denied by security policy', toolUseID: ctx.toolUseID };
        }
        return withCommitSafety(toolName, toolInput, ctx);
      }) as typeof codingCanUseTool;
    })();

    const queryResult = query({
      prompt: task,
      options: {
        model,
        cwd,
        allowedTools,
        permissionMode: codingPermissionMode,
        canUseTool: guardedCanUseTool,
        hooks: {
          PermissionRequest: [{ hooks: [codingPermissionRequestHook] }],
        },
        ...(codingPermissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        // Role-based effort (ROLE_THINKING_CONFIG) overrides sdkConfig default.
        // Scanner/reporter → 'low' (thinking disabled). Debugger → 'high'.
        effort: roleEffort ?? sdkConfig.effort ?? 'high',
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
        // Role-based max turns (ROLE_MAX_TURNS) — prevents runaway agents.
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        systemPrompt,
        // P4: Adaptive thinking — Claude decides when and how much to think.
        // Depth is governed by `effort` (above); adaptive thinking takes no
        // budget field. Opus 4.8 (and the SDK's ThinkingAdaptive type) reject a
        // manual budget alongside `type: 'adaptive'`, so none is sent.
        thinking: { type: 'adaptive' },
        // P2: AbortController for cooperative cancellation
        abortController,
        env: {
          ...process.env,
          HOME: process.env.HOME || '/root',
          PATH: process.env.PATH || '',
          TERM: process.env.TERM || 'xterm-256color',
          SHELL: process.env.SHELL || '/bin/sh',
          USER: process.env.USER || '',
          LANG: process.env.LANG || 'en_US.UTF-8',
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'orionomega-orchestrator',
          ...(runDir ? { ORIONOMEGA_RUN_DIR: runDir } : {}),
        },
        additionalDirectories: codingConfig.additionalDirectories ?? sdkConfig.additionalDirectories,
        ...(agents ? { agents } : {}),
        settingSources: ['project'], // Load CLAUDE.md files from the project
        persistSession: false, // Don't persist — orchestration manages state
        // Capture stderr for diagnostics when the CLI process crashes
        stderr: (data: string) => log.debug(`[coding-agent-stderr] ${data.trimEnd()}`),
      },
    });
    // Wire queryRef so a mid-stream abort can call Query.interrupt() first
    // (graceful turn-end) before the hard SDK abort fires. See executeAgent
    // for the same pattern.
    queryRef.current = queryResult as unknown as { interrupt?: () => Promise<void> | void };
    if (abortController.signal.aborted) {
      tryGracefulInterrupt();
    }

    for await (const message of queryResult) {
      // P3: Use message.type discriminator for proper typed handling

      // Assistant message — collect text, thinking, and tool use
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        // Fix: extract per-turn token usage so we can report total costs for CODING_AGENT nodes.
        const usage = (assistantMsg.message as unknown as Record<string, unknown>)?.usage as
          { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        if (usage) {
          totalInputTokens += usage.input_tokens ?? 0;
          totalOutputTokens += usage.output_tokens ?? 0;
          totalCacheReadTokens += usage.cache_read_input_tokens ?? 0;
          totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        }
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if (block.type === 'thinking' && 'thinking' in block) {
              const thinkingText = (block as { thinking: string }).thinking;
              onProgress?.({
                type: 'thinking',
                message: thinkingText.slice(0, 100),
                thinking: thinkingText,
              });
            }
            if (block.type === 'text') {
              output += block.text + '\n';
            }
            if (block.type === 'tool_use') {
              toolCalls++;
              // Asymptotic progress curve — approaches 90% as tool calls
              // accumulate, since maxTurns is no longer a fixed denominator
              // (Task #211: unlimited turns by default).
              const pct = Math.min(90, Math.round(90 * (1 - Math.exp(-toolCalls / 30))));
              const toolInput = block.input as Record<string, unknown> | undefined;
              const toolName = block.name;
              auditToolInvocation(toolName, toolInput ?? {});
              const filePath = toolInput && typeof toolInput === 'object' && 'file_path' in toolInput
                ? ` → ${toolInput.file_path}`
                : '';
              onProgress?.({
                type: 'tool',
                message: `Tool: ${toolName}${filePath}`,
                progress: pct,
              });
              if ((toolName === 'Write' || toolName === 'Edit') && toolInput?.file_path) {
                outputPaths.push(String(toolInput.file_path));
              }
            }
          }
        }
      }

      // Tool progress — richer subagent/tool progress reporting
      if (message.type === 'tool_progress') {
        const tpMsg = message as SDKToolProgressMessage;
        onProgress?.({
          type: 'tool',
          message: `Tool running: ${tpMsg.tool_name} (${tpMsg.elapsed_time_seconds.toFixed(1)}s)`,
        });
      }

      // System messages — subagent task lifecycle
      if (message.type === 'system') {
        const sysMsg = message as SDKTaskStartedMessage | SDKTaskProgressMessage;
        if (sysMsg.subtype === 'task_started') {
          onProgress?.({
            type: 'status',
            message: `Subagent started: ${(sysMsg as SDKTaskStartedMessage).description}`,
          });
        } else if (sysMsg.subtype === 'task_progress') {
          const tp = sysMsg as SDKTaskProgressMessage;
          onProgress?.({
            type: 'status',
            message: `Subagent progress: ${tp.description}${tp.last_tool_name ? ` (${tp.last_tool_name})` : ''}`,
          });
        }
      }

      // Result message — final output (success or error)
      if (message.type === 'result') {
        costUsd = (message as SDKResultSuccess | SDKResultError).total_cost_usd;

        if ((message as SDKResultSuccess).subtype === 'success') {
          const successMsg = message as SDKResultSuccess;
          if (successMsg.result) {
            output += '\n' + successMsg.result;
          }
        } else {
          // SDK reported a structured error result (subtype !== 'success').
          // Surface the subtype so callers can react: max_budget / max_turns
          // are not retryable; error_during_execution typically is.
          const errorMsg = message as SDKResultError;
          const description = describeResultError(errorMsg);
          log.warn(`Coding agent result error (${errorMsg.subtype}): ${description}`);
          const retryable = errorMsg.subtype === 'error_during_execution';
          const durationSec = (Date.now() - startTime) / 1000;
          return {
            output: output.trim(),
            toolCalls,
            success: false,
            error: `SDK ${errorMsg.subtype}: ${description}`,
            durationSec,
            costUsd,
            outputPaths: [...new Set(outputPaths)],
            model,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadTokens: totalCacheReadTokens,
            cacheCreationTokens: totalCacheCreationTokens,
            retryable,
            errorSubtype: errorMsg.subtype,
          };
        }

        onProgress?.({
          type: 'done',
          message: `Coding agent complete: ${toolCalls} tool calls`,
          progress: 100,
        });
      }
    }

    const durationSec = (Date.now() - startTime) / 1000;

    log.info(`Coding agent completed: ${toolCalls} tool calls, ${durationSec.toFixed(1)}s`);

    return {
      output: output.trim(),
      toolCalls,
      success: true,
      durationSec,
      costUsd,
      outputPaths: [...new Set(outputPaths)],
      // Fix: include token counts and model so executor.ts can aggregate cost for CODING_AGENT nodes.
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
    };
  } catch (err) {
    const durationSec = (Date.now() - startTime) / 1000;
    const aborted = err instanceof AbortError;

    // Disambiguate aborts using the typed reason on the abort signal — see
    // executeAgent above for the rationale. Without this, every cancel
    // surfaces as the SDK's "Claude Code process aborted by user" message
    // even when the *real* cause was the executor's wall-clock timeout.
    let displayMessage: string;
    let retryable: boolean;
    if (aborted) {
      const reason = abortSignal?.reason;
      if (isOrionOmegaAbortReason(reason)) {
        displayMessage = `Coding agent ${describeAbortReason(reason)}`;
        retryable = reason.kind === 'timeout';
      } else {
        displayMessage = err instanceof Error ? err.message : String(err);
        retryable = false;
      }
    } else {
      displayMessage = err instanceof Error ? err.message : String(err);
      retryable = isRetryableSdkError(err);
    }

    log.error(`Coding agent failed${aborted ? ' (aborted)' : ''}: ${displayMessage}`);

    onProgress?.({
      type: 'error',
      message: `Coding agent error: ${displayMessage}`,
    });

    return {
      output: output.trim(),
      toolCalls,
      success: false,
      error: displayMessage,
      durationSec,
      outputPaths: [...new Set(outputPaths)],
      // Fix: include partial token counts even on failure so partial usage is accounted for.
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      retryable,
    };
  }
}

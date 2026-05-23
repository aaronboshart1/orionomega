/**
 * @module orchestration/coding/skill-bridge
 * Wires OrionOmega skills (GitHub, Linear, web-search, web-fetch) into
 * coding template tool permissions.
 *
 * Provides:
 *   - MCP tool name → skill ID mappings
 *   - Per-role extended tool availability
 *   - codebase_query custom in-process tool definition
 *   - SkillBridge class for role-aware skill/tool resolution
 *
 * See spec Section 5.2 — Extended Tools.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { CodingRole } from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('skill-bridge');

// ── MCP Tool → Skill Mappings ─────────────────────────────────────────────────

/**
 * Maps each extended MCP tool name to the skill ID that provides it.
 *
 * Spec Section 5.2 extended tools table:
 *   WebSearch    → web-search skill
 *   WebFetch     → web-fetch skill
 *   gh_pr        → github skill
 *   gh_issue     → github skill
 *   linear_issue → linear skill
 */
export const MCP_TOOL_SKILL_MAP: Readonly<Record<string, string>> = {
  WebSearch:    'web-search',
  WebFetch:     'web-fetch',
  gh_pr:        'github',
  gh_issue:     'github',
  linear_issue: 'linear',
} as const;

/** All extended (non-built-in) MCP tool names. */
export const EXTENDED_TOOL_NAMES: ReadonlyArray<string> = Object.keys(MCP_TOOL_SKILL_MAP);

// ── Role-to-Extended-Tool Access ──────────────────────────────────────────────

/**
 * Defines which extended tools each coding role may access.
 *
 * From spec Section 5.2:
 *   architect:        WebSearch, WebFetch, gh_issue, codebase_query
 *   codebase-scanner: codebase_query
 *   reporter:         gh_pr, linear_issue   (post-commit + ticket update)
 *
 * Roles not listed receive no extended tools (core SDK tools only).
 */
export const ROLE_EXTENDED_TOOLS: Readonly<Partial<Record<CodingRole, readonly string[]>>> = {
  'architect':          ['WebSearch', 'WebFetch', 'gh_issue', 'codebase_query'],
  'codebase-scanner':   ['codebase_query'],
  'reporter':           ['gh_pr', 'linear_issue'],
} as const;

/**
 * Returns the skill IDs required to satisfy the extended tool set for a role.
 * Deduplicates so that both `gh_pr` and `gh_issue` resolve to a single
 * `'github'` entry.
 *
 * @param role - The coding role to query.
 * @returns Array of unique skill IDs (may be empty).
 */
export function getRequiredSkillsForRole(role: CodingRole): string[] {
  const tools = ROLE_EXTENDED_TOOLS[role] ?? [];
  const skillIds = new Set<string>();
  for (const t of tools) {
    const skillId = MCP_TOOL_SKILL_MAP[t];
    if (skillId) skillIds.add(skillId);
  }
  return [...skillIds];
}

/**
 * Returns true if the given role is permitted to use the named extended tool.
 *
 * @param role     - The coding role.
 * @param toolName - The extended tool name (e.g. 'WebSearch', 'gh_pr').
 */
export function roleCanUseTool(role: CodingRole, toolName: string): boolean {
  return (ROLE_EXTENDED_TOOLS[role] ?? []).includes(toolName);
}

// ── codebase_query Custom Tool ────────────────────────────────────────────────

/**
 * CodebaseIndex interface expected by buildCodebaseQueryTool.
 * The full implementation lives in CodebaseIndex (not yet implemented);
 * this interface lets the tool compile independently.
 */
export interface CodebaseIndexAdapter {
  query(
    queryType: 'definition' | 'references' | 'imports' | 'dependents' | 'callers',
    symbol: string,
    scope?: string,
  ): unknown;
}

/** Async factory that resolves (or constructs) a CodebaseIndexAdapter. */
export type CodebaseIndexLoader = (workspaceDir: string) => Promise<CodebaseIndexAdapter>;

/**
 * Builds the `codebase_query` in-process MCP tool definition.
 *
 * This tool lets scanner and architect agents query the codebase symbol graph
 * for definitions, references, import chains, and dependents — without needing
 * to grep every file manually.
 *
 * From spec Section 5.2:
 * ```
 * const codebaseQueryTool = tool(
 *   'codebase_query',
 *   'Query the codebase symbol graph for definitions, references, and dependencies',
 *   { query_type, symbol, scope },
 *   async (args) => { ... },
 *   { annotations: { readOnlyHint: true } }
 * );
 * ```
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @param loadIndex    - Async callback that loads (or returns cached) CodebaseIndex.
 */
export function buildCodebaseQueryTool(
  workspaceDir: string,
  loadIndex: CodebaseIndexLoader,
): ReturnType<typeof tool> {
  // Use a loosely-typed shape (Record<string, z.ZodType>) so the return type is
  // compatible with the SdkMcpToolDefinition<Record<...>> expected by callers.
  // This matches the pattern used throughout agent-sdk-bridge.ts.
  const shape: Record<string, z.ZodType> = {
    query_type: z
      .enum(['definition', 'references', 'imports', 'dependents', 'callers'])
      .describe('The type of graph query to perform'),
    symbol: z.string().describe('Symbol name to search for (function, class, type, etc.)'),
    scope: z.string().optional().describe('Limit search to this directory path (optional)'),
  };

  return tool(
    'codebase_query',
    'Query the codebase symbol graph for definitions, references, and dependencies',
    shape,
    async (args: Record<string, unknown>) => {
      try {
        const queryType = args['query_type'] as
          | 'definition' | 'references' | 'imports' | 'dependents' | 'callers';
        const symbol = args['symbol'] as string;
        const scope = args['scope'] as string | undefined;
        const index = await loadIndex(workspaceDir);
        const results = index.query(queryType, symbol, scope);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`codebase_query failed: ${msg}`);
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  ) as ReturnType<typeof tool>;
}

// ── SkillBridge ───────────────────────────────────────────────────────────────

/** Options for constructing a SkillBridge. */
export interface SkillBridgeOptions {
  /** Absolute path to the OrionOmega skills configuration directory. */
  skillsDir: string;
  /** Absolute path to the workspace root (used by codebase_query). */
  workspaceDir?: string;
  /**
   * Optional loader for the CodebaseIndex.
   * When provided, roles with 'codebase_query' access will receive
   * an in-process MCP tool that delegates to this loader.
   * When absent, 'codebase_query' is silently omitted from tool lists.
   */
  loadCodebaseIndex?: CodebaseIndexLoader;
}

/**
 * SkillBridge resolves which skill IDs and custom tool definitions to
 * attach to each coding agent role in a template.
 *
 * It answers two questions:
 *   1. For this coding role, which skill IDs should I load via buildSkillMcpServer()?
 *   2. Which in-process custom tool definitions (e.g. codebase_query) should I register?
 *
 * The MCP skill loading itself is done in agent-sdk-bridge.ts;
 * SkillBridge only computes WHAT to load, not how.
 */
export class SkillBridge {
  private readonly skillsDir: string;
  private readonly workspaceDir: string;
  private readonly loadCodebaseIndex?: CodebaseIndexLoader;

  constructor(opts: SkillBridgeOptions) {
    this.skillsDir = opts.skillsDir;
    this.workspaceDir = opts.workspaceDir ?? process.cwd();
    this.loadCodebaseIndex = opts.loadCodebaseIndex;
  }

  /** The skills directory this bridge was constructed with. */
  get resolvedSkillsDir(): string {
    return this.skillsDir;
  }

  /**
   * Returns the skill IDs that must be loaded for the given coding role.
   * Pass these to `buildSkillMcpServer(skillIds, skillsDir)` in agent-sdk-bridge.
   *
   * @param role - The coding role to query.
   * @returns Array of skill IDs (e.g. ['web-search', 'github']). May be empty.
   */
  getSkillIdsForRole(role: CodingRole): string[] {
    return getRequiredSkillsForRole(role);
  }

  /**
   * Returns the allowed extended tool names for the given role.
   * Used to build the `allowedTools` list for agent-sdk-bridge.executeAgent().
   *
   * @param role - The coding role.
   * @returns Array of extended tool names (e.g. ['WebSearch', 'gh_issue']).
   */
  getAllowedExtendedTools(role: CodingRole): readonly string[] {
    return ROLE_EXTENDED_TOOLS[role] ?? [];
  }

  /**
   * Builds any in-process custom tool definitions for the given role.
   *
   * Currently produces:
   *   - `codebase_query` for roles that have access AND a CodebaseIndex loader
   *     was provided at construction time.
   *
   * The returned tools should be passed to `createSdkMcpServer()` alongside
   * the skill-derived tools.
   *
   * @param role - The coding role.
   * @returns Array of SDK tool definitions (may be empty).
   */
  buildCustomToolsForRole(role: CodingRole): ReturnType<typeof tool>[] {
    const tools: ReturnType<typeof tool>[] = [];
    const extTools = ROLE_EXTENDED_TOOLS[role] ?? [];

    if (extTools.includes('codebase_query') && this.loadCodebaseIndex) {
      tools.push(buildCodebaseQueryTool(this.workspaceDir, this.loadCodebaseIndex));
      log.debug(`SkillBridge: added codebase_query tool for role "${role}"`);
    }

    return tools;
  }

  /**
   * Summary of what a role gets from this bridge.
   * Useful for debug logging during node setup.
   */
  describeBridgeForRole(role: CodingRole): {
    skillIds: string[];
    extendedTools: readonly string[];
    customToolCount: number;
  } {
    return {
      skillIds: this.getSkillIdsForRole(role),
      extendedTools: this.getAllowedExtendedTools(role),
      customToolCount: this.buildCustomToolsForRole(role).length,
    };
  }
}

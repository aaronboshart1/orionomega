/**
 * @module interfaces
 * Core skill interface, abstract base class, and defineSkill() factory for OrionOmega skills.
 *
 * Skill authors who want TypeScript-native skills can:
 * - Call {@link defineSkill} (recommended) for a functional, boilerplate-free API
 * - Implement {@link ISkill} directly
 * - Extend {@link BaseSkill} for sensible lifecycle defaults
 *
 * Language-agnostic skills (Bash, Python, Go, etc.) do not need to use these
 * interfaces — they interact with the runtime through stdin/stdout JSON and
 * the lifecycle hook scripts declared in `manifest.json`.
 */

import type { SkillTool, HealthStatus, SkillContext } from './types.js';

// ── Core Interface ─────────────────────────────────────────────────────

/**
 * Core contract that every TypeScript-native skill must satisfy.
 *
 * Lifecycle order:
 * ```
 * initialize(ctx) → activate() → [tool calls] → deactivate() → dispose()
 * ```
 *
 * A skill that has been `deactivate()`-d may be `activate()`-d again.
 * A skill that has been `dispose()`-d must not be used again.
 */
export interface ISkill {
  initialize(ctx: SkillContext): Promise<void>;
  activate(): Promise<void>;
  deactivate(): Promise<void>;
  dispose(): Promise<void>;
  getTools(): SkillTool[];
  getHealth(): Promise<HealthStatus>;
}

// ── Abstract Base Class ────────────────────────────────────────────────

/**
 * Abstract base class providing sensible defaults for the {@link ISkill} lifecycle.
 *
 * Skill authors only need to override the methods relevant to their skill.
 * At minimum, {@link getTools} must be implemented.
 */
export abstract class BaseSkill implements ISkill {
  protected initialized = false;
  protected active = false;
  protected ctx!: SkillContext;

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.initialized = true;
    this.ctx.logger.debug(`[${this.constructor.name}] initialized`);
  }

  async activate(): Promise<void> {
    this.active = true;
    this.ctx?.logger.debug(`[${this.constructor.name}] activated`);
  }

  async deactivate(): Promise<void> {
    this.active = false;
    this.ctx?.logger.debug(`[${this.constructor.name}] deactivated`);
  }

  async dispose(): Promise<void> {
    this.active = false;
    this.initialized = false;
    this.ctx?.logger.debug(`[${this.constructor.name}] disposed`);
  }

  abstract getTools(): SkillTool[];

  async getHealth(): Promise<HealthStatus> {
    if (!this.initialized) {
      return {
        healthy: false,
        message: 'Skill has not been initialized.',
        code: 'UNKNOWN',
        retryable: false,
      };
    }

    if (!this.active) {
      return {
        healthy: false,
        message: 'Skill is not active.',
        code: 'UNKNOWN',
        retryable: false,
      };
    }

    return {
      healthy: true,
      message: 'OK',
    };
  }
}

// ── defineSkill factory ────────────────────────────────────────────────

/**
 * Functional definition for a TypeScript-native skill.
 * Pass to {@link defineSkill} to create a skill class without boilerplate.
 */
export interface SkillDefinition {
  /**
   * Called inside initialize() after super.initialize(ctx).
   * Use to validate settings, inject env vars, and open connections.
   * Throwing here causes the skill to fail initialization.
   */
  setup?: (ctx: SkillContext) => Promise<void>;

  /**
   * Called by getHealth() when the skill is initialized and active.
   * Return a HealthStatus object.
   * If omitted, falls back to BaseSkill.getHealth() (checks flags only).
   */
  healthCheck?: (ctx: SkillContext) => Promise<HealthStatus>;

  /**
   * Tools this skill exposes. Mirrors the manifest tools array.
   * The manifest is the canonical source for tool registration in the loader;
   * this array is used when the skill class needs to override getTools().
   * Defaults to [] if omitted.
   */
  tools?: SkillTool[];
}

/**
 * Factory that creates a concrete skill class from a SkillDefinition.
 *
 * This is the recommended way to author TypeScript-native skills. It eliminates
 * the boilerplate of extending BaseSkill manually while preserving full type
 * safety and lifecycle control.
 *
 * @example
 * ```typescript
 * import { defineSkill } from '@orionomega/skills-sdk';
 *
 * export default defineSkill({
 *   async setup(ctx) {
 *     if (ctx.secrets.api_key) {
 *       process.env.MY_API_KEY = ctx.secrets.api_key;
 *     }
 *   },
 *   async healthCheck(ctx) {
 *     const res = await fetch('https://api.example.com/ping');
 *     return res.ok
 *       ? { healthy: true, message: 'API reachable' }
 *       : { healthy: false, message: 'API unreachable', code: 'NETWORK_ERROR', retryable: true };
 *   },
 *   tools: [
 *     {
 *       name: 'my_tool',
 *       description: 'Does something useful',
 *       handler: 'handlers/my_tool.js',
 *       timeout: 30_000,
 *       inputSchema: {
 *         type: 'object',
 *         properties: { query: { type: 'string', description: 'Input query' } },
 *         required: ['query'],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @param definition - Skill lifecycle callbacks and tool definitions.
 * @returns A concrete class constructor compatible with the skill loader.
 */
export function defineSkill(definition: SkillDefinition): new () => ISkill {
  const { setup, healthCheck, tools = [] } = definition;

  class DefinedSkill extends BaseSkill {
    override async initialize(ctx: SkillContext): Promise<void> {
      await super.initialize(ctx);
      await setup?.(ctx);
    }

    override async getHealth(): Promise<HealthStatus> {
      const base = await super.getHealth();
      if (!base.healthy) return base;
      if (healthCheck) return healthCheck(this.ctx);
      return base;
    }

    getTools(): SkillTool[] {
      return tools;
    }
  }

  return DefinedSkill;
}

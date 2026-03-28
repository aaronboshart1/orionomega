/**
 * @module interfaces
 * Core skill interface and abstract base class for OrionOmega skills.
 *
 * Skill authors who want TypeScript-native skills can implement {@link ISkill}
 * directly or extend {@link BaseSkill} for sensible lifecycle defaults.
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

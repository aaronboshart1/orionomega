/**
 * @module memory/session-bootstrap
 * Loads context from Hindsight at session start to prime the system prompt.
 */

import { HindsightClient } from './client.js';
import { createLogger } from './logger.js';

const log = createLogger('session-bootstrap');

/** Context loaded from Hindsight during session bootstrap. */
export interface BootstrapContext {
  /** Synthesized user profile from preferences and patterns. */
  userProfile: string;
  /** Recent session context summary. */
  sessionContext: string;
  /** Recalled project-specific memories (if a project bank is active). */
  projectMemories: string;
  /** Infrastructure topology and service map. */
  infraContext: string;
}

/**
 * Loads relevant context from Hindsight at the start of a session.
 *
 * Mental models may not exist yet — the system builds up over time.
 * All failures are caught and logged; missing data returns empty strings.
 */
export class SessionBootstrap {
  constructor(private readonly hs: HindsightClient) {}

  /**
   * Load all relevant context from Hindsight.
   *
   * @param projectBank - Optional project bank ID to recall project-specific memories.
   * @returns Populated bootstrap context (empty strings for unavailable data).
   */
  async bootstrap(projectBank?: string): Promise<BootstrapContext> {
    const [userProfile, sessionContext, infraContext, projectMemories] =
      await Promise.all([
        this.getMentalModel('core', 'user-profile'),
        this.getMentalModel('core', 'session-context'),
        this.getMentalModel('infra', 'infra-map'),
        projectBank ? this.recallProjectMemories(projectBank) : Promise.resolve(''),
      ]);

    log.debug('Bootstrap complete', {
      hasUserProfile: userProfile.length > 0,
      hasSessionContext: sessionContext.length > 0,
      hasInfraContext: infraContext.length > 0,
      hasProjectMemories: projectMemories.length > 0,
    });

    return { userProfile, sessionContext, projectMemories, infraContext };
  }

  /**
   * Build a system prompt addition from the bootstrap context.
   *
   * Non-empty sections are formatted with markdown headers and concatenated.
   *
   * @param ctx - The bootstrap context to format.
   * @returns A string to append to the system prompt (may be empty).
   */
  buildContextBlock(ctx: BootstrapContext): string {
    const sections: string[] = [];

    if (ctx.userProfile) {
      sections.push(`## User Profile\n${ctx.userProfile}`);
    }
    if (ctx.sessionContext) {
      sections.push(`## Recent Session Context\n${ctx.sessionContext}`);
    }
    if (ctx.projectMemories) {
      sections.push(`## Project Memories\n${ctx.projectMemories}`);
    }
    if (ctx.infraContext) {
      sections.push(`## Infrastructure\n${ctx.infraContext}`);
    }

    if (sections.length === 0) return '';

    return `\n\n# Memory Context (from Hindsight)\n\n${sections.join('\n\n')}`;
  }

  /**
   * Safely retrieves a mental model's content.
   * Returns empty string on any failure (404, network error, etc.).
   */
  private async getMentalModel(bankId: string, modelId: string): Promise<string> {
    try {
      const model = await this.hs.getMentalModel(bankId, modelId);
      return model.content ?? '';
    } catch {
      log.debug('Mental model not available', { bankId, modelId });
      return '';
    }
  }

  /**
   * Recalls project-specific memories using a broad context query.
   */
  private async recallProjectMemories(bankId: string): Promise<string> {
    try {
      const result = await this.hs.recall(
        bankId,
        'recent context, active work, key decisions',
        { maxTokens: 4096, budget: 'mid' },
      );
      return result.results
        .map((m) => `[${m.context}] ${m.content}`)
        .join('\n');
    } catch {
      log.debug('Project memories not available', { bankId });
      return '';
    }
  }
}

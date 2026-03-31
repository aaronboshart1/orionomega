/**
 * @module memory/session-bootstrap
 * Loads context from Hindsight at session start to prime the system prompt.
 * Supports session anchors for seamless handoff between sessions.
 */

import { HindsightClient } from './client.js';
import { createLogger } from './logger.js';

const log = createLogger('session-bootstrap');

/** Data captured at session end for seamless handoff. */
export interface SessionAnchor {
  activeProject?: string;
  lastUserRequest?: string;
  pendingDecisions: string[];
  unfinishedWork: string[];
  summary: string;
  timestamp: string;
}

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
  /** Most recent session anchor for continuity. */
  sessionAnchor: string;
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
    const [userProfile, sessionContext, infraContext, projectMemories, recentSessions, sessionAnchor] =
      await Promise.all([
        this.getMentalModel('core', 'user-profile'),
        this.getMentalModel('core', 'session-context'),
        this.getMentalModel('infra', 'infra-map'),
        projectBank ? this.recallProjectMemories(projectBank) : Promise.resolve(''),
        this.recallCoreMemories(),
        this.recallSessionAnchor(),
      ]);

    const effectiveSessionContext = sessionContext || recentSessions;

    log.debug('Bootstrap complete', {
      hasUserProfile: userProfile.length > 0,
      hasSessionContext: effectiveSessionContext.length > 0,
      usedSessionFallback: !sessionContext && recentSessions.length > 0,
      hasInfraContext: infraContext.length > 0,
      hasProjectMemories: projectMemories.length > 0,
      hasSessionAnchor: sessionAnchor.length > 0,
    });

    return { userProfile, sessionContext: effectiveSessionContext, projectMemories, infraContext, sessionAnchor };
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

    if (ctx.sessionAnchor) {
      sections.push(`## Where We Left Off\n${ctx.sessionAnchor}`);
    }
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

  async storeSessionAnchor(anchor: SessionAnchor): Promise<void> {
    try {
      const parts: string[] = [
        `[Session Anchor — ${anchor.timestamp}]`,
        anchor.summary,
      ];
      if (anchor.activeProject) {
        parts.push(`Active project: ${anchor.activeProject}`);
      }
      if (anchor.lastUserRequest) {
        parts.push(`Last user request: ${anchor.lastUserRequest}`);
      }
      if (anchor.pendingDecisions.length > 0) {
        parts.push(`Pending decisions:\n${anchor.pendingDecisions.map(d => `  - ${d}`).join('\n')}`);
      }
      if (anchor.unfinishedWork.length > 0) {
        parts.push(`Unfinished work:\n${anchor.unfinishedWork.map(w => `  - ${w}`).join('\n')}`);
      }

      const content = parts.join('\n');
      await this.hs.retainOne('core', content, 'session_anchor');
      log.info('Session anchor stored', {
        hasProject: !!anchor.activeProject,
        pendingDecisions: anchor.pendingDecisions.length,
        unfinishedWork: anchor.unfinishedWork.length,
      });
    } catch (err) {
      log.warn('Failed to store session anchor', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async safeRecall<T>(
    fn: () => Promise<T>,
    fallback: T,
    warnMessage: string,
    meta?: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      log.warn(warnMessage, { ...meta, error: err instanceof Error ? err.message : String(err) });
      return fallback;
    }
  }

  /**
   * Safely retrieves a mental model's content.
   * Returns empty string on any failure (404, network error, etc.).
   */
  private getMentalModel(bankId: string, modelId: string): Promise<string> {
    return this.safeRecall(
      async () => (await this.hs.getMentalModel(bankId, modelId)).content ?? '',
      '',
      'Mental model not available',
      { bankId, modelId },
    );
  }

  /**
   * Recalls recent session summaries from the core bank as a fallback
   * when the session-context mental model is not yet available.
   */
  private recallCoreMemories(): Promise<string> {
    return this.safeRecall(
      async () => {
        const result = await this.hs.recall(
          'core',
          'recent session summaries, what was accomplished, key decisions',
          { maxTokens: 2048, budget: 'mid' },
        );
        return result.results.map((m) => `[${m.context}] ${m.content}`).join('\n');
      },
      '',
      'Core bank recall not available',
    );
  }

  /**
   * Recalls project-specific memories using a broad context query.
   */
  private recallProjectMemories(bankId: string): Promise<string> {
    return this.safeRecall(
      async () => {
        const result = await this.hs.recall(
          bankId,
          'recent context, active work, key decisions',
          { maxTokens: 4096, budget: 'mid' },
        );
        return result.results.map((m) => `[${m.context}] ${m.content}`).join('\n');
      },
      '',
      'Project memories not available',
      { bankId },
    );
  }

  private recallSessionAnchor(): Promise<string> {
    return this.safeRecall(
      async () => {
        const result = await this.hs.recall(
          'core',
          'session anchor, where we left off, pending decisions, unfinished work',
          { maxTokens: 1024, budget: 'low', minRelevance: 0.2 },
        );
        const anchors = result.results.filter((m) =>
          m.context === 'session_anchor' || m.content.includes('[Session Anchor'),
        );
        if (anchors.length === 0) return '';
        anchors.sort((a, b) => {
          if (!a.timestamp && !b.timestamp) return 0;
          if (!a.timestamp) return 1;
          if (!b.timestamp) return -1;
          return b.timestamp.localeCompare(a.timestamp);
        });
        return anchors[0].content;
      },
      '',
      'Session anchor recall not available',
    );
  }
}

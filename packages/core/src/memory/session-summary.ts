/**
 * @module memory/session-summary
 * Generates and retains a concise summary when a session ends.
 */

import { HindsightClient } from '@orionomega/hindsight';
import { AnthropicClient } from '../anthropic/client.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('session-summary');

/** Minimum number of messages required to generate a summary. */
const MIN_MESSAGES = 5;

const SUMMARY_PROMPT = `Summarize this conversation in 2-4 sentences. Focus on:
- What was accomplished
- Key decisions made
- Next steps or open items

Be concise and factual. No preamble.`;

/**
 * Generates concise session summaries and retains them to Hindsight
 * for continuity across sessions.
 */
export class SessionSummarizer {
  constructor(
    private readonly hs: HindsightClient,
    private readonly anthropic: AnthropicClient,
    private readonly model: string,
  ) {}

  /**
   * Generate and retain a session summary from conversation messages.
   *
   * Skips summarization if there are fewer than 5 messages (not enough context).
   * Retains to the `'core'` bank with context `'session_summary'`, and optionally
   * to a project bank with context `'project_update'`.
   *
   * @param messages - The full conversation history.
   * @param projectBank - Optional project bank for additional retention.
   */
  async summarize(
    messages: { role: string; content: string }[],
    projectBank?: string,
  ): Promise<void> {
    if (messages.length < MIN_MESSAGES) {
      log.debug('Skipping summary — too few messages', { count: messages.length });
      return;
    }

    try {
      const conversationText = messages
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n\n');

      const response = await this.anthropic.createMessage({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: `${SUMMARY_PROMPT}\n\n---\n\n${conversationText}`,
          },
        ],
        maxTokens: 512,
        temperature: 0,
      });

      const summary = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();

      if (!summary) {
        log.warn('Empty summary generated');
        return;
      }

      // Retain to core bank
      await this.hs.retainOne('core', summary, 'session_summary');
      log.info('Session summary retained to core');

      // Retain to project bank if provided
      if (projectBank) {
        try {
          await this.hs.retainOne(projectBank, summary, 'project_update');
          log.info('Session summary retained to project bank', { projectBank });
        } catch (err) {
          log.warn('Failed to retain summary to project bank', {
            projectBank,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn('Session summary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * @module memory/session-summary
 * Generates and retains a concise summary when a session ends.
 *
 * F9:  Adds retry with exponential backoff for transient failures.
 * F14: Adds debounce (max 1 summary per DEBOUNCE_WINDOW_MS) to prevent
 *      rapid WS disconnect storms from generating excessive summaries.
 */

import { HindsightClient } from '@orionomega/hindsight';
import { AnthropicClient } from '../anthropic/client.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('session-summary');

/** Minimum number of messages required to generate a summary. */
const MIN_MESSAGES = 5;

/** F9: Retry configuration for transient failures. */
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

/** F14: Debounce window — max 1 summary per 5-minute window. */
const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000;

const SUMMARY_PROMPT = `Summarize this conversation in 2-4 sentences. Focus on:
- What was accomplished
- Key decisions made
- Next steps or open items

Be concise and factual. No preamble.`;

/**
 * Retry an async operation with exponential backoff.
 * Only retries on network/transient errors (status 0 or 5xx).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES,
  initialBackoff = INITIAL_BACKOFF_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Only retry on transient/network errors, not client errors (4xx)
      const status = (err as { statusCode?: number })?.statusCode ?? 0;
      if (status >= 400 && status < 500) throw err;

      if (attempt < maxRetries) {
        const delay = initialBackoff * Math.pow(2, attempt);
        log.warn(`${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`, {
          error: err instanceof Error ? err.message : String(err),
          attempt: attempt + 1,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Generates concise session summaries and retains them to Hindsight
 * for continuity across sessions.
 */
export class SessionSummarizer {
  /** F14: Timestamp of last successful summary for debounce. */
  private lastSummaryTime = 0;

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
   * F9:  Retries retain calls up to 3 times with exponential backoff.
   * F14: Skips if a summary was already generated within the debounce window.
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

    // F14: Debounce — skip if a summary was generated recently
    const now = Date.now();
    if (now - this.lastSummaryTime < DEBOUNCE_WINDOW_MS) {
      log.info('Skipping summary — debounce window active', {
        lastSummaryAgoMs: now - this.lastSummaryTime,
        windowMs: DEBOUNCE_WINDOW_MS,
      });
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

      // F9: Retain to core bank with retry
      await withRetry(
        () => this.hs.retainOne('core', summary, 'session_summary'),
        'Session summary retain (core)',
      );
      log.info('Session summary retained to core');

      // Retain to project bank if provided (also with retry)
      if (projectBank) {
        try {
          await withRetry(
            () => this.hs.retainOne(projectBank, summary, 'project_update'),
            `Session summary retain (${projectBank})`,
          );
          log.info('Session summary retained to project bank', { projectBank });
        } catch (err) {
          log.warn('Failed to retain summary to project bank', {
            projectBank,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // F14: Update debounce timestamp on success
      this.lastSummaryTime = Date.now();
    } catch (err) {
      log.warn('Session summary failed after retries', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

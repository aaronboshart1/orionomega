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

/**
 * C1: Maximum character budget for the assembled summary prompt.
 *
 * Haiku accepts up to ~200k input tokens; using a conservative 4 chars/token
 * ratio that's ~800k chars of headroom. We cap at 500k chars to keep room for
 * the system framing, response, and tokenization variance, so the request can
 * never blow past the model's input limit (which previously caused every
 * summary attempt to fail silently and let the conversation history grow
 * unbounded).
 */
const MAX_PROMPT_CHARS = 500_000;

/** Marker injected when older messages are dropped. */
const TRUNCATION_MARKER = '[earlier messages truncated]';

const SUMMARY_PROMPT = `Summarize this conversation in 2-4 sentences. Focus on:
- What was accomplished
- Key decisions made
- Next steps or open items

Be concise and factual. No preamble.`;

/**
 * C1: Build a conversation transcript that fits within `maxChars`.
 *
 * Renders messages from newest → oldest, stops once the budget would be
 * exceeded, and prepends a truncation marker if any messages were dropped.
 * Preserves the most recent messages because they carry the freshest context
 * and are most useful for the summary.
 */
function buildBoundedTranscript(
  messages: { role: string; content: string }[],
  maxChars: number,
): { text: string; truncated: boolean; keptCount: number } {
  const rendered: string[] = [];
  let total = 0;
  let kept = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const line = `[${m.role}]: ${m.content}`;
    // Account for the "\n\n" separator we will join with.
    const cost = line.length + (rendered.length > 0 ? 2 : 0);
    if (total + cost > maxChars) break;
    rendered.unshift(line);
    total += cost;
    kept++;
  }

  const truncated = kept < messages.length;
  const body = rendered.join('\n\n');
  const text = truncated ? `${TRUNCATION_MARKER}\n\n${body}` : body;
  return { text, truncated, keptCount: kept };
}

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

/** Snapshot of summarizer health for the structured /api/health response. */
export interface SummarizerStatus {
  /** 'ok' when the last summary attempt succeeded (or none has run yet). */
  status: 'ok' | 'degraded';
  /** Most recent error message, if the last attempt failed. */
  lastError: string | null;
  /** ISO timestamp of the last successful summary, or null if never. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the last failed summary, or null if never. */
  lastFailureAt: string | null;
  /** Total successful summaries completed in this process. */
  successCount: number;
  /** Total failed summaries in this process. */
  failureCount: number;
}

/**
 * Generates concise session summaries and retains them to Hindsight
 * for continuity across sessions.
 */
export class SessionSummarizer {
  /** F14: Timestamp of last successful summary for debounce. */
  private lastSummaryTime = 0;

  // Tracked for /api/health so operators can tell at a glance whether
  // summarisation has started failing without grepping logs.
  private _lastError: string | null = null;
  private _lastFailureAt = 0;
  private _successCount = 0;
  private _failureCount = 0;

  constructor(
    private readonly hs: HindsightClient,
    private readonly anthropic: AnthropicClient,
    private readonly model: string,
  ) {}

  /** Snapshot of summariser health for the gateway's /api/health endpoint. */
  getStatus(): SummarizerStatus {
    return {
      status: this._lastError && this._lastFailureAt > this.lastSummaryTime ? 'degraded' : 'ok',
      lastError: this._lastError,
      lastSuccessAt: this.lastSummaryTime > 0 ? new Date(this.lastSummaryTime).toISOString() : null,
      lastFailureAt: this._lastFailureAt > 0 ? new Date(this._lastFailureAt).toISOString() : null,
      successCount: this._successCount,
      failureCount: this._failureCount,
    };
  }

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
      // C1: Bound the transcript so the prompt cannot exceed the model's
      // input limit. Account for the surrounding framing (SUMMARY_PROMPT and
      // separators) when computing the budget.
      const framingOverhead = SUMMARY_PROMPT.length + '\n\n---\n\n'.length + 1024;
      const transcriptBudget = Math.max(1024, MAX_PROMPT_CHARS - framingOverhead);
      const { text: conversationText, truncated, keptCount } = buildBoundedTranscript(
        messages,
        transcriptBudget,
      );

      if (truncated) {
        log.warn('Session summary input truncated to fit model context', {
          totalMessages: messages.length,
          keptMessages: keptCount,
          droppedMessages: messages.length - keptCount,
          transcriptChars: conversationText.length,
          budgetChars: transcriptBudget,
        });
      }

      // C1/M1: Drop the deprecated `temperature` field — Claude 4+ models
      // reject it with a 400 error.
      const response = await this.anthropic.createMessage({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: `${SUMMARY_PROMPT}\n\n---\n\n${conversationText}`,
          },
        ],
        maxTokens: 512,
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
      this._successCount++;
      this._lastError = null;
    } catch (err) {
      this._failureCount++;
      this._lastFailureAt = Date.now();
      this._lastError = err instanceof Error ? err.message : String(err);
      log.warn('Session summary failed after retries', {
        error: this._lastError,
      });
    }
  }
}

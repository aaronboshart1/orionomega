/**
 * @module memory/compaction-flush
 * Extracts and retains important information from conversation messages
 * before context compaction discards them.
 */

import { HindsightClient, deduplicateByContent } from '@orionomega/hindsight';
import { AnthropicClient } from '../anthropic/client.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('compaction-flush');

/** Result of a compaction flush operation. */
export interface FlushResult {
  /** Number of items successfully retained to Hindsight. */
  itemsRetained: number;
}

/** Item extracted by the LLM during compaction flush. */
interface ExtractedItem {
  content: string;
  context: string;
}

/** Expected JSON structure from the extraction prompt. */
interface ExtractionResponse {
  items: ExtractedItem[];
}

const EXTRACTION_PROMPT = `Analyze this conversation and extract ALL information worth remembering long-term.

Categories:
- decision: Architecture choices, tech selections, design decisions
- preference: User preferences stated or implied
- lesson: Technical findings, things learned, solutions found
- infrastructure: Hosts, services, IPs, configs, credentials
- project_update: What was built, progress, next steps
- architecture: System design, component structure, patterns

Return JSON: { "items": [{ "content": "...", "context": "category" }] }
Only extract NEW, meaningful information. Skip routine acknowledgments.
Return empty items array if nothing noteworthy.`;

/**
 * Extracts important information from conversation messages before
 * context compaction, retaining it to Hindsight for long-term memory.
 *
 * Uses a cheap model (e.g. Haiku) for extraction to minimize cost.
 */
export class CompactionFlush {
  private readonly deduplicationThreshold: number;

  constructor(
    private readonly hs: HindsightClient,
    private readonly anthropic: AnthropicClient,
    private readonly model: string,
    deduplicationThreshold?: number,
  ) {
    this.deduplicationThreshold = deduplicationThreshold ?? 0.85;
  }

  /**
   * Extract and retain all important information from conversation messages.
   *
   * @param messages - The conversation messages to analyze.
   * @param bankId - Target Hindsight bank for retention.
   * @returns The number of items retained (0 if extraction fails).
   */
  async flush(
    messages: { role: string; content: string }[],
    bankId: string,
  ): Promise<FlushResult> {
    if (messages.length === 0) {
      return { itemsRetained: 0 };
    }

    try {
      // Format conversation for the extraction prompt.
      // Truncate to ~60K chars (~15K tokens) to prevent oversized API requests.
      const MAX_CONVERSATION_CHARS = 60_000;
      let conversationText = messages
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n\n');

      if (conversationText.length > MAX_CONVERSATION_CHARS) {
        log.verbose(`Truncating conversation for extraction: ${conversationText.length} → ${MAX_CONVERSATION_CHARS} chars`);
        conversationText = conversationText.slice(-MAX_CONVERSATION_CHARS);
      }

      const response = await this.anthropic.createMessage({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: `${EXTRACTION_PROMPT}\n\n---\n\n${conversationText}`,
          },
        ],
        maxTokens: 4096,
        temperature: 0,
      });

      // Extract text from response
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');

      if (!text) {
        log.warn('Empty extraction response');
        return { itemsRetained: 0 };
      }

      // Parse JSON — handle markdown code fences if present
      const jsonStr = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      const parsed = JSON.parse(jsonStr) as ExtractionResponse;

      if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
        log.debug('No items extracted from conversation');
        return { itemsRetained: 0 };
      }

      const candidates = parsed.items
        .filter((item) => item.content && item.context);

      const intraBatchDeduped = deduplicateByContent(
        candidates.map((item) => ({ ...item, content: item.content, relevance: 1 })),
        this.deduplicationThreshold,
      ).map((item) => ({ content: item.content, context: item.context }));

      const dedupChecks = await Promise.all(
        intraBatchDeduped.map(async (item) => {
          const isDup = await this.hs.isDuplicateContent(bankId, item.content, this.deduplicationThreshold);
          return isDup ? null : item;
        }),
      );
      const uniqueItems = dedupChecks.filter(Boolean) as ExtractedItem[];

      const items = uniqueItems.map((item) => ({
        content: item.content,
        context: item.context,
        timestamp: new Date().toISOString(),
      }));

      if (items.length > 0) {
        await this.hs.retain(bankId, items);
        log.info('Compaction flush complete', {
          bankId,
          itemsRetained: items.length,
          duplicatesSkipped: candidates.length - uniqueItems.length,
        });
      }

      return { itemsRetained: items.length };
    } catch (err) {
      log.warn('Compaction flush failed', {
        bankId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { itemsRetained: 0 };
    }
  }
}

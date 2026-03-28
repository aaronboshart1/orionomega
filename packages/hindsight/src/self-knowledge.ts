/**
 * @module memory/self-knowledge
 * Bootstraps and maintains Hindsight's knowledge of its own configuration.
 * Stores API endpoint, bank dispositions, tuning parameters, and architectural
 * decisions as memories so meta-cognitive queries return relevant results.
 */

import { HindsightClient } from './client.js';
import { createLogger } from './logger.js';

const log = createLogger('self-knowledge');

export interface SelfKnowledgeConfig {
  apiEndpoint: string;
  banks?: Array<{ id: string; name: string; disposition?: string }>;
  deduplicationThreshold?: number;
  relevanceFloor?: number;
  qualityThreshold?: number;
  budgetTiers?: Record<string, number>;
  architecturalDecisions?: string[];
}

export class SelfKnowledge {
  private dedupThreshold = 0.85;

  constructor(private readonly hs: HindsightClient) {}

  async bootstrap(config: SelfKnowledgeConfig): Promise<void> {
    this.dedupThreshold = config.deduplicationThreshold ?? 0.85;
    const memories: Array<{ content: string; context: string }> = [];

    memories.push({
      content: [
        'Hindsight Memory System Configuration',
        `API endpoint: ${config.apiEndpoint}`,
        `Deduplication threshold: ${config.deduplicationThreshold ?? 0.85}`,
        `Relevance floor: ${config.relevanceFloor ?? 0.3}`,
        `Quality threshold: ${config.qualityThreshold ?? 0.3}`,
      ].join('\n'),
      context: 'self_knowledge',
    });

    if (config.budgetTiers) {
      const tierLines = Object.entries(config.budgetTiers)
        .map(([tier, tokens]) => `  ${tier}: ${tokens} tokens`);
      memories.push({
        content: `Hindsight budget tiers:\n${tierLines.join('\n')}`,
        context: 'self_knowledge',
      });
    }

    if (config.banks && config.banks.length > 0) {
      const bankLines = config.banks.map((b) =>
        `  ${b.id}: ${b.name}${b.disposition ? ` (${b.disposition})` : ''}`
      );
      memories.push({
        content: `Active Hindsight memory banks:\n${bankLines.join('\n')}`,
        context: 'self_knowledge',
      });
    }

    if (config.architecturalDecisions && config.architecturalDecisions.length > 0) {
      for (const decision of config.architecturalDecisions) {
        memories.push({
          content: `Hindsight architectural decision: ${decision}`,
          context: 'self_knowledge',
        });
      }
    }

    let stored = 0;
    for (const mem of memories) {
      try {
        const isDup = await this.hs.isDuplicateContent('core', mem.content, this.dedupThreshold);
        if (!isDup) {
          await this.hs.retainOne('core', mem.content, mem.context);
          stored++;
        }
      } catch (err) {
        log.warn('Failed to store self-knowledge memory', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('Self-knowledge bootstrap complete', {
      total: memories.length,
      stored,
      skippedDuplicates: memories.length - stored,
    });
  }

  async retainConfigChange(description: string): Promise<void> {
    try {
      const content = `Hindsight configuration change: ${description} (at ${new Date().toISOString()})`;
      const isDup = await this.hs.isDuplicateContent('core', content, this.dedupThreshold);
      if (isDup) {
        log.debug('Skipped duplicate config change retention', { description });
        return;
      }
      await this.hs.retainOne('core', content, 'self_knowledge');
      log.info('Configuration change retained', { description });
    } catch (err) {
      log.warn('Failed to retain configuration change', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

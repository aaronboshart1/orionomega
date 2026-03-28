import { HindsightClient } from '@orionomega/hindsight';
import { createLogger } from '../logging/logger.js';
import type { ConfidenceSummary } from './context-assembler.js';

const log = createLogger('dynamic-summary');

export interface DynamicSummaryOptions {
  maxTokens?: number;
  minRelevance?: number;
}

export interface DynamicSummaryResult {
  formatted: string;
  confidenceSummary: ConfidenceSummary;
}

const DEFAULT_SUMMARY_TOKENS = 4096;
const DEFAULT_MIN_RELEVANCE = 0.2;

export class DynamicSummaryGenerator {
  constructor(private readonly hs: HindsightClient) {}

  async generateProjectSummary(
    bankId: string,
    opts?: DynamicSummaryOptions,
  ): Promise<DynamicSummaryResult | null> {
    const maxTokens = opts?.maxTokens ?? DEFAULT_SUMMARY_TOKENS;
    const minRelevance = opts?.minRelevance ?? DEFAULT_MIN_RELEVANCE;

    try {
      const summaryQueries = [
        'current project status, recent progress, what was built',
        'key decisions, architecture choices, technical direction',
        'open items, next steps, blockers, priorities',
      ];

      const perQueryTokens = Math.floor(maxTokens / summaryQueries.length);
      if (perQueryTokens < 200) {
        log.debug('Insufficient token budget for dynamic summary', { maxTokens });
        return null;
      }

      const recallPromises = summaryQueries.map((query) =>
        this.hs
          .recall(bankId, query, {
            maxTokens: perQueryTokens,
            budget: 'mid',
            minRelevance,
          })
          .catch((err) => {
            log.debug('Summary recall query failed', {
              query: query.slice(0, 50),
              error: err instanceof Error ? err.message : String(err),
            });
            return { results: [], tokens_used: 0 };
          }),
      );

      const results = await Promise.all(recallPromises);

      const seenContents = new Set<string>();
      const allMemories: Array<{
        content: string;
        context: string;
        relevance: number;
        timestamp: string;
      }> = [];

      for (const result of results) {
        for (const mem of result.results) {
          if (!seenContents.has(mem.content)) {
            seenContents.add(mem.content);
            allMemories.push(mem);
          }
        }
      }

      if (allMemories.length === 0) return null;

      allMemories.sort((a, b) => b.relevance - a.relevance);

      const grouped: Record<string, typeof allMemories> = {};
      for (const mem of allMemories) {
        const cat = mem.context || 'general';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(mem);
      }

      const categoryOrder = [
        'project_update',
        'decision',
        'architecture',
        'lesson',
        'preference',
        'infrastructure',
        'session_summary',
      ];

      const sections: string[] = [];

      for (const cat of categoryOrder) {
        const items = grouped[cat];
        if (!items || items.length === 0) continue;
        delete grouped[cat];
        const header = categoryLabel(cat);
        const formatted = items.map(
          (m) => `  - [${m.relevance.toFixed(2)}] ${m.content}`,
        );
        sections.push(`### ${header}\n${formatted.join('\n')}`);
      }

      for (const [cat, items] of Object.entries(grouped)) {
        if (items.length === 0) continue;
        const header = categoryLabel(cat);
        const formatted = items.map(
          (m) => `  - [${m.relevance.toFixed(2)}] ${m.content}`,
        );
        sections.push(`### ${header}\n${formatted.join('\n')}`);
      }

      const confidenceSummary = computeConfidenceBuckets(allMemories);
      const confLine = `Confidence: ${confidenceSummary.high} high, ${confidenceSummary.moderate} moderate, ${confidenceSummary.low} low — ${confidenceSummary.total} memories total`;

      const summary = `## Dynamic Project Summary (${bankId})\n${confLine}\n\n${sections.join('\n\n')}`;

      log.debug('Dynamic summary generated', {
        bankId,
        memoryCount: allMemories.length,
        sectionCount: sections.length,
      });

      return { formatted: summary, confidenceSummary };
    } catch (err) {
      log.warn('Dynamic summary generation failed', {
        bankId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

function categoryLabel(context: string): string {
  const labels: Record<string, string> = {
    project_update: 'Recent Progress',
    decision: 'Key Decisions',
    architecture: 'Architecture',
    lesson: 'Lessons & Findings',
    preference: 'Preferences',
    infrastructure: 'Infrastructure',
    session_summary: 'Session History',
    node_output: 'Workflow Outputs',
    artifact: 'Artifacts',
    general: 'General',
  };
  return labels[context] ?? context;
}

function computeConfidenceBuckets(
  memories: Array<{ relevance: number }>,
): ConfidenceSummary {
  let high = 0;
  let moderate = 0;
  let low = 0;
  for (const m of memories) {
    if (m.relevance >= 0.7) high++;
    else if (m.relevance >= 0.4) moderate++;
    else low++;
  }
  return { high, moderate, low, total: memories.length };
}

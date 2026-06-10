/**
 * @module lessons-rollup
 * Cross-project lesson synthesis. Project banks (`project-*`) accumulate
 * lessons in isolation; this engine periodically promotes the highest-signal
 * lessons up into the shared `core` bank so insights learned in one project
 * become available to every future session, regardless of which project bank
 * is active.
 *
 * Promotion is idempotent (stable `document_id` per lesson) and de-duplicated
 * both against lessons already in `core` and against other project banks in
 * the same pass, so repeated rollups don't bloat the core bank.
 */

import { HindsightClient } from './client.js';
import { createLogger } from './logger.js';
import { DedupIndex } from './similarity.js';

const log = createLogger('lessons-rollup');

/** Tuning for a lessons rollup pass. */
export interface LessonsRollupOptions {
  /** Destination bank for synthesized cross-project lessons. Default: `'core'`. */
  coreBankId?: string;
  /** Only banks whose id starts with this prefix are scanned. Default: `'project-'`. */
  projectBankPrefix?: string;
  /** Memory contexts treated as lessons. Default: `['lesson', 'decision']`. */
  lessonContexts?: string[];
  /** Max project banks scanned per pass. Default: 25. */
  maxBanksPerRun?: number;
  /** Max lessons pulled from each project bank. Default: 50. */
  maxLessonsPerBank?: number;
  /** Near-duplicate threshold for cross-project dedup. Default: 0.85. */
  dedupThreshold?: number;
  /** Minimum content length (chars) for a lesson to be worth promoting. Default: 24. */
  minLessonLength?: number;
}

/** Summary of a single rollup pass. */
export interface LessonsRollupResult {
  banksScanned: number;
  lessonsConsidered: number;
  lessonsPromoted: number;
  duplicatesSkipped: number;
  errors: string[];
}

const DEFAULTS = {
  coreBankId: 'core',
  projectBankPrefix: 'project-',
  lessonContexts: ['lesson', 'decision'],
  maxBanksPerRun: 25,
  maxLessonsPerBank: 50,
  dedupThreshold: 0.85,
  minLessonLength: 24,
};

/** 32-bit hash → base36 string, used for stable promotion document ids. */
function shortHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export class LessonsRollup {
  private readonly opts: Required<LessonsRollupOptions>;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(
    private readonly hs: HindsightClient,
    opts?: LessonsRollupOptions,
  ) {
    this.opts = {
      coreBankId: opts?.coreBankId ?? DEFAULTS.coreBankId,
      projectBankPrefix: opts?.projectBankPrefix ?? DEFAULTS.projectBankPrefix,
      lessonContexts: opts?.lessonContexts ?? DEFAULTS.lessonContexts,
      maxBanksPerRun: opts?.maxBanksPerRun ?? DEFAULTS.maxBanksPerRun,
      maxLessonsPerBank: opts?.maxLessonsPerBank ?? DEFAULTS.maxLessonsPerBank,
      dedupThreshold: opts?.dedupThreshold ?? DEFAULTS.dedupThreshold,
      minLessonLength: opts?.minLessonLength ?? DEFAULTS.minLessonLength,
    };
  }

  /**
   * Run one cross-project rollup pass. Safe to call concurrently — overlapping
   * calls are coalesced (the second returns the in-progress result as empty
   * counts rather than double-scanning).
   */
  async run(): Promise<LessonsRollupResult> {
    const result: LessonsRollupResult = {
      banksScanned: 0,
      lessonsConsidered: 0,
      lessonsPromoted: 0,
      duplicatesSkipped: 0,
      errors: [],
    };

    if (this._running) {
      log.debug('Lessons rollup already running — skipping overlapping pass');
      return result;
    }
    this._running = true;

    try {
      const contexts = new Set(this.opts.lessonContexts);
      const banks = await this.hs.listBanksCached();
      const projectBanks = banks
        .filter((b) => b.bank_id.startsWith(this.opts.projectBankPrefix))
        .filter((b) => b.bank_id !== this.opts.coreBankId)
        .filter((b) => (b.memory_count ?? 1) > 0)
        .slice(0, this.opts.maxBanksPerRun);

      // Seed the dedup index with lessons already in core so we never promote a
      // near-duplicate of something already there, and so we dedup across the
      // project banks scanned in this same pass.
      const index = new DedupIndex({
        expectedItems: 4096,
        threshold: this.opts.dedupThreshold,
      });
      try {
        const coreExisting = await this.hs.listMemories(this.opts.coreBankId, { limit: 1000 });
        for (const m of coreExisting.items) {
          if (m.content) index.add(m.content);
        }
      } catch (err) {
        // A missing/unavailable core bank is non-fatal — we'll still promote,
        // relying on the retain-side document_id for idempotency.
        result.errors.push(`core seed: ${err instanceof Error ? err.message : String(err)}`);
      }

      for (const bank of projectBanks) {
        try {
          const memories = await this.hs.listMemories(bank.bank_id, {
            limit: this.opts.maxLessonsPerBank,
          });
          result.banksScanned++;

          for (const m of memories.items) {
            const content = (m.content ?? '').trim();
            if (!content || content.length < this.opts.minLessonLength) continue;
            if (m.context && !contexts.has(m.context)) continue;
            result.lessonsConsidered++;

            if (!index.addIfNew(content, this.opts.dedupThreshold)) {
              result.duplicatesSkipped++;
              continue;
            }

            try {
              await this.hs.retain(this.opts.coreBankId, [{
                content,
                context: 'lesson',
                timestamp: new Date().toISOString(),
                tags: [`source:${bank.bank_id}`, 'cross-project-rollup'],
                document_id: `lesson-rollup-${shortHash(content)}`,
              }]);
              result.lessonsPromoted++;
            } catch (err) {
              result.errors.push(
                `promote from ${bank.bank_id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        } catch (err) {
          result.errors.push(
            `scan ${bank.bank_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      log.info('Lessons rollup complete', {
        banksScanned: result.banksScanned,
        lessonsConsidered: result.lessonsConsidered,
        lessonsPromoted: result.lessonsPromoted,
        duplicatesSkipped: result.duplicatesSkipped,
        errors: result.errors.length,
      });
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      log.warn('Lessons rollup pass failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this._running = false;
    }

    return result;
  }

  /**
   * Start a periodic rollup loop. The timer is `unref`'d so it never keeps the
   * process alive on its own. Calling start twice is a no-op until {@link stop}.
   */
  start(intervalMs: number): void {
    if (this._timer) return;
    const ms = Math.max(60_000, intervalMs);
    this._timer = setInterval(() => {
      this.run().catch((err) => {
        log.debug('Periodic lessons rollup failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, ms);
    // Don't hold the event loop open for a background maintenance task.
    (this._timer as { unref?: () => void }).unref?.();
    log.info('Lessons rollup scheduled', { intervalMs: ms });
  }

  /** Stop the periodic rollup loop. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      log.info('Lessons rollup stopped');
    }
  }
}

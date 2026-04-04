/**
 * @module memory/mental-models
 * Manages auto-refreshing synthesized context documents (mental models)
 * in Hindsight. Debounces refresh triggers to avoid excessive API calls.
 */

import { HindsightClient } from './client.js';
import { createLogger } from './logger.js';

const log = createLogger('mental-models');

/** Definition of a system mental model. */
interface ModelDefinition {
  /** Hindsight bank containing the model. */
  bank: string;
  /** Model identifier within the bank. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** The context category that triggers a refresh of this model. */
  refreshTrigger: string;
}

/** Minimum interval between refreshes of the same model, in milliseconds. */
const REFRESH_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * System-level mental model definitions.
 * Each model is automatically refreshed when memories matching its trigger
 * category are retained.
 */
const SYSTEM_MODELS: ModelDefinition[] = [
  {
    bank: 'core',
    id: 'user-profile',
    description: 'Synthesized user preferences and patterns',
    refreshTrigger: 'preference',
  },
  {
    bank: 'core',
    id: 'session-context',
    description: 'Recent session context and continuity',
    refreshTrigger: 'session_summary',
  },
  {
    bank: 'core',
    id: 'active-projects',
    description: 'Current projects and priorities',
    refreshTrigger: 'project_update',
  },
  {
    bank: 'infra',
    id: 'infra-map',
    description: 'Infrastructure topology and service map',
    refreshTrigger: 'infrastructure',
  },
];

/**
 * Manages Hindsight mental models — pre-synthesized context documents
 * that are automatically refreshed when relevant memories change.
 *
 * Includes debouncing to prevent excessive refresh calls.
 */
export class MentalModelManager {
  /** Tracks last refresh time per model key (`bank/id`). */
  private readonly lastRefreshAt = new Map<string, number>();

  constructor(private readonly hs: HindsightClient) {}

  /**
   * Check if any system mental model should be refreshed based on a retention event.
   *
   * Called after every `retain()` — finds models whose trigger matches the
   * retained context category and refreshes them (respecting debounce).
   *
   * @param bankId - The bank the memory was retained to.
   * @param context - The context category of the retained memory.
   */
  private shouldRefresh(key: string, now: number): boolean {
    const lastRefresh = this.lastRefreshAt.get(key) ?? 0;
    return now - lastRefresh >= REFRESH_DEBOUNCE_MS;
  }

  private async refreshModelSafely(model: ModelDefinition, key: string): Promise<void> {
    try {
      await this.hs.refreshMentalModel(model.bank, model.id);
      log.info('Mental model refreshed', { key });
    } catch (err) {
      log.warn('Failed to refresh mental model', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async onRetain(bankId: string, context: string): Promise<void> {
    for (const model of SYSTEM_MODELS) {
      if (model.refreshTrigger === context) {
        const key = `${model.bank}/${model.id}`;
        const now = Date.now();
        if (!this.shouldRefresh(key, now)) {
          log.debug('Skipping refresh — debounced', { key });
          continue;
        }
        this.lastRefreshAt.set(key, now);
        await this.refreshModelSafely(model, key);
      }
    }
  }

  /**
   * Manually refresh a specific mental model, bypassing the debounce.
   *
   * @param bankId - The bank containing the model.
   * @param modelId - The model identifier.
   */
  async refresh(bankId: string, modelId: string): Promise<void> {
    const key = `${bankId}/${modelId}`;
    try {
      await this.hs.refreshMentalModel(bankId, modelId);
      this.lastRefreshAt.set(key, Date.now());
      log.info('Mental model manually refreshed', { key });
    } catch (err) {
      log.warn('Failed to manually refresh mental model', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get a mental model's content.
   *
   * @param bankId - The bank containing the model.
   * @param modelId - The model identifier.
   * @returns The model content string, or empty string if not found.
   */
  async get(bankId: string, modelId: string): Promise<string> {
    try {
      const model = await this.hs.getMentalModel(bankId, modelId);
      return model.content ?? '';
    } catch (err) {
      log.warn('Failed to get mental model', {
        bankId,
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  /**
   * F8: Seed all system mental models that don't exist yet.
   *
   * Called during init to bootstrap the mental model layer. Each model
   * is checked with a GET first; if it 404s, a refresh is triggered to
   * synthesize it from existing memories. This is fire-and-forget —
   * failures are logged but don't block startup.
   */
  async seedSystemModels(): Promise<void> {
    const results: Array<{ key: string; action: string }> = [];

    for (const model of SYSTEM_MODELS) {
      const key = `${model.bank}/${model.id}`;
      try {
        const existing = await this.hs.getMentalModel(model.bank, model.id);
        if (existing.content) {
          results.push({ key, action: 'exists' });
          continue;
        }
      } catch {
        // 404 or other error — model doesn't exist, seed it
      }

      try {
        await this.hs.refreshMentalModel(model.bank, model.id);
        this.lastRefreshAt.set(key, Date.now());
        results.push({ key, action: 'seeded' });
      } catch (err) {
        results.push({ key, action: 'failed' });
        log.debug('Failed to seed mental model', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const seeded = results.filter((r) => r.action === 'seeded').length;
    const existing = results.filter((r) => r.action === 'exists').length;
    const failed = results.filter((r) => r.action === 'failed').length;

    if (seeded > 0 || failed > 0) {
      log.info('Mental model seed complete', { seeded, existing, failed });
    }
  }
}

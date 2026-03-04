/**
 * @module memory/bank-manager
 * Automatically creates and manages project-specific memory banks in Hindsight.
 */

import { HindsightClient } from '@orionomega/hindsight';
import { createLogger } from '../logging/logger.js';

const log = createLogger('bank-manager');

/** Words stripped from task descriptions when generating bank slugs. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every',
  'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'only', 'own', 'same', 'than', 'too', 'very', 'just', 'about', 'above',
  'after', 'again', 'against', 'at', 'before', 'between', 'by', 'down',
  'during', 'for', 'from', 'in', 'into', 'of', 'off', 'on', 'out', 'over',
  'through', 'to', 'under', 'until', 'up', 'with', 'me', 'my', 'i', 'we',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they',
  'them', 'their', 'this', 'that', 'these', 'those', 'what', 'which', 'who',
  'whom', 'how', 'where', 'when', 'why', 'build', 'create', 'make', 'write',
  'design', 'implement', 'develop', 'set', 'get', 'add', 'remove', 'update',
  'fix', 'change',
]);

/** Maximum number of meaningful words to keep in a slug. */
const MAX_SLUG_WORDS = 4;

/**
 * Manages the creation and existence-checking of project memory banks.
 *
 * When a new task begins, the BankManager generates a slug from the task
 * description and ensures a corresponding bank exists in Hindsight.
 */
export class BankManager {
  constructor(private readonly hs: HindsightClient) {}

  /**
   * Ensure a project bank exists for a task. Creates the bank if needed.
   *
   * @param taskDescription - Natural-language description of the task.
   * @returns The bank ID (e.g. `"project-acme-landing-page"`).
   */
  async ensureProjectBank(taskDescription: string): Promise<string> {
    const bankId = this.generateSlug(taskDescription);

    try {
      const exists = await this.bankExists(bankId);
      if (!exists) {
        await this.hs.createBank(bankId, {
          name: `Project: ${taskDescription.slice(0, 80)}`,
        });
        log.info('Created project bank', { bankId });
      }
    } catch (err) {
      log.warn('Failed to ensure project bank', {
        bankId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return bankId;
  }

  /**
   * Check if a bank exists in Hindsight.
   *
   * @param bankId - The bank identifier.
   * @returns `true` if the bank exists.
   */
  async bankExists(bankId: string): Promise<boolean> {
    try {
      return await this.hs.bankExists(bankId);
    } catch (err) {
      log.warn('Failed to check bank existence', {
        bankId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Generate a slug from a task description.
   *
   * Strips stop words, takes the first 4 meaningful words, lowercases,
   * removes non-alphanumeric characters, and prefixes with `"project-"`.
   *
   * @example
   * ```ts
   * generateSlug("Build me a landing page for Acme Corp")
   * // → "project-landing-page-acme-corp"
   * ```
   *
   * @param description - The task description.
   * @returns A slugified bank ID.
   */
  generateSlug(description: string): string {
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

    const slug = words.slice(0, MAX_SLUG_WORDS).join('-');
    return `project-${slug || 'unnamed'}`;
  }
}

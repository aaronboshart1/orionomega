/**
 * @module memory/scope-slug
 * Derives a stable memory scope name from a task description.
 *
 * Extracted verbatim from the deleted `BankManager.generateSlug` — it was a
 * free function in disguise (it never touched `this.hs`), and it is the only
 * part of that class worth keeping. The stop-word list and the 4-word cap are
 * unchanged, so a given task yields the same scope name it always did.
 */

/** Words stripped from task descriptions when generating scope slugs. */
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
 * `"Build a Redis-backed memory store"` → `"project-redis-backed-memory-store"`.
 *
 * Deterministic: the same description always yields the same scope, which is
 * what lets a follow-up task rejoin the scope its predecessor created.
 */
export function projectScopeFor(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  const slug = words.slice(0, MAX_SLUG_WORDS).join('-');
  return `project-${slug || 'unnamed'}`;
}

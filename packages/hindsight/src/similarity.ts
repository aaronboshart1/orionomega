/**
 * @module similarity
 * Fast text similarity utilities for deduplication of recalled memories.
 * Uses trigram overlap (Jaccard index) for short text comparison.
 */

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function trigrams(normalized: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 3 || nb.length < 3) {
    return na === nb ? 1 : 0;
  }
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  return intersection / (ta.size + tb.size - intersection);
}

export function deduplicateByContent<T extends { content: string; relevance?: number }>(
  items: T[],
  threshold = 0.85,
): T[] {
  if (items.length <= 1) return items;
  const kept: T[] = [];
  for (const item of items) {
    const isDuplicate = kept.some(
      (existing) => trigramSimilarity(existing.content, item.content) >= threshold,
    );
    if (!isDuplicate) {
      kept.push(item);
    }
  }
  return kept;
}

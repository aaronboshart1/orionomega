/**
 * @module truncate
 * Shared string-truncation helper used by the logger (and available to any
 * package that needs a consistent truncation marker). Extracted alongside the
 * logger as part of the DUP-12 consolidation.
 */

/**
 * Truncate a string to at most `max` characters, appending a marker that
 * records the original length. Returns the input unchanged when it is already
 * within the limit.
 *
 * Output format: `<first max chars>... [truncated, <original length> chars]`
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + `... [truncated, ${value.length} chars]`;
}

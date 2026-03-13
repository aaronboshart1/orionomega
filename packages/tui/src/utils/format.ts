/**
 * @module utils/format
 * Shared text formatting utilities for the OrionOmega TUI.
 *
 * Consolidates duplicated logic from:
 *   - shortenModel(): plan-overlay.ts, status-bar.ts, workflow-tracker.ts (3 copies)
 *   - truncation: chat-log.ts (2×), workflow-tracker.ts (1×), status-bar.ts (1×)
 *   - wrapText(): plan-overlay.ts (1 copy)
 *   - formatTokens(): status-bar.ts (defined but never called)
 *   - cost formatting: plan-overlay.ts (.toFixed(3)), status-bar.ts (.toFixed(2)), index.ts (.toFixed(2))
 *   - time formatting: plan-overlay.ts (seconds), index.ts (minutes), workflow-tracker.ts (seconds)
 */

/**
 * Truncate a string to `max` characters, appending '…' if truncated.
 */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Word-wrap text to fit within `width` characters.
 * Splits on whitespace boundaries. Returns array of lines.
 */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Shorten Claude model identifiers to human-friendly names.
 *
 * Examples:
 *   "claude-sonnet-4-20250514"  → "Sonnet 4"
 *   "claude-opus-4-20250514"    → "Opus 4"
 *   "claude-haiku-4-5-20251001" → "Haiku 4.5"
 *
 * Falls back to truncation at `maxLen` (default 20).
 */
export function shortenModel(model: string, maxLen = 20): string {
  const match = model.match(/claude-(\w+)-([\d.-]+)/);
  if (match) {
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const ver = match[2].replace(/-\d{8}$/, '').replace(/-/g, '.');
    return `${name} ${ver}`;
  }
  return truncate(model, maxLen);
}

/**
 * Format token counts in compact form.
 *   1234567 → "1.2M"
 *   45000   → "45k"
 *   999     → "999"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

/**
 * Format cost with consistent precision (always 2 decimal places).
 * Prefixed with "$".
 */
export function formatCost(n: number): string {
  return '$' + n.toFixed(2);
}

/**
 * Format duration in human-readable form.
 *   42    → "42s"
 *   135   → "2m 15s"
 *   3665  → "1h 1m"
 */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Pad a string to exactly `width` characters (right-padded with spaces).
 * Truncates with '…' if longer than width.
 */
export function padRight(s: string, width: number): string {
  if (s.length > width) return s.slice(0, width - 1) + '…';
  return s + ' '.repeat(width - s.length);
}

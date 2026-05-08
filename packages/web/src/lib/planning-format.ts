/**
 * Task #204: shared formatters for planner / sub-planner token + cost
 * pills so the PlanningIndicator and MacroExpansionPanel render the
 * same compact "X in / Y out · $cost" pill style.
 */

export interface PlanningTokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
}

/**
 * Format a USD cost compactly. Sub-cent costs render as "<$0.01" so
 * cheap planning passes don't display a misleading "$0.0000".
 */
export function formatPlanningCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Render the "X in / Y out" string for a token-usage payload. */
export function formatTokenInOut(u: PlanningTokenUsage): string {
  return `${u.input.toLocaleString()} in / ${u.output.toLocaleString()} out`;
}

/**
 * Build a tooltip string with full input/output/cache breakdown so
 * users can hover the compact pill for the underlying numbers.
 */
export function buildTokenTooltip(u: PlanningTokenUsage): string {
  return [
    `input: ${u.input.toLocaleString()}`,
    `output: ${u.output.toLocaleString()}`,
    u.cacheRead != null ? `cache read: ${u.cacheRead.toLocaleString()}` : undefined,
    u.cacheWrite != null ? `cache write: ${u.cacheWrite.toLocaleString()}` : undefined,
    u.costUsd != null ? `cost: ${formatPlanningCost(u.costUsd)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

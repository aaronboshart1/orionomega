/**
 * Deep-merges a partial config onto defaults, returning a complete config.
 * Only overrides leaf values that are explicitly present in the partial.
 * Arrays are replaced wholesale (not merged).
 */
export function deepMerge(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(overrides)) {
    const val = overrides[key];
    const def = defaults[key];
    if (
      val !== null &&
      val !== undefined &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      def !== null &&
      def !== undefined &&
      typeof def === 'object' &&
      !Array.isArray(def)
    ) {
      result[key] = deepMerge(
        def as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

/**
 * @module models/model-registry
 * Declarative model capability registry (Task #229 / R2).
 *
 * Model-specific behaviour — tier, output-token ceilings, thinking rules,
 * pricing, beta headers, effort aliasing, and access gating — used to be
 * scattered across the codebase as hardcoded `switch`/`includes()` branches.
 * Every new model (Opus 4.8 → Fable 5 → next) required a core code change.
 *
 * This registry consolidates all of that into ONE declarative table so adding a
 * model becomes a data edit (a default entry, a discovery seed, or a
 * `config.yaml` override) rather than a code change.
 *
 * Resolution precedence for any given field is: **config > discovery > defaults**.
 *   - `DEFAULT_CAPABILITIES` seeds the base table (this file).
 *   - `seedRegistryFromDiscovery()` adds models learned from the live
 *     `/v1/models` endpoint that aren't already known (never overwrites).
 *   - `applyRegistryOverrides()` merges `config.yaml` overrides on top of
 *     whatever is already registered.
 *
 * Consumers (`client.ts`, `model-discovery.ts`, `coding-budget.ts`,
 * `planner.ts`) read everything through {@link getModelCapability} instead of
 * inspecting model-ID substrings inline.
 */

/** Coarse model family tier. `mythos` sits above `opus`. */
export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'mythos' | 'unknown';

/** Effort level understood by the output/effort presets. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How a model surfaces extended thinking. */
export type ThinkingMode = 'adaptive' | 'budget';

/** Per-MTok USD pricing for a model. */
export interface ModelPricing {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
  /** USD per million cache-read tokens. */
  cacheRead: number;
  /** USD per million cache-write/creation tokens. */
  cacheWrite: number;
}

/** Optional fast-mode descriptor. Presence = the model supports fast mode. */
export interface FastModeCapability {
  /** `anthropic-beta` header value to send when fast mode is requested. */
  betaHeader: string;
}

/** Declarative capability record for a single model. */
export interface ModelCapability {
  /** Canonical model ID (e.g. `claude-opus-4-8`). */
  id: string;
  /**
   * Substrings that also identify this model (e.g. `opus-4-8` matches the
   * dated variant `claude-opus-4-8-20260601`). Matched case-insensitively.
   */
  aliases: string[];
  /** Family tier. */
  tier: ModelTier;
  /** Total context window (input) the model accepts. */
  contextWindow: number;
  /**
   * Hard per-model output-token ceiling enforced by the API. Requests above
   * this return a 400.
   */
  maxOutput: number;
  /**
   * Default `max_tokens` to request when a caller doesn't specify one — the
   * comfortably-supported output size (may be below {@link maxOutput}).
   */
  defaultMaxOutput: number;
  /**
   * Thinking style. `adaptive` models reject a manual `budget_tokens` and must
   * be sent `{ type: 'adaptive' }`; `budget` models accept enabled+budget.
   */
  thinking: ThinkingMode;
  /**
   * Whether the model accepts sampling params (temperature/top_p/top_k).
   * Adaptive-thinking models (Opus 4.8, Fable) reject them with a 400.
   */
  supportsSampling: boolean;
  /**
   * Whether the model accepts a *forced* `tool_choice` (`{ type: 'tool' }` or
   * `{ type: 'any' }`). Mythos models (Fable 5) reject forced tool use with a
   * 400 ("tool_choice forces tool use is not compatible with this model") and
   * only accept `{ type: 'auto' }`.
   */
  supportsForcedToolChoice: boolean;
  /** Whether mid-conversation `system` messages are supported. */
  supportsMidConversationSystem: boolean;
  /** Effort presets the model understands. */
  supportedEfforts: EffortLevel[];
  /**
   * Effort aliases applied before a request is built (e.g. `{ max: 'xhigh' }`
   * when the toolchain tops out at xhigh for this model).
   */
  effortAliases: Partial<Record<EffortLevel, EffortLevel>>;
  /** Per-MTok pricing. */
  pricing: ModelPricing;
  /** Unconditional `anthropic-beta` headers required for this model. */
  betaHeaders: string[];
  /** Fast-mode descriptor, when supported. */
  fastMode?: FastModeCapability;
  /**
   * Whether the model requires special access / allow-listing. Gated models may
   * be forbidden at request time (handled by a separate fallback task).
   */
  accessGated: boolean;
}

/** A partial override keyed by model ID, supplied via `config.yaml`. */
export type ModelCapabilityOverride = Partial<ModelCapability> & { id: string };

// ── Tier default templates ───────────────────────────────────────────────────

/**
 * Per-tier capability templates used to synthesise a capability for any model
 * that isn't explicitly registered (e.g. a freshly-released `claude-opus-4-9`).
 * Keeps behaviour sane for unknown models without a code change.
 */
const TIER_DEFAULTS: Record<ModelTier, Omit<ModelCapability, 'id' | 'aliases' | 'tier'>> = {
  haiku: {
    contextWindow: 200_000,
    maxOutput: 8_192,
    defaultMaxOutput: 8_192,
    thinking: 'budget',
    supportsSampling: true,
    supportsForcedToolChoice: true,
    supportsMidConversationSystem: false,
    supportedEfforts: ['low', 'medium', 'high'],
    effortAliases: { xhigh: 'high', max: 'high' },
    pricing: { in: 0.80, out: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
    betaHeaders: [],
    accessGated: false,
  },
  sonnet: {
    contextWindow: 200_000,
    maxOutput: 64_000,
    defaultMaxOutput: 16_384,
    thinking: 'budget',
    supportsSampling: true,
    supportsForcedToolChoice: true,
    supportsMidConversationSystem: false,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    effortAliases: { max: 'xhigh' },
    pricing: { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    betaHeaders: [],
    accessGated: false,
  },
  opus: {
    contextWindow: 200_000,
    maxOutput: 64_000,
    defaultMaxOutput: 16_384,
    thinking: 'budget',
    supportsSampling: true,
    supportsForcedToolChoice: true,
    supportsMidConversationSystem: false,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    effortAliases: { max: 'xhigh' },
    pricing: { in: 15.00, out: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    betaHeaders: [],
    accessGated: false,
  },
  mythos: {
    contextWindow: 200_000,
    maxOutput: 128_000,
    defaultMaxOutput: 128_000,
    thinking: 'adaptive',
    supportsSampling: false,
    // Mythos rejects a forced tool_choice (400) — only `{ type: 'auto' }`.
    supportsForcedToolChoice: false,
    supportsMidConversationSystem: true,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortAliases: {},
    pricing: { in: 10.00, out: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
    betaHeaders: [],
    accessGated: true,
  },
  // `unknown` mirrors sonnet pricing (the historical fallback) with a
  // conservative 8 192 output ceiling.
  unknown: {
    contextWindow: 200_000,
    maxOutput: 8_192,
    defaultMaxOutput: 8_192,
    thinking: 'budget',
    supportsSampling: true,
    supportsForcedToolChoice: true,
    supportsMidConversationSystem: false,
    supportedEfforts: ['low', 'medium', 'high'],
    effortAliases: { xhigh: 'high', max: 'high' },
    pricing: { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    betaHeaders: [],
    accessGated: false,
  },
};

// ── Default capability table ─────────────────────────────────────────────────

/**
 * Built-in capability defaults. These are the lowest-precedence layer —
 * discovery seeds and config overrides build on top.
 */
export const DEFAULT_CAPABILITIES: ModelCapability[] = [
  {
    id: 'claude-haiku-4-5',
    aliases: ['haiku-4-5', 'haiku'],
    tier: 'haiku',
    ...TIER_DEFAULTS.haiku,
  },
  {
    id: 'claude-sonnet-4-6',
    aliases: ['sonnet-4-6', 'sonnet'],
    tier: 'sonnet',
    ...TIER_DEFAULTS.sonnet,
  },
  {
    id: 'claude-opus-4-6',
    aliases: ['opus-4-6'],
    tier: 'opus',
    ...TIER_DEFAULTS.opus,
  },
  {
    id: 'claude-opus-4-8',
    aliases: ['opus-4-8'],
    tier: 'opus',
    contextWindow: 200_000,
    // Opus 4.8 accepts up to 128 000 output tokens (NOT 131 072 — that exact
    // value produced the observed `max_tokens > 128000` 400).
    maxOutput: 128_000,
    defaultMaxOutput: 128_000,
    // Adaptive thinking only: a manual budget_tokens returns a 400.
    thinking: 'adaptive',
    // Rejects temperature/top_p/top_k with a 400.
    supportsSampling: false,
    // Opus 4.8 still accepts a forced tool_choice (only mythos rejects it).
    supportsForcedToolChoice: true,
    // Supports mid-conversation system messages (only opus-4-8+).
    supportsMidConversationSystem: true,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortAliases: {},
    pricing: { in: 5.00, out: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    betaHeaders: [],
    fastMode: { betaHeader: 'fast-mode-2026-02-01' },
    accessGated: false,
  },
  {
    // Fable 5 — mythos-tier, access-gated. Pricing is provisional until the
    // model is GA; override via config.yaml when official rates land.
    id: 'claude-fable-5',
    aliases: ['fable-5', 'fable'],
    tier: 'mythos',
    ...TIER_DEFAULTS.mythos,
  },
];

// ── Registry implementation ──────────────────────────────────────────────────

/** Deep-clone a capability so callers cannot mutate registry internals. */
function cloneCapability(cap: ModelCapability): ModelCapability {
  return {
    ...cap,
    aliases: [...cap.aliases],
    supportedEfforts: [...cap.supportedEfforts],
    effortAliases: { ...cap.effortAliases },
    pricing: { ...cap.pricing },
    betaHeaders: [...cap.betaHeaders],
    fastMode: cap.fastMode ? { ...cap.fastMode } : undefined,
  };
}

/**
 * Infer a model's family tier from its ID. `fable`/`mythos` map to the
 * `mythos` tier (checked first so it never collides with `opus`).
 */
export function inferModelTier(modelId: string): ModelTier {
  const lower = modelId.toLowerCase();
  if (lower.includes('fable') || lower.includes('mythos')) return 'mythos';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return 'unknown';
}

/**
 * The mutable model registry. A module-level singleton ({@link registry}) is
 * shared by all consumers; the class is exported so tests can build isolated
 * instances.
 */
export class ModelRegistry {
  private readonly entries: ModelCapability[];

  constructor(defaults: ModelCapability[] = DEFAULT_CAPABILITIES) {
    this.entries = defaults.map(cloneCapability);
  }

  /** All registered capabilities (clones — safe to mutate). */
  list(): ModelCapability[] {
    return this.entries.map(cloneCapability);
  }

  /** Find the registered entry that matches `modelId`, if any. */
  private findEntry(modelId: string): ModelCapability | undefined {
    const lower = modelId.toLowerCase();
    // 1) Exact ID match.
    const exact = this.entries.find((e) => e.id.toLowerCase() === lower);
    if (exact) return exact;
    // 2) Alias/substring match — longest alias first so `opus-4-8` beats a
    //    hypothetical broader `opus` alias.
    const candidates: Array<{ entry: ModelCapability; len: number }> = [];
    for (const entry of this.entries) {
      const tokens = [entry.id, ...entry.aliases];
      for (const token of tokens) {
        const t = token.toLowerCase();
        if (t && lower.includes(t)) {
          candidates.push({ entry, len: t.length });
          break;
        }
      }
    }
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => b.len - a.len);
    return candidates[0]!.entry;
  }

  /**
   * Resolve the full capability for a model ID. Falls back to a tier-default
   * template (synthesised from the inferred tier) when the model is unknown,
   * so behaviour stays sane for freshly-released models with no entry.
   */
  resolve(modelId: string): ModelCapability {
    const entry = this.findEntry(modelId);
    if (entry) return cloneCapability(entry);

    const tier = inferModelTier(modelId);
    return {
      id: modelId,
      aliases: [],
      tier,
      ...TIER_DEFAULTS[tier],
      supportedEfforts: [...TIER_DEFAULTS[tier].supportedEfforts],
      effortAliases: { ...TIER_DEFAULTS[tier].effortAliases },
      pricing: { ...TIER_DEFAULTS[tier].pricing },
      betaHeaders: [...TIER_DEFAULTS[tier].betaHeaders],
    };
  }

  /**
   * Seed capabilities learned from live discovery. Only adds models that are
   * not already registered — discovery never overwrites defaults/config so the
   * config > discovery > defaults precedence holds.
   */
  seedFromDiscovery(models: Array<{ id: string; tier?: ModelTier }>): void {
    for (const m of models) {
      if (!m.id) continue;
      if (this.findEntry(m.id)) continue;
      const tier = m.tier ?? inferModelTier(m.id);
      this.entries.push({
        id: m.id,
        aliases: [],
        tier,
        ...TIER_DEFAULTS[tier],
        supportedEfforts: [...TIER_DEFAULTS[tier].supportedEfforts],
        effortAliases: { ...TIER_DEFAULTS[tier].effortAliases },
        pricing: { ...TIER_DEFAULTS[tier].pricing },
        betaHeaders: [...TIER_DEFAULTS[tier].betaHeaders],
      });
    }
  }

  /**
   * Apply `config.yaml` overrides — highest precedence. Merges field-by-field
   * onto an existing entry (matched by exact ID) or registers a brand-new
   * capability (synthesised from the inferred tier, then overridden).
   */
  applyOverrides(overrides: ModelCapabilityOverride[]): void {
    for (const ov of overrides) {
      if (!ov.id) continue;
      const idx = this.entries.findIndex((e) => e.id.toLowerCase() === ov.id.toLowerCase());
      if (idx >= 0) {
        this.entries[idx] = mergeOverride(this.entries[idx]!, ov);
      } else {
        const tier = ov.tier ?? inferModelTier(ov.id);
        const base: ModelCapability = {
          id: ov.id,
          aliases: [],
          tier,
          ...TIER_DEFAULTS[tier],
          supportedEfforts: [...TIER_DEFAULTS[tier].supportedEfforts],
          effortAliases: { ...TIER_DEFAULTS[tier].effortAliases },
          pricing: { ...TIER_DEFAULTS[tier].pricing },
          betaHeaders: [...TIER_DEFAULTS[tier].betaHeaders],
        };
        this.entries.push(mergeOverride(base, ov));
      }
    }
  }
}

/** Merge a partial override onto a base capability (nested objects merged). */
function mergeOverride(base: ModelCapability, ov: ModelCapabilityOverride): ModelCapability {
  return {
    ...base,
    ...ov,
    aliases: ov.aliases ? [...ov.aliases] : [...base.aliases],
    supportedEfforts: ov.supportedEfforts ? [...ov.supportedEfforts] : [...base.supportedEfforts],
    effortAliases: ov.effortAliases ? { ...base.effortAliases, ...ov.effortAliases } : { ...base.effortAliases },
    pricing: ov.pricing ? { ...base.pricing, ...ov.pricing } : { ...base.pricing },
    betaHeaders: ov.betaHeaders ? [...ov.betaHeaders] : [...base.betaHeaders],
    fastMode: ov.fastMode ? { ...ov.fastMode } : base.fastMode ? { ...base.fastMode } : undefined,
  };
}

// ── Module singleton + convenience API ───────────────────────────────────────

let registry = new ModelRegistry();

/** Resolve the capability for a model ID from the shared registry. */
export function getModelCapability(modelId: string): ModelCapability {
  return registry.resolve(modelId);
}

/** Seed the shared registry from live discovery (additive only). */
export function seedRegistryFromDiscovery(models: Array<{ id: string; tier?: ModelTier }>): void {
  registry.seedFromDiscovery(models);
}

/** Apply `config.yaml` overrides to the shared registry (highest precedence). */
export function applyRegistryOverrides(overrides: ModelCapabilityOverride[] | undefined): void {
  if (!overrides || overrides.length === 0) return;
  registry.applyOverrides(overrides);
}

/** All capabilities currently in the shared registry. */
export function listModelCapabilities(): ModelCapability[] {
  return registry.list();
}

/**
 * Reset the shared registry to built-in defaults. Intended for tests that
 * exercise discovery/override precedence in isolation.
 */
export function resetModelRegistry(): void {
  registry = new ModelRegistry();
}

/**
 * Normalise an effort level for a given model: applies the model's effort
 * aliases (e.g. `max → xhigh`). Returns the effort unchanged when no alias
 * applies.
 */
export function normalizeModelEffort(modelId: string, effort: EffortLevel): EffortLevel {
  const cap = getModelCapability(modelId);
  return cap.effortAliases[effort] ?? effort;
}

// ── Tier ranking + fallback selection (Task #230) ────────────────────────────

/**
 * Numeric ordering of tiers, highest-capability first. Used to find the
 * "next-best available tier" when a requested model is unavailable. `unknown`
 * ranks 0 so it is never chosen as a degradation target.
 */
export const TIER_RANK: Record<ModelTier, number> = {
  unknown: 0,
  haiku: 1,
  sonnet: 2,
  opus: 3,
  mythos: 4,
};

/**
 * Task #230 — pick the next-best *available* model to degrade to when the
 * requested model is unavailable / forbidden / not entitled.
 *
 * Selection rules:
 *  - Only models in a strictly lower tier than the requested model qualify
 *    (so an unavailable mythos model degrades to opus, opus → sonnet, etc.).
 *  - `accessGated` models are skipped — falling back to another gated model
 *    would just hit the same entitlement wall.
 *  - The `unknown` tier (rank 0) is never selected.
 *  - Anything in `exclude` (e.g. models already tried this run) is skipped.
 *  - Among candidates, the highest tier wins; ties break by id descending so a
 *    newer dated variant (`claude-opus-4-8`) is preferred over an older one
 *    (`claude-opus-4-6`).
 *
 * Returns `null` when no eligible fallback exists.
 */
export function selectFallbackModel(
  requestedModel: string,
  opts: { exclude?: readonly string[]; capabilities?: readonly ModelCapability[] } = {},
): ModelCapability | null {
  const caps = opts.capabilities ?? registry.list();
  const requestedRank = TIER_RANK[registry.resolve(requestedModel).tier];
  const excludeSet = new Set(
    [requestedModel, ...(opts.exclude ?? [])].map((m) => m.toLowerCase()),
  );

  const candidates = caps.filter((c) => {
    if (c.accessGated) return false;
    if (excludeSet.has(c.id.toLowerCase())) return false;
    const rank = TIER_RANK[c.tier];
    return rank > 0 && rank < requestedRank;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const rankDiff = TIER_RANK[b.tier] - TIER_RANK[a.tier];
    if (rankDiff !== 0) return rankDiff;
    return b.id.localeCompare(a.id);
  });

  return candidates[0] ?? null;
}

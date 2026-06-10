/**
 * @module models/model-discovery
 * Dynamic model discovery via the Anthropic /v1/models endpoint.
 * No hardcoded model names — always uses the live API to discover what's available.
 */

import { createLogger } from '../logging/logger.js';
import { inferModelTier, seedRegistryFromDiscovery, type ModelTier } from './model-registry.js';

const log = createLogger('model-discovery');

/** A model returned by the Anthropic API. */
export interface DiscoveredModel {
  /** Model identifier (e.g. 'claude-sonnet-4-6'). */
  id: string;
  /** Human-readable name (e.g. 'Claude Sonnet 4.6'). */
  displayName: string;
  /** ISO timestamp when the model was created. */
  createdAt: string;
  /** Inferred tier based on model family name. */
  tier: ModelTier;
}

/** Cached model list with TTL. */
let cachedModels: DiscoveredModel[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Infer the model tier from its ID.
 * Delegates to the model registry's {@link inferModelTier} so family detection
 * (incl. the `mythos` tier for fable models) lives in exactly one place.
 */
function inferTier(modelId: string): DiscoveredModel['tier'] {
  return inferModelTier(modelId);
}

/**
 * Fetch all available models from the Anthropic API.
 * Results are cached for 10 minutes.
 *
 * @param apiKey - Anthropic API key.
 * @returns Sorted array of discovered models (newest first).
 */
export async function discoverModels(apiKey: string): Promise<DiscoveredModel[]> {
  // Return cache if fresh
  if (cachedModels && Date.now() < cacheExpiry) {
    return cachedModels;
  }

  try {
    const allModels: DiscoveredModel[] = [];
    let hasMore = true;
    let afterId: string | undefined;

    while (hasMore) {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '100');
      if (afterId) url.searchParams.set('after_id', afterId);

      const res = await fetch(url.toString(), {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        log.warn(`Models endpoint returned ${res.status}`);
        break;
      }

      const data = (await res.json()) as {
        data: { id: string; display_name?: string; created_at?: string }[];
        has_more: boolean;
        last_id?: string;
      };

      for (const m of data.data) {
        allModels.push({
          id: m.id,
          displayName: m.display_name ?? m.id,
          createdAt: m.created_at ?? '',
          tier: inferTier(m.id),
        });
      }

      hasMore = data.has_more;
      afterId = data.last_id;
    }

    // Sort by created_at descending (newest first)
    allModels.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    cachedModels = allModels;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    // Seed the capability registry with anything we learned that isn't already
    // known (additive only — config/defaults keep precedence).
    seedRegistryFromDiscovery(allModels);

    log.debug(`Discovered ${allModels.length} models`);
    return allModels;
  } catch (err) {
    log.warn(`Model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return cachedModels ?? [];
  }
}

/**
 * Clear the model cache (e.g. after changing API keys).
 */
export function clearModelCache(): void {
  cachedModels = null;
  cacheExpiry = 0;
}

/**
 * Get the newest model of a given tier.
 * Falls back to the newest model of any tier if the requested tier isn't available.
 *
 * @param models - Discovered models (already sorted newest-first).
 * @param tier - Desired tier.
 * @returns The best matching model, or undefined if no models available.
 */
export function pickModelByTier(
  models: DiscoveredModel[],
  tier: 'opus' | 'sonnet' | 'haiku' | 'mythos',
): DiscoveredModel | undefined {
  return models.find((m) => m.tier === tier) ?? models[0];
}

/**
 * Build a model selection guide for the planner LLM.
 * This is injected into the planner prompt so it can pick real models.
 *
 * @param models - Discovered models.
 * @param mainModel - The model configured as the main/default agent model.
 * @returns A formatted string for the planner prompt.
 */
export function buildModelGuide(models: DiscoveredModel[], mainModel: string): string {
  if (models.length === 0) {
    return `Available models: Use "${mainModel}" for all workers (no model list available).`;
  }

  const grouped: Record<string, DiscoveredModel[]> = { mythos: [], opus: [], sonnet: [], haiku: [], unknown: [] };
  for (const m of models) {
    grouped[m.tier].push(m);
  }

  // Prefer the user's chosen main model as the canonical pick for its tier.
  // Otherwise the planner LLM will always reach for the *newest* model in each
  // tier, which can be a freshly-released model the rest of the toolchain
  // (Claude Code CLI, prompt parameters, billing) does not yet support.
  const mainTier = inferTier(mainModel);
  const preferredForTier = (tier: 'mythos' | 'opus' | 'sonnet' | 'haiku'): DiscoveredModel | undefined => {
    if (tier === mainTier) {
      const explicit = grouped[tier].find((m) => m.id === mainModel);
      if (explicit) return explicit;
    }
    return grouped[tier][0];
  };

  const lines: string[] = ['Available models (from Anthropic API — pick from this list only):'];

  const mythosBest = preferredForTier('mythos');
  if (mythosBest) {
    lines.push(`  - ${mythosBest.id} (${mythosBest.displayName}) — FLAGSHIP (mythos tier): the most capable model, above opus. Reserve for the hardest reasoning/planning. Adaptive thinking only. No temperature/top_p/top_k. May be access-gated.`);
  }
  const opusBest = preferredForTier('opus');
  if (opusBest) {
    lines.push(`  - ${opusBest.id} (${opusBest.displayName}) — HEAVYWEIGHT: superior complex reasoning, planning, creative writing, agentic coding. Adaptive thinking only. No temperature/top_p/top_k.`);
  }
  const sonnetBest = preferredForTier('sonnet');
  if (sonnetBest) {
    lines.push(`  - ${sonnetBest.id} (${sonnetBest.displayName}) — MIDWEIGHT: code generation, analysis, writing. Good default for most workers.`);
  }
  const haikuBest = preferredForTier('haiku');
  if (haikuBest) {
    lines.push(`  - ${haikuBest.id} (${haikuBest.displayName}) — LIGHTWEIGHT: data gathering, simple lookups, formatting. Fast and cheap.`);
  }

  lines.push('');
  lines.push('Model selection rules:');
  lines.push('  - Default to the midweight model (sonnet-tier) for most workers.');
  lines.push('  - Use lightweight (haiku-tier) for retrieval, data fetching, and simple transforms.');
  lines.push('  - Use heavyweight (opus-tier) only when the task genuinely requires deep reasoning.');
  lines.push('  - Use the flagship (mythos-tier) ONLY for the single hardest reasoning/planning step, if one is listed; it is the most expensive and may be access-gated.');
  lines.push('  - Opus-tier and mythos-tier models use adaptive thinking only — NEVER set temperature, top_p, or top_k for those workers.');
  lines.push('  - If multiple opus models are listed, prefer the newest (opus-4-8 over opus-4-6); opus-4-6 is the fallback when opus-4-8 is unavailable.');
  lines.push(`  - The main agent model is "${mainModel}" — use this as the fallback if unsure.`);
  lines.push('  - Pick model IDs ONLY from the list above. Do not invent newer or older variants.');

  return lines.join('\n');
}

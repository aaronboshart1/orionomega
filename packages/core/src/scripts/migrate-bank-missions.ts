/**
 * One-time migration: apply missions to all existing Hindsight banks.
 *
 * Run with:
 *   npx tsx src/scripts/migrate-bank-missions.ts [--url http://localhost:8888]
 *
 * Uses PATCH so only the specified fields are updated — existing bank
 * config (disposition traits, extraction mode, etc.) is preserved.
 */

import { HindsightClient } from '@orionomega/hindsight';
import { readConfig } from '../config/loader.js';

// ── Mission definitions ──────────────────────────────────────────────────────

const CORE_MISSIONS = {
  retain_mission:
    'Extract user preferences, communication style, technical expertise, cross-project decisions, ' +
    'lessons learned, infrastructure knowledge, and system configuration. ' +
    'Focus on information that persists across sessions and projects.',
  observations_mission:
    'Synthesize observations about user working patterns, preferred technologies, ' +
    'recurring decisions, cross-project themes, and system configuration state.',
  reflect_mission:
    'You are OrionOmega persistent memory. Answer questions about user preferences, ' +
    'past decisions, project history, and system knowledge using stored facts and observations. ' +
    'Cite specifics.',
  enable_observations: true,
};

const PROJECT_MISSIONS = {
  retain_mission:
    'Extract technical decisions, architecture choices, implementation patterns, ' +
    'code conventions, error resolutions, API contracts, and configuration from this project.',
  observations_mission:
    'Synthesize observations about project architecture, code patterns, conventions, ' +
    'known issues, deployment topology, and current state.',
  reflect_mission:
    'You are a project memory for a software engineering assistant. ' +
    'Answer using stored decisions and observations. ' +
    'Cite prior decisions. Say clearly when uncertain.',
  enable_observations: true,
};

const CONVERSATION_MISSIONS = {
  retain_mission:
    'Extract key topics, decisions, preferences, and action items from this conversation.',
  enable_observations: true,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(): string {
  const urlArg = process.argv.find((a) => a.startsWith('--url='))?.slice('--url='.length)
    ?? process.argv[process.argv.indexOf('--url') + 1];
  if (urlArg && urlArg.startsWith('http')) return urlArg;

  try {
    const config = readConfig();
    if (config.hindsight?.url) return config.hindsight.url;
  } catch {
    // fall through to default
  }

  return 'http://localhost:8888';
}

async function patchBank(
  baseUrl: string,
  bankId: string,
  missions: Record<string, unknown>,
): Promise<void> {
  const url = `${baseUrl}/v1/default/banks/${bankId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(missions),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      detail = String(body['error'] ?? body['message'] ?? res.statusText);
    } catch { /* ignore */ }
    throw new Error(`PATCH /v1/default/banks/${bankId} failed: ${res.status} ${detail}`);
  }
  // drain body
  await res.text();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
  const baseUrl = resolveUrl();
  console.log(`Connecting to Hindsight at ${baseUrl} …`);

  const client = new HindsightClient(baseUrl);

  let banks: Awaited<ReturnType<typeof client.listBanks>>;
  try {
    banks = await client.listBanks();
  } catch (err) {
    console.error('Failed to list banks:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Found ${banks.length} bank(s). Applying missions …\n`);

  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const bank of banks) {
    const { bank_id } = bank;

    let missions: Record<string, unknown> | null = null;
    if (bank_id === 'core') {
      missions = CORE_MISSIONS;
    } else if (bank_id.startsWith('project-')) {
      missions = PROJECT_MISSIONS;
    } else if (bank_id.startsWith('conversation-')) {
      missions = CONVERSATION_MISSIONS;
    }

    if (!missions) {
      console.log(`  [SKIP]    ${bank_id} — no mission template for this bank type`);
      skipped++;
      continue;
    }

    try {
      await patchBank(baseUrl, bank_id, missions);
      console.log(`  [UPDATED] ${bank_id}`);
      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR]   ${bank_id} — ${msg}`);
      errors.push(`${bank_id}: ${msg}`);
    }
  }

  console.log(`\nDone. ${updated} updated, ${skipped} skipped, ${errors.length} error(s).`);
  if (errors.length > 0) {
    process.exit(1);
  }
}

migrate().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

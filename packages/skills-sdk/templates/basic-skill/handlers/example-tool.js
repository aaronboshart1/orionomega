#!/usr/bin/env node
/**
 * Handler: basic_skill_example
 *
 * Protocol:
 *   Input  — JSON object on stdin  { query: string, action: "get"|"list", limit?: number }
 *   Output — JSON object on stdout { ...result } or { error: string }
 *   Exit     0 on success, non-zero on failure
 *
 * Environment variables:
 *   ORIONOMEGA_LOG_LEVEL        — log level from host process ("info", "verbose", "debug")
 *   SKILL_BASIC_SKILL_*         — config field values (if setup.fields defined in manifest)
 *
 * RULES:
 *   1. Read ALL stdin before processing (use async iteration)
 *   2. Write ONLY valid JSON to stdout
 *   3. Write debug/log output to stderr (never stdout)
 *   4. Validate required params and return { error } + exit 1 on failure
 *   5. Never hardcode credentials — read them from env vars
 */

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  // Step 1: Read all stdin
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  // Step 2: Parse JSON input
  let params;
  try {
    params = JSON.parse(raw);
  } catch (err) {
    writeError('Invalid JSON input');
    process.exit(1);
  }

  // Step 3: Extract and validate parameters
  const { query, action, limit = DEFAULT_LIMIT } = params;

  if (!query || typeof query !== 'string' || query.trim() === '') {
    writeError('query (string) is required');
    process.exit(1);
  }

  if (!action || !['get', 'list'].includes(action)) {
    writeError('action must be "get" or "list"');
    process.exit(1);
  }

  const clampedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

  // Step 4: Execute the operation
  try {
    let result;
    if (action === 'get') {
      result = await getItem(query);
    } else {
      result = await listItems(query, clampedLimit);
    }

    // Step 5: Write result JSON to stdout and exit 0
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    writeError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Write an error result to stdout.
 * NOTE: Do not call process.exit() here — callers decide whether to exit.
 * @param {string} message
 */
function writeError(message) {
  process.stdout.write(JSON.stringify({ error: message }));
}

/**
 * Get a single item by query.
 * Replace this with your real implementation.
 *
 * @param {string} query
 * @returns {Promise<object>}
 */
async function getItem(query) {
  // Example: fetch from an API
  // const res = await fetch(`https://api.example.com/items/${encodeURIComponent(query)}`, {
  //   headers: { Authorization: `Bearer ${process.env.SKILL_BASIC_SKILL_API_KEY}` },
  //   signal: AbortSignal.timeout(25_000),
  // });
  // if (!res.ok) throw new Error(`API error ${res.status}`);
  // return res.json();

  // Placeholder implementation:
  return {
    id: `item-${Date.now()}`,
    query,
    found: true,
  };
}

/**
 * List items matching a query.
 * Replace this with your real implementation.
 *
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<object>}
 */
async function listItems(query, limit) {
  // Placeholder implementation:
  return {
    items: [
      { id: 'item-1', name: `Result for "${query}" #1` },
      { id: 'item-2', name: `Result for "${query}" #2` },
    ],
    count: 2,
    limit,
    query,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────────

main().catch(err => {
  // Last-resort catch — should not normally be reached
  process.stdout.write(JSON.stringify({ error: `Unexpected error: ${String(err)}` }));
  process.exit(1);
});

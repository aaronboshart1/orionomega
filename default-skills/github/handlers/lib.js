/**
 * Shared utilities for GitHub skill handlers.
 * Wraps `gh` CLI with structured output, error handling, and truncation.
 */

import { execFileSync } from 'node:child_process';

const MAX_OUTPUT = 30_000; // chars
const GH_TIMEOUT = 25_000; // ms

/**
 * Run a `gh` CLI command and return parsed JSON or text output.
 * @param {string[]} args - Arguments to pass to `gh`.
 * @param {object} opts - Options.
 * @param {boolean} opts.json - Whether to request JSON output.
 * @param {string[]} opts.jsonFields - Fields for --json flag.
 * @param {string} opts.jq - jq filter for JSON output.
 * @param {Record<string, string>} opts.env - Extra environment variables.
 * @param {string} opts.input - stdin input.
 * @returns {{ ok: boolean, data?: any, text?: string, error?: string }}
 */
export function gh(args, opts = {}) {
  const fullArgs = [...args];

  if (opts.json && opts.jsonFields?.length) {
    fullArgs.push('--json', opts.jsonFields.join(','));
    if (opts.jq) fullArgs.push('--jq', opts.jq);
  }

  try {
    const result = execFileSync('gh', fullArgs, {
      encoding: 'utf-8',
      timeout: GH_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, ...opts.env, GH_FORCE_TTY: '0', NO_COLOR: '1' },
      input: opts.input,
    }).trim();

    // Try to parse as JSON
    if (opts.json || result.startsWith('[') || result.startsWith('{')) {
      try {
        return { ok: true, data: JSON.parse(result) };
      } catch {
        // Not JSON, return as text
      }
    }

    return { ok: true, text: truncate(result) };
  } catch (err) {
    const msg = err.stderr?.trim() || err.message || String(err);
    return { ok: false, error: truncate(msg, 2000) };
  }
}

/**
 * Read JSON from stdin (handler protocol).
 * @returns {Promise<object>}
 */
export async function readParams() {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Write result to stdout and exit.
 * @param {object} result
 */
export function respond(result) {
  process.stdout.write(JSON.stringify(result));
}

/**
 * Respond with an error and exit 1.
 * @param {string} message
 */
export function fail(message) {
  respond({ error: message });
  process.exit(1);
}

/**
 * Truncate long text with an indicator.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max = MAX_OUTPUT) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated, ${text.length - max} chars omitted]`;
}

/**
 * Build --repo flag if repo is provided.
 * @param {string|undefined} repo
 * @returns {string[]}
 */
export function repoFlag(repo) {
  return repo ? ['--repo', repo] : [];
}

/**
 * Build --limit flag if provided.
 * @param {number|undefined} limit
 * @param {number} defaultLimit
 * @returns {string[]}
 */
export function limitFlag(limit, defaultLimit = 30) {
  return ['--limit', String(limit ?? defaultLimit)];
}

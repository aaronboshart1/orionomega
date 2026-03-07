/**
 * Shared utilities for Linear skill handlers.
 * Wraps Linear GraphQL API with structured output, error handling, and truncation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LINEAR_API = 'https://api.linear.app/graphql';
const MAX_OUTPUT = 30_000; // chars
const TIMEOUT = 25_000; // ms

/**
 * Get the Linear API key from skill config or environment.
 * @returns {string|null}
 */
export function getApiKey() {
  // 1. Environment variable
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;

  // 2. Skill config
  const configPath = join(homedir(), '.orionomega', 'skills', 'linear', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.fields?.LINEAR_API_KEY) return config.fields.LINEAR_API_KEY;
    } catch {}
  }

  return null;
}

/**
 * Execute a GraphQL query against the Linear API.
 * @param {string} query - GraphQL query or mutation string.
 * @param {object} variables - GraphQL variables.
 * @returns {Promise<{ ok: boolean, data?: any, errors?: any[], error?: string }>}
 */
export async function linear(query, variables = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, error: 'Linear API key not configured. Run: orionomega skill setup linear' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
    }

    const json = await res.json();

    if (json.errors?.length) {
      return { ok: false, errors: json.errors, error: json.errors.map(e => e.message).join('; ') };
    }

    return { ok: true, data: json.data };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Request timed out after 25s' };
    }
    return { ok: false, error: err.message ?? String(err) };
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
 * Write result to stdout.
 * @param {object} result
 */
export function respond(result) {
  process.stdout.write(JSON.stringify(result));
}

/**
 * Respond with error and exit.
 * @param {string} message
 */
export function fail(message) {
  respond({ error: message });
  process.exit(1);
}

/**
 * Truncate long text.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max = MAX_OUTPUT) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated, ${text.length - max} chars omitted]`;
}

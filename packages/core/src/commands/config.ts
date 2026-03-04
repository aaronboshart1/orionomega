/**
 * @module commands/config
 * Read, write, and edit OrionOmega configuration.
 */

import { execSync } from 'node:child_process';
import { readConfig, writeConfig, getConfigPath } from '../config/index.js';
import type { OrionOmegaConfig } from '../config/index.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Resolve a dot-notation key to a value in a nested object.
 */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a dot-notation key in a nested object.
 */
function setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Coerce a string value to the appropriate type.
 */
function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

/**
 * Handle config subcommands: open editor, get, set.
 */
export async function runConfig(args: string[]): Promise<void> {
  const sub = args[0];
  const configPath = getConfigPath();

  // No sub → open in editor
  if (!sub) {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    process.stdout.write(`${DIM}Opening ${configPath} in ${editor}...${RESET}\n`);
    try {
      execSync(`${editor} ${configPath}`, { stdio: 'inherit' });
    } catch {
      process.stdout.write(`${RED}✗${RESET} Failed to open editor\n`);
    }
    return;
  }

  if (sub === 'get') {
    const key = args[1];
    if (!key) {
      process.stdout.write(`${RED}✗${RESET} Usage: orionomega config get <key>\n`);
      process.stdout.write(`  ${DIM}Example: orionomega config get gateway.port${RESET}\n`);
      return;
    }
    const config = readConfig();
    const value = getNestedValue(config as unknown as Record<string, unknown>, key);
    if (value === undefined) {
      process.stdout.write(`${RED}✗${RESET} Key "${key}" not found\n`);
    } else if (typeof value === 'object') {
      process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    } else {
      process.stdout.write(String(value) + '\n');
    }
    return;
  }

  if (sub === 'set') {
    const key = args[1];
    const rawValue = args.slice(2).join(' ');
    if (!key || rawValue === '') {
      process.stdout.write(`${RED}✗${RESET} Usage: orionomega config set <key> <value>\n`);
      process.stdout.write(`  ${DIM}Example: orionomega config set gateway.port 8080${RESET}\n`);
      return;
    }
    const config = readConfig();
    const configObj = config as unknown as Record<string, unknown>;
    const coerced = coerce(rawValue);
    setNestedValue(configObj, key, coerced);
    writeConfig(configObj as unknown as OrionOmegaConfig);
    process.stdout.write(`${GREEN}✓${RESET} ${key} = ${JSON.stringify(coerced)}\n`);
    return;
  }

  process.stdout.write(`\n${BOLD}Usage:${RESET} orionomega config [get <key> | set <key> <value>]\n`);
  process.stdout.write(`  ${DIM}No arguments opens the config file in $EDITOR${RESET}\n\n`);
}

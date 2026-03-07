/**
 * @module commands/setup
 * Interactive setup wizard for OrionOmega.
 * Uses Node's built-in readline — no external prompt libraries.
 */

import * as readline from 'node:readline';

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { readConfig, writeConfig, getConfigPath, getDefaultConfig } from '../config/index.js';
import type { OrionOmegaConfig } from '../config/index.js';

// ── Colour helpers ──────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function print(msg: string): void { process.stdout.write(msg); }
function println(msg: string = ''): void { process.stdout.write(msg + '\n'); }
function success(msg: string): void { println(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg: string): void { println(`${RED}✗${RESET} ${msg}`); }
function warn(msg: string): void { println(`${YELLOW}⚠${RESET} ${msg}`); }
function heading(msg: string): void { println(`\n${BOLD}${BLUE}${msg}${RESET}\n`); }

// ── Readline helpers ────────────────────────────────────────────

let rl: readline.Interface;

function initRL(): void {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function closeRL(): void {
  rl.close();
}

/**
 * Prompt for text input. Supports masked input for passwords.
 * For masked input, temporarily swaps rl.output to a muted stream
 * and intercepts line events to show dots.
 */
function ask(question: string, opts?: { mask?: boolean; default?: string }): Promise<string> {
  return new Promise((resolve) => {
    const suffix = opts?.default ? ` ${DIM}(${opts.default})${RESET}` : '';
    const prompt = `${question}${suffix}: `;

    if (opts?.mask) {
      // Use raw mode to read input character-by-character.
      // This handles both typed and pasted input correctly.
      print(prompt);

      const wasRaw = process.stdin.isRaw;
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      let input = '';
      const onData = (buf: Buffer): void => {
        for (const byte of buf) {
          // Enter (CR or LF)
          if (byte === 13 || byte === 10) {
            process.stdin.removeListener('data', onData);
            if (process.stdin.isTTY) {
              process.stdin.setRawMode(wasRaw ?? false);
            }
            println(); // newline after input
            if (input.length > 0) {
              println(`  ${DIM}(${input.length} characters received)${RESET}`);
            }
            resolve(input.trim());
            return;
          }
          // Backspace (127 or 8)
          if (byte === 127 || byte === 8) {
            if (input.length > 0) {
              input = input.slice(0, -1);
              print('\b \b');
            }
            continue;
          }
          // Ctrl+C
          if (byte === 3) {
            println();
            process.exit(1);
          }
          // Printable characters
          if (byte >= 32) {
            input += String.fromCharCode(byte);
            print('\u2022');
          }
        }
      };
      process.stdin.on('data', onData);
    } else {
      rl.question(prompt, (answer: string) => {
        const val = answer.trim() || opts?.default || '';
        resolve(val);
      });
    }
  });
}

/**
 * Prompt user to select from a numbered list.
 */
function choose(question: string, options: { label: string; value: string }[]): Promise<string> {
  return new Promise((resolve) => {
    println(question);
    for (let i = 0; i < options.length; i++) {
      println(`  ${BOLD}${i + 1}${RESET}) ${options[i].label}`);
    }
    rl.question(`\nChoice [1-${options.length}]: `, (answer: string) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx].value);
      } else {
        // Default to first option
        resolve(options[0].value);
      }
    });
  });
}

/**
 * Yes/No confirmation.
 */
function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    rl.question(`${question} [${hint}]: `, (answer: string) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

// ── Steps ───────────────────────────────────────────────────────

async function stepApiKey(config: OrionOmegaConfig): Promise<void> {
  heading('Step 1/5 — Anthropic API Key');

  const key = await ask('Enter your Anthropic API key');

  if (!key.startsWith('sk-ant-')) {
    fail('Key must start with "sk-ant-". Skipping validation.');
    config.models.apiKey = key; // store anyway
    return;
  }

  config.models.apiKey = key;
  print(`  Testing key... `);

  try {
    // Validate key via models endpoint — no hardcoded model IDs needed
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });

    if (res.ok) {
      success('API key is valid!');
    } else {
      const body = await res.text();
      fail(`API returned ${res.status}: ${body.slice(0, 120)}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Network error: ${msg}`);
  }
}

async function fetchAnthropicModels(apiKey: string): Promise<{ label: string; value: string }[]> {
  try {
    print(`  Fetching available models... `);
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      println(`${YELLOW}(could not fetch: ${res.status})${RESET}`);
      return [];
    }

    const data = (await res.json()) as { data?: { id: string; display_name?: string; created_at?: string }[] };
    const models = data.data ?? [];

    if (models.length === 0) {
      println(`${YELLOW}(no models returned)${RESET}`);
      return [];
    }

    // Sort by creation date descending (newest first), then alphabetically
    models.sort((a, b) => {
      const da = a.created_at ?? '';
      const db = b.created_at ?? '';
      if (da !== db) return db.localeCompare(da);
      return a.id.localeCompare(b.id);
    });

    println(`${GREEN}found ${models.length} models${RESET}`);

    return models.map((m) => {
      const name = m.display_name || m.id;
      // Tag recommended models
      let suffix = '';
      if (m.id.includes('sonnet')) suffix = ` ${DIM}(recommended)${RESET}`;
      return { label: `${name}${suffix}`, value: m.id };
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    println(`${YELLOW}(error: ${msg})${RESET}`);
    return [];
  }
}

async function stepModel(config: OrionOmegaConfig): Promise<void> {
  heading('Step 2/5 — Default Model');

  // Always discover models from the API — no hardcoded fallback list
  let options: { label: string; value: string }[] = [];

  if (config.models.apiKey) {
    process.stdout.write(`  Fetching models from Anthropic API... `);
    try {
      const { discoverModels } = await import('../models/model-discovery.js');
      const models = await discoverModels(config.models.apiKey);
      if (models.length > 0) {
        println(`${GREEN}found ${models.length} models${RESET}`);
        options = models.map((m) => {
          let suffix = '';
          if (m.tier === 'sonnet') suffix = ` ${DIM}(recommended for default)${RESET}`;
          else if (m.tier === 'haiku') suffix = ` ${DIM}(lightweight)${RESET}`;
          else if (m.tier === 'opus') suffix = ` ${DIM}(heavyweight)${RESET}`;
          return { label: `${m.displayName}${suffix}`, value: m.id };
        });
      } else {
        println(`${YELLOW}no models returned${RESET}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      println(`${YELLOW}(error: ${msg})${RESET}`);
    }
  }

  if (options.length === 0) {
    // If API discovery failed, let user enter manually
    println(`  ${YELLOW}Could not discover models. You can enter a model ID manually.${RESET}`);
    const model = await ask('Enter model ID');
    config.models.default = model;
    config.models.planner = model;
    success(`Default model: ${model}`);
    return;
  }

  // Also allow manual entry
  options.push({ label: `${DIM}Enter a model ID manually${RESET}`, value: '__custom__' });

  let model = await choose('Select your default model:', options);

  if (model === '__custom__') {
    model = await ask('Enter model ID');
  }

  config.models.default = model;
  config.models.planner = model;
  success(`Default model: ${model}`);
}

async function stepGatewaySecurity(config: OrionOmegaConfig): Promise<void> {
  heading('Step 3/5 — Gateway Security');

  const mode = await choose('Authentication mode for the gateway:', [
    { label: 'API Key authentication', value: 'api-key' },
    { label: `No authentication ${DIM}(local use only)${RESET}`, value: 'none' },
  ]);

  config.gateway.auth.mode = mode as 'api-key' | 'none';

  if (mode === 'api-key') {
    let password = '';
    while (password.length < 8) {
      password = await ask('Enter a gateway API key (min 8 characters)', { mask: true });
      if (password.length < 8) {
        warn('Key must be at least 8 characters. Try again.');
      }
    }

    const hash = createHash('sha256').update(password).digest('hex');
    config.gateway.auth.keyHash = hash;
    println();
    println(`  ${BOLD}Your gateway API key:${RESET} ${password}`);
    println(`  ${DIM}Save this somewhere safe — it's hashed in config.${RESET}`);
    success('Gateway auth configured.');
  } else {
    success('No authentication. Ensure the gateway is not exposed publicly.');
  }
}

async function stepHindsight(config: OrionOmegaConfig): Promise<void> {
  heading('Step 4/5 — Hindsight Memory');

  const mode = await choose('Hindsight server:', [
    { label: `Local ${DIM}(localhost:8888)${RESET}`, value: 'local' },
    { label: 'Remote (custom URL)', value: 'remote' },
  ]);

  let url = 'http://localhost:8888';
  if (mode === 'remote') {
    url = await ask('Hindsight URL', { default: 'http://localhost:8888' });
  }
  config.hindsight.url = url;

  print('  Testing connection... ');
  try {
    const res = await fetch(`${url}/v1/default/banks`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      success('Hindsight is reachable!');

      // Create default memory bank
      print('  Creating default memory bank... ');
      try {
        const bankRes = await fetch(`${url}/v1/default/banks`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bank_id: config.hindsight.defaultBank }),
        });
        if (bankRes.ok || bankRes.status === 409) {
          success('Memory bank ready.');
        } else {
          warn(`Bank creation returned ${bankRes.status} — may already exist.`);
        }
      } catch {
        warn('Could not create memory bank. You can do this later.');
      }
    } else {
      fail(`Hindsight returned ${res.status}. You can configure it later.`);
    }
  } catch {
    fail('Hindsight is not reachable. You can start it later.');
  }
}

async function stepWorkspace(config: OrionOmegaConfig): Promise<void> {
  heading('Step 5/5 — Workspace');

  const defaultPath = join(homedir(), '.orionomega', 'workspace');
  const wsPath = await ask('Workspace directory', { default: defaultPath });
  config.workspace.path = wsPath;

  // Create directory structure
  const dirs = ['', 'output', 'memory', 'progress', 'orchestration'];
  for (const d of dirs) {
    const p = join(wsPath, d);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
    }
  }
  success('Workspace directories created.');

  // Write template files (only if they don't already exist)
  const templates: Record<string, string> = {
    'SOUL.md': SOUL_TEMPLATE,
    'USER.md': USER_TEMPLATE,
    'TOOLS.md': TOOLS_TEMPLATE,
  };

  for (const [name, content] of Object.entries(templates)) {
    const filePath = join(wsPath, name);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, 'utf-8');
      println(`  ${DIM}Created ${name}${RESET}`);
    } else {
      println(`  ${DIM}${name} already exists — skipped${RESET}`);
    }
  }
}

// ── Template content ────────────────────────────────────────────

const SOUL_TEMPLATE = `# SOUL.md — Agent Personality

Define how your OrionOmega agent speaks and behaves.

## Name
<!-- Give your agent a name -->

## Tone
<!-- Examples: dry wit, warm and friendly, all business, playful -->

## Style
<!-- Concise? Verbose? Technical? Casual? -->

## Rules
<!-- What should the agent always/never do? -->

---
Edit this file to make the agent yours.
`;

const USER_TEMPLATE = `# USER.md — About You

Help your agent understand who you are.

- **Name:**
- **Timezone:**
- **Preferences:**

## Context
<!-- What are you working on? What matters to you? -->
`;

const TOOLS_TEMPLATE = `# TOOLS.md — Environment Notes

Your personal cheat sheet for environment-specific details.

## SSH Hosts
<!-- - server-name → IP, user, notes -->

## API Keys
<!-- - service → key location or notes -->

## Custom Notes
<!-- Anything that helps your agent help you -->
`;

// ── Main ────────────────────────────────────────────────────────

/**
 * Run the interactive setup wizard.
 */
export async function runSetup(): Promise<void> {
  println();
  println(`${BOLD}╔══════════════════════════════════════╗${RESET}`);
  println(`${BOLD}║     OrionOmega — Setup Wizard        ║${RESET}`);
  println(`${BOLD}╚══════════════════════════════════════╝${RESET}`);

  const config = getDefaultConfig();

  initRL();

  try {
    await stepApiKey(config);
    await stepModel(config);
    await stepGatewaySecurity(config);
    await stepHindsight(config);
    await stepWorkspace(config);

    // Also ensure skills & logs directories exist
    if (!existsSync(config.skills.directory)) {
      mkdirSync(config.skills.directory, { recursive: true });
    }

    // Install default skills (web-search, web-fetch, etc.) if not already present
    try {
      const defaultSkillsBase = join(homedir(), '.orionomega', 'skills');
      const repoRoot = new URL('../../../../', import.meta.url).pathname;
      const defaultSkillsDir = join(repoRoot, 'default-skills');
      if (existsSync(defaultSkillsDir)) {
        const { readdirSync, cpSync } = await import('node:fs');
        const skillNames = readdirSync(defaultSkillsDir);
        let installed = 0;
        for (const skillName of skillNames) {
          const src = join(defaultSkillsDir, skillName);
          const dest = join(config.skills.directory, skillName);
          if (!existsSync(dest)) {
            cpSync(src, dest, { recursive: true });
            execSync('find ' + dest + '/handlers -name "*.js" -exec chmod +x {} ; 2>/dev/null || true');
            println('  ${DIM}Installed default skill: ' + skillName + '${RESET}');
            installed++;
          }
        }
        if (installed > 0) {
          success('Installed ' + installed + ' default skill(s): ' + skillNames.filter(n => existsSync(join(config.skills.directory, n))).join(', '));
        }
      }
    } catch (err) {
      warn('Could not install default skills: ' + (err instanceof Error ? err.message : String(err)));
    }
    const logDir = join(homedir(), '.orionomega', 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Save config
    writeConfig(config);

    // Auto-restart gateway if it's running so it picks up the new config
    try {
      const out = execSync('systemctl is-active orionomega 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (out === 'active') {
        print('  Restarting gateway to apply new config... ');
        execSync('systemctl restart orionomega', { stdio: 'ignore' });
        println(`${GREEN}✓${RESET} Gateway restarted`);
      }
    } catch {
      // Gateway not running via systemd — check dev mode PID
      try {
        const pidFile = join(homedir(), '.orionomega', 'gateway.pid');
        if (existsSync(pidFile)) {
          print('  Restarting gateway to apply new config... ');
          const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
          if (!isNaN(pid)) {
            try { process.kill(pid, 'SIGTERM'); } catch {}
          }
          println(`${YELLOW}⚠${RESET} Gateway was stopped. Run: orionomega gateway start`);
        }
      } catch {}
    }

    heading('Setup Complete!');
    success(`Config saved to ${getConfigPath()}`);
    println();
    println(`  ${BOLD}Next steps:${RESET}`);
    println(`  1. Start the gateway:  ${BLUE}orionomega gateway start${RESET}`);
    println(`  2. Check health:       ${BLUE}orionomega status${RESET}`);
    println(`  3. Launch the TUI:     ${BLUE}orionomega tui${RESET}`);
    println(`  4. Or the web UI:      ${BLUE}orionomega ui${RESET}`);
    println();
    println(`  Edit your workspace files to personalize the agent:`);
    println(`  ${DIM}${config.workspace.path}/SOUL.md${RESET}`);
    println(`  ${DIM}${config.workspace.path}/USER.md${RESET}`);
    println(`  ${DIM}${config.workspace.path}/TOOLS.md${RESET}`);
    println();
  } finally {
    closeRL();
  }
}

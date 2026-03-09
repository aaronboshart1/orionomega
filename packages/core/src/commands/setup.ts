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
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { SkillManifest, SkillConfig, SkillAuthMethod, SkillSetupField } from '@orionomega/skills-sdk';

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
  heading('Step 1/7 — Anthropic API Key');

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
  heading('Step 2/7 — Default Model');

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
  heading('Step 3/7 — Gateway Security');

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
  heading('Step 4/7 — Hindsight Memory');

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
  heading('Step 5/7 — Workspace');

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

// ── Step 7: Skills ──────────────────────────────────────────────

async function stepSkills(config: OrionOmegaConfig): Promise<void> {
  heading("Step 7/7 — Skills");

  // Discover all available skills from both default-skills and user skills dir
  const skillsDirs: string[] = [];
  const repoRoot = new URL("../../../../", import.meta.url).pathname;
  const defaultSkillsDir = join(repoRoot, "default-skills");
  if (existsSync(defaultSkillsDir)) skillsDirs.push(defaultSkillsDir);
  if (existsSync(config.skills.directory)) skillsDirs.push(config.skills.directory);

  const allManifests: SkillManifest[] = [];
  const seen = new Set<string>();
  for (const dir of skillsDirs) {
    try {
      const loader = new SkillLoader(dir);
      const manifests = await loader.discoverAll();
      for (const m of manifests) {
        if (!seen.has(m.name)) {
          seen.add(m.name);
          allManifests.push(m);
        }
      }
    } catch {}
  }

  if (allManifests.length === 0) {
    println("  No skills found. You can install skills later with: orionomega skill install <path>");
    return;
  }

  println("  Available skills:");
  println();
  for (let i = 0; i < allManifests.length; i++) {
    const m = allManifests[i];
    const setupTag = m.setup?.required ? " (requires setup)" : "";
    println("  " + BOLD + (i + 1) + RESET + ") " + m.name + " — " + m.description + DIM + setupTag + RESET);
  }
  println();

  const selection = await ask("Enable which skills? (comma-separated numbers, or 'all')", { default: "all" });

  let selectedIndices: number[];
  if (selection.toLowerCase() === "all") {
    selectedIndices = allManifests.map((_, i) => i);
  } else {
    selectedIndices = selection.split(",").map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0 && i < allManifests.length);
  }

  if (selectedIndices.length === 0) {
    warn("No skills selected.");
    return;
  }

  const selected = selectedIndices.map(i => allManifests[i]);
  success("Selected: " + selected.map(m => m.name).join(", "));

  // Install default skills to user directory if not present
  for (const m of selected) {
    const dest = join(config.skills.directory, m.name);
    const src = join(defaultSkillsDir, m.name);
    if (!existsSync(dest) && existsSync(src)) {
      const { cpSync } = await import("node:fs");
      cpSync(src, dest, { recursive: true });
      println("  " + DIM + "Installed: " + m.name + RESET);
    }
  }

  // Disable skills that were NOT selected
  for (const m of allManifests) {
    if (!selected.find(s => s.name === m.name)) {
      const cfg = readSkillConfig(config.skills.directory, m.name);
      cfg.enabled = false;
      writeSkillConfig(config.skills.directory, cfg);
    }
  }

  // Run setup for each selected skill that requires it
  for (const m of selected) {
    const cfg = readSkillConfig(config.skills.directory, m.name);
    cfg.enabled = true;

    if (m.setup?.required && !cfg.configured) {
      println();
      heading("  Skill Setup: " + m.name);
      if (m.setup.description) println("  " + m.setup.description);
      println();

      // Auth method selection
      if (m.setup.auth?.methods?.length) {
        const authResult = await runAuthSetup(m.setup.auth.methods, config.skills.directory, m.name);
        if (authResult) {
          cfg.authMethod = authResult;
        }
      }

      // Config fields
      if (m.setup.fields?.length) {
        for (const field of m.setup.fields) {
          const value = await promptField(field);
          if (value !== undefined && value !== "") {
            cfg.fields[field.name] = value;
          }
        }
      }

      // Run setup handler if present
      if (m.setup.handler) {
        const handlerPath = join(config.skills.directory, m.name, m.setup.handler);
        if (existsSync(handlerPath)) {
          print("  Running setup validation... ");
          try {
            const result = execSync("node " + handlerPath, {
              encoding: "utf-8",
              timeout: 30000,
              input: JSON.stringify(cfg),
              env: { ...process.env },
            }).trim();
            // Handler can return updated config fields
            try {
              const updates = JSON.parse(result);
              if (updates.fields) Object.assign(cfg.fields, updates.fields);
              if (updates.authMethod) cfg.authMethod = updates.authMethod;
            } catch {}
            success("Validation passed.");
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            fail("Setup handler failed: " + msg);
          }
        }
      }

      cfg.configured = true;
      cfg.configuredAt = new Date().toISOString();
    } else {
      cfg.enabled = true;
      if (!cfg.configured && !m.setup?.required) {
        cfg.configured = true;
        cfg.configuredAt = new Date().toISOString();
      }
    }

    writeSkillConfig(config.skills.directory, cfg);
  }

  success("Skills configured.");
}

/**
 * Run interactive auth method selection.
 */
async function runAuthSetup(methods: SkillAuthMethod[], skillsDir: string, skillName: string): Promise<string | undefined> {
  if (methods.length === 1) {
    println("  Auth: " + methods[0].label);
  }

  const options = methods.map(m => ({ label: m.label + (m.description ? " — " + DIM + m.description + RESET : ""), value: m.type }));
  const chosen = methods.length === 1 ? methods[0].type : await choose("  Choose authentication method:", options);
  const method = methods.find(m => m.type === chosen);
  if (!method) return undefined;

  switch (method.type) {
    case "oauth":
    case "login": {
      if (method.command) {
        println("  Running: " + BOLD + method.command + RESET);
        try {
          execSync(method.command, { stdio: "inherit", timeout: 120000 });
          success("Authentication complete.");
        } catch {
          fail("Authentication command failed. You can retry with: orionomega skill setup " + skillName);
        }
      }
      break;
    }
    case "pat":
    case "api-key": {
      if (method.tokenUrl) {
        println("  Generate a token at: " + BLUE + method.tokenUrl + RESET);
        if (method.scopes?.length) {
          println("  Required scopes: " + method.scopes.join(", "));
        }
      }
      const token = await ask("  Enter your " + (method.type === "pat" ? "personal access token" : "API key"), { mask: true });
      if (token && method.envVar) {
        // Write to skill config fields
        const cfg = readSkillConfig(skillsDir, skillName);
        cfg.fields[method.envVar] = token;
        writeSkillConfig(skillsDir, cfg);
        println("  " + DIM + "Stored in skill config as " + method.envVar + RESET);
      }
      break;
    }
    case "env": {
      if (method.envVar) {
        if (process.env[method.envVar]) {
          success(method.envVar + " is already set.");
        } else {
          warn(method.envVar + " is not set. Set it in your shell profile.");
        }
      }
      break;
    }
    case "ssh-key": {
      println("  Ensure your SSH key is configured for this service.");
      break;
    }
  }

  // Validate if validateCommand is present
  if (method.validateCommand) {
    print("  Validating... ");
    try {
      execSync(method.validateCommand, { encoding: "utf-8", timeout: 15000, stdio: "pipe" });
      success("Auth is valid!");
    } catch {
      fail("Validation failed. You can retry with: orionomega skill setup " + skillName);
    }
  }

  return method.type;
}

/**
 * Prompt for a single config field value.
 */
async function promptField(field: SkillSetupField): Promise<string | number | boolean | undefined> {
  const defaultStr = field.default !== undefined ? String(field.default) : undefined;

  if (field.type === "boolean") {
    return await confirm("  " + field.label + (field.description ? " (" + field.description + ")" : ""), field.default as boolean ?? true);
  }

  if (field.type === "select" && field.options?.length) {
    return await choose("  " + field.label + ":", field.options);
  }

  const raw = await ask("  " + field.label + (field.description ? " (" + field.description + ")" : ""), {
    mask: field.mask,
    default: defaultStr,
  });

  if (field.type === "number") return parseFloat(raw) || ((field.default as number) ?? 0);
  return raw;
}

// ── Main ────────────────────────────────────────────────────────

async function stepAgentSdk(config: OrionOmegaConfig): Promise<void> {
  heading('Step 6/7 — Claude Agent SDK (Coding Agents)');

  println(`  The Claude Agent SDK powers coding tasks in workflows.`);
  println(`  It uses the same Anthropic API key configured in Step 1.`);
  println(`  When enabled, the orchestrator can spawn CODING_AGENT workers`);
  println(`  with the full Claude Code toolset (Read, Write, Edit, Bash, etc.).`);
  println();

  const enable = await ask('Enable Claude Agent SDK?', { default: 'yes' });
  const enabled = enable.toLowerCase().startsWith('y');
  config.agentSdk.enabled = enabled;

  if (!enabled) {
    println(`  ${DIM}Agent SDK disabled. Coding tasks will use generic AGENT workers.${RESET}`);
    return;
  }

  // Permission mode
  const permOptions = [
    { label: `Accept file edits automatically ${DIM}(recommended)${RESET}`, value: 'acceptEdits' },
    { label: 'Bypass all permissions (caution!)', value: 'bypassPermissions' },
    { label: 'Require approval for each tool', value: 'default' },
  ];
  config.agentSdk.permissionMode = (await choose(
    'Permission mode for coding agents:', permOptions,
  )) as OrionOmegaConfig['agentSdk']['permissionMode'];

  // Effort level
  const effortOptions = [
    { label: `High ${DIM}(recommended — good balance of thoroughness and speed)${RESET}`, value: 'high' },
    { label: 'Max (deepest reasoning, slowest)', value: 'max' },
    { label: 'Medium (faster, less thorough)', value: 'medium' },
    { label: 'Low (fastest, minimal reasoning)', value: 'low' },
  ];
  config.agentSdk.effort = (await choose(
    'Effort level:', effortOptions,
  )) as OrionOmegaConfig['agentSdk']['effort'];

  // Max budget
  const budget = await ask('Max budget per coding task (USD, 0 for unlimited)', { default: '0' });
  const budgetNum = parseFloat(budget);
  if (budgetNum > 0) config.agentSdk.maxBudgetUsd = budgetNum;

  success(`Agent SDK configured: ${config.agentSdk.permissionMode}, effort=${config.agentSdk.effort}`);
}

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
    await stepAgentSdk(config);
    await stepSkills(config);

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
        execSync('sudo systemctl restart orionomega', { stdio: 'ignore' });
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

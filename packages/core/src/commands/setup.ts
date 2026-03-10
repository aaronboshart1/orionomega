/**
 * @module commands/setup
 * Interactive setup wizard for OrionOmega.
 * Step-based navigator: back / redo / quit available at every step.
 * Auth failures offer retry / skip / continue options.
 * No input masking — all prompts are plain text.
 */

import * as readline from 'node:readline';

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { writeConfig, getConfigPath, getDefaultConfig } from '../config/index.js';
import type { OrionOmegaConfig } from '../config/index.js';
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { SkillManifest, SkillAuthMethod, SkillSetupField } from '@orionomega/skills-sdk';
import { githubDeviceFlowAuth, isGhWebAuthCommand, extractGitProtocol } from './github-device-auth.js';

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
 * Prompt for plain text input (no masking).
 */
function ask(question: string, opts?: { default?: string }): Promise<string> {
  return new Promise((resolve) => {
    const suffix = opts?.default ? ` ${DIM}(${opts.default})${RESET}` : '';
    const prompt = `${question}${suffix}: `;
    rl.question(prompt, (answer: string) => {
      resolve(answer.trim() || opts?.default || '');
    });
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
      resolve(idx >= 0 && idx < options.length ? options[idx].value : options[0].value);
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
      resolve(a === '' ? defaultYes : a === 'y' || a === 'yes');
    });
  });
}

// ── Navigation ──────────────────────────────────────────────────

/** Action returned by each wizard step. */
type StepAction = 'next' | 'back' | 'redo' | 'quit';

/**
 * Show the step navigation bar and return the user's choice.
 * Displayed after each step completes (success or with errors).
 */
async function nav(stepIdx: number, totalSteps: number): Promise<StepAction> {
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === totalSteps - 1;
  const nextWord = isLast ? 'finish' : 'continue';

  println(`\n${DIM}──────────────────────────────────────────────────${RESET}`);
  const parts: string[] = [`${BOLD}↵${RESET} ${nextWord}`];
  if (!isFirst) parts.push(`${BOLD}b${RESET} back`);
  parts.push(`${BOLD}r${RESET} redo`, `${BOLD}q${RESET} quit`);
  println(`  ${parts.join('   ·   ')}`);

  for (;;) {
    const input = await ask(' ');
    const a = input.toLowerCase().trim();
    if (a === '' || a === 'n' || a === 'f' || a === 'c') return 'next';
    if (a === 'b' && !isFirst) return 'back';
    if (a === 'r') return 'redo';
    if (a === 'q') {
      const yes = await confirm('Exit setup without saving?', false);
      if (yes) return 'quit';
      println(`\n${DIM}──────────────────────────────────────────────────${RESET}`);
      println(`  ${parts.join('   ·   ')}`);
    } else if (a !== '') {
      warn(`Unknown input. Press Enter to ${nextWord}, b=back, r=redo, q=quit.`);
    }
  }
}

// ── Steps ───────────────────────────────────────────────────────

async function stepApiKey(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  heading(`Step ${stepIdx + 1}/${totalSteps} — Anthropic API Key`);

  const key = await ask('Enter your Anthropic API key');

  if (!key.startsWith('sk-ant-')) {
    fail('Key must start with "sk-ant-". Skipping validation.');
    config.models.apiKey = key;
    return nav(stepIdx, totalSteps);
  }

  config.models.apiKey = key;
  print('  Testing key... ');

  try {
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
    fail(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return nav(stepIdx, totalSteps);
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

    models.sort((a, b) => {
      const da = a.created_at ?? '';
      const db = b.created_at ?? '';
      if (da !== db) return db.localeCompare(da);
      return a.id.localeCompare(b.id);
    });

    println(`${GREEN}found ${models.length} models${RESET}`);

    return models.map((m) => {
      const name = m.display_name || m.id;
      let suffix = '';
      if (m.id.includes('sonnet')) suffix = ` ${DIM}(recommended)${RESET}`;
      return { label: `${name}${suffix}`, value: m.id };
    });
  } catch (err: unknown) {
    println(`${YELLOW}(error: ${err instanceof Error ? err.message : String(err)})${RESET}`);
    return [];
  }
}

async function stepModel(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  heading(`Step ${stepIdx + 1}/${totalSteps} — Default Model`);

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
      println(`${YELLOW}(error: ${err instanceof Error ? err.message : String(err)})${RESET}`);
    }
  }

  if (options.length === 0) {
    println(`  ${YELLOW}Could not discover models. Enter a model ID manually.${RESET}`);
    const model = await ask('Enter model ID');
    config.models.default = model;
    config.models.planner = model;
    success(`Default model: ${model}`);
    return nav(stepIdx, totalSteps);
  }

  options.push({ label: `${DIM}Enter a model ID manually${RESET}`, value: '__custom__' });

  let model = await choose('Select your default model:', options);

  if (model === '__custom__') {
    model = await ask('Enter model ID');
  }

  config.models.default = model;
  config.models.planner = model;
  success(`Default model: ${model}`);

  return nav(stepIdx, totalSteps);
}

async function stepGatewaySecurity(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  heading(`Step ${stepIdx + 1}/${totalSteps} — Gateway Security`);

  const mode = await choose('Authentication mode for the gateway:', [
    { label: 'API Key authentication', value: 'api-key' },
    { label: `No authentication ${DIM}(local use only)${RESET}`, value: 'none' },
  ]);

  config.gateway.auth.mode = mode as 'api-key' | 'none';

  if (mode === 'api-key') {
    let password = '';
    while (password.length < 8) {
      password = await ask('Enter a gateway API key (min 8 characters)');
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

  return nav(stepIdx, totalSteps);
}

async function stepHindsight(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  heading(`Step ${stepIdx + 1}/${totalSteps} — Hindsight Memory`);

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

  return nav(stepIdx, totalSteps);
}

async function stepWorkspace(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  heading(`Step ${stepIdx + 1}/${totalSteps} — Workspace`);

  const defaultPath = join(homedir(), '.orionomega', 'workspace');
  const wsPath = await ask('Workspace directory', { default: defaultPath });
  config.workspace.path = wsPath;

  const dirs = ['', 'output', 'memory', 'progress', 'orchestration'];
  for (const d of dirs) {
    const p = join(wsPath, d);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
    }
  }
  success('Workspace directories created.');

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

  return nav(stepIdx, totalSteps);
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

// ── Step 6: Agent SDK ────────────────────────────────────────────

async function stepAgentSdk(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  heading(`Step ${stepIdx + 1}/${totalSteps} — Claude Agent SDK (Coding Agents)`);

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
    return nav(stepIdx, totalSteps);
  }

  const permOptions = [
    { label: `Accept file edits automatically ${DIM}(recommended)${RESET}`, value: 'acceptEdits' },
    { label: 'Bypass all permissions (caution!)', value: 'bypassPermissions' },
    { label: 'Require approval for each tool', value: 'default' },
  ];
  config.agentSdk.permissionMode = (await choose(
    'Permission mode for coding agents:', permOptions,
  )) as OrionOmegaConfig['agentSdk']['permissionMode'];

  const effortOptions = [
    { label: `High ${DIM}(recommended — good balance of thoroughness and speed)${RESET}`, value: 'high' },
    { label: 'Max (deepest reasoning, slowest)', value: 'max' },
    { label: 'Medium (faster, less thorough)', value: 'medium' },
    { label: 'Low (fastest, minimal reasoning)', value: 'low' },
  ];
  config.agentSdk.effort = (await choose(
    'Effort level:', effortOptions,
  )) as OrionOmegaConfig['agentSdk']['effort'];

  const budget = await ask('Max budget per coding task (USD, 0 for unlimited)', { default: '0' });
  const budgetNum = parseFloat(budget);
  if (budgetNum > 0) config.agentSdk.maxBudgetUsd = budgetNum;

  success(`Agent SDK configured: ${config.agentSdk.permissionMode}, effort=${config.agentSdk.effort}`);

  return nav(stepIdx, totalSteps);
}

// ── Step 7: Skills ───────────────────────────────────────────────

async function stepSkills(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  heading(`Step ${stepIdx + 1}/${totalSteps} — Skills`);

  const skillsDirs: string[] = [];
  const repoRoot = new URL('../../../../', import.meta.url).pathname;
  const defaultSkillsDir = join(repoRoot, 'default-skills');
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
    println('  No skills found. You can install skills later with: orionomega skill install <path>');
    return nav(stepIdx, totalSteps);
  }

  println('  Available skills:');
  println();
  for (let i = 0; i < allManifests.length; i++) {
    const m = allManifests[i];
    const setupTag = m.setup?.required ? ' (requires setup)' : '';
    println(`  ${BOLD}${i + 1}${RESET}) ${m.name} — ${m.description}${DIM}${setupTag}${RESET}`);
  }
  println();

  const selection = await ask("Enable which skills? (comma-separated numbers, or 'all')", { default: 'all' });

  let selectedIndices: number[];
  if (selection.toLowerCase() === 'all') {
    selectedIndices = allManifests.map((_, i) => i);
  } else {
    selectedIndices = selection
      .split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < allManifests.length);
  }

  if (selectedIndices.length === 0) {
    warn('No skills selected.');
    return nav(stepIdx, totalSteps);
  }

  const selected = selectedIndices.map((i) => allManifests[i]);
  success('Selected: ' + selected.map((m) => m.name).join(', '));

  // Install default skills to user directory if not present
  for (const m of selected) {
    const dest = join(config.skills.directory, m.name);
    const src = join(defaultSkillsDir, m.name);
    if (!existsSync(dest) && existsSync(src)) {
      const { cpSync } = await import('node:fs');
      cpSync(src, dest, { recursive: true });
      println(`  ${DIM}Installed: ${m.name}${RESET}`);
    }
  }

  // Disable skills that were NOT selected
  for (const m of allManifests) {
    if (!selected.find((s) => s.name === m.name)) {
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
      heading(`  Skill Setup: ${m.name}`);
      if (m.setup.description) println(`  ${m.setup.description}`);
      println();

      // Auth method selection + execution
      let authSucceeded = true;
      if (m.setup.auth?.methods?.length) {
        const authResult = await runAuthSetup(m.setup.auth.methods, config.skills.directory, m.name);
        if (authResult.type) cfg.authMethod = authResult.type;

        if (authResult.skipped) {
          // User explicitly skipped this skill's auth — disable and move on
          cfg.enabled = false;
          writeSkillConfig(config.skills.directory, cfg);
          warn(`Skipped ${m.name} — auth not configured. Re-run with: orionomega skill setup ${m.name}`);
          continue;
        }

        if (!authResult.success) {
          // Auth failed but user chose to continue anyway
          warn(`Auth failed for ${m.name}. The skill may not work correctly.`);
          authSucceeded = false;
        }
      }

      // Config fields — only prompt if auth succeeded or user chose to continue
      if (m.setup.fields?.length) {
        for (const field of m.setup.fields) {
          const value = await promptField(field);
          if (value !== undefined && value !== '') {
            cfg.fields[field.name] = value;
          }
        }
      }

      // Run setup handler if present
      if (m.setup.handler) {
        const handlerPath = join(config.skills.directory, m.name, m.setup.handler);
        if (existsSync(handlerPath)) {
          print('  Running setup validation... ');
          try {
            const result = execSync(`node ${handlerPath}`, {
              encoding: 'utf-8',
              timeout: 30000,
              input: JSON.stringify(cfg),
              env: { ...process.env },
            }).trim();
            try {
              const updates = JSON.parse(result);
              if (updates.fields) Object.assign(cfg.fields, updates.fields);
              if (updates.authMethod) cfg.authMethod = updates.authMethod;
            } catch {}
            success('Validation passed.');
          } catch (err: unknown) {
            fail(`Setup handler failed: ${err instanceof Error ? err.message : String(err)}`);
            warn(`You can retry with: orionomega skill setup ${m.name}`);
          }
        }
      }

      cfg.configured = authSucceeded;
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

  success('Skills configured.');

  return nav(stepIdx, totalSteps);
}

// ── Auth result ──────────────────────────────────────────────────

interface AuthResult {
  /** Whether auth validation passed. */
  success: boolean;
  /** Whether the user explicitly skipped this skill. */
  skipped: boolean;
  /** The auth method type that was used. */
  type?: string;
}

/**
 * Run interactive auth method selection for a skill.
 * Offers retry / skip / continue on validation failure.
 * No input masking — tokens are shown as plain text.
 */
async function runAuthSetup(
  methods: SkillAuthMethod[],
  skillsDir: string,
  skillName: string,
): Promise<AuthResult> {
  if (methods.length === 1) {
    println(`  Auth: ${methods[0].label}`);
  }

  const options = methods.map((m) => ({
    label: m.label + (m.description ? ` — ${DIM}${m.description}${RESET}` : ''),
    value: m.type,
  }));
  const chosen = methods.length === 1
    ? methods[0].type
    : await choose('  Choose authentication method:', options);
  const method = methods.find((m) => m.type === chosen);
  if (!method) return { success: false, skipped: false };

  // ── Credential entry ─────────────────────────────────────────

  switch (method.type) {
    case 'oauth':
    case 'login': {
      if (method.command) {
        if (isGhWebAuthCommand(method.command)) {
          const protocol = extractGitProtocol(method.command);
          const ok = await githubDeviceFlowAuth(protocol);
          if (!ok) {
            fail('Authentication failed.');
            return await handleAuthFailure(method, skillsDir, skillName, methods);
          }
          success('Authentication complete.');
        } else {
          println(`  Running: ${BOLD}${method.command}${RESET}`);
          try {
            execSync(method.command, { stdio: 'inherit', timeout: 120000 });
            success('Authentication complete.');
          } catch {
            fail('Authentication command failed.');
            return await handleAuthFailure(method, skillsDir, skillName, methods);
          }
        }
      }
      break;
    }

    case 'pat':
    case 'api-key': {
      if (method.tokenUrl) {
        println(`  Generate a token at: ${BLUE}${method.tokenUrl}${RESET}`);
        if (method.scopes?.length) {
          println(`  Required scopes: ${method.scopes.join(', ')}`);
        }
      }
      // No masking — plain text input
      const token = await ask(`  Enter your ${method.type === 'pat' ? 'personal access token' : 'API key'}`);
      if (token && method.envVar) {
        const cfg = readSkillConfig(skillsDir, skillName);
        cfg.fields[method.envVar] = token;
        writeSkillConfig(skillsDir, cfg);
        println(`  ${DIM}Stored in skill config as ${method.envVar}${RESET}`);
      }
      break;
    }

    case 'env': {
      if (method.envVar) {
        if (process.env[method.envVar]) {
          success(`${method.envVar} is already set.`);
        } else {
          warn(`${method.envVar} is not set. Set it in your shell profile.`);
        }
      }
      break;
    }

    case 'ssh-key': {
      println('  Ensure your SSH key is configured for this service.');
      break;
    }
  }

  // ── Validation ───────────────────────────────────────────────

  if (method.validateCommand) {
    return await validateAuth(method, skillsDir, skillName, methods);
  }

  return { success: true, skipped: false, type: method.type };
}

/**
 * Run the method's validateCommand and offer retry/skip/continue on failure.
 */
async function validateAuth(
  method: SkillAuthMethod,
  skillsDir: string,
  skillName: string,
  allMethods: SkillAuthMethod[],
): Promise<AuthResult> {
  print('  Validating... ');
  try {
    execSync(method.validateCommand!, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
    success('Auth is valid!');
    return { success: true, skipped: false, type: method.type };
  } catch {
    fail('Validation failed.');
    return await handleAuthFailure(method, skillsDir, skillName, allMethods);
  }
}

/**
 * Offer the user options after an auth failure: retry, skip skill, or continue anyway.
 */
async function handleAuthFailure(
  method: SkillAuthMethod,
  skillsDir: string,
  skillName: string,
  allMethods: SkillAuthMethod[],
): Promise<AuthResult> {
  for (;;) {
    const choice = await choose('  What would you like to do?', [
      { label: 'Retry — re-enter credentials', value: 'retry' },
      { label: `Skip ${skillName} — disable for now`, value: 'skip' },
      { label: 'Continue anyway — skill may not work correctly', value: 'continue' },
    ]);

    if (choice === 'skip') {
      return { success: false, skipped: true, type: method.type };
    }

    if (choice === 'continue') {
      return { success: false, skipped: false, type: method.type };
    }

    // Retry: re-enter credentials based on auth type
    if (method.type === 'api-key' || method.type === 'pat') {
      if (method.tokenUrl) {
        println(`  Token URL: ${BLUE}${method.tokenUrl}${RESET}`);
      }
      // Plain text — no masking
      const token = await ask(`  Re-enter your ${method.type === 'pat' ? 'personal access token' : 'API key'}`);
      if (token && method.envVar) {
        const cfg = readSkillConfig(skillsDir, skillName);
        cfg.fields[method.envVar] = token;
        writeSkillConfig(skillsDir, cfg);
      }
    } else if (method.type === 'oauth' || method.type === 'login') {
      if (method.command) {
        println(`  Running: ${BOLD}${method.command}${RESET}`);
        try {
          execSync(method.command, { stdio: 'inherit', timeout: 120000 });
        } catch {
          fail('Auth command failed again.');
        }
      }
    }

    // Re-validate after retry
    if (method.validateCommand) {
      print('  Validating... ');
      try {
        execSync(method.validateCommand, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
        success('Auth is valid!');
        return { success: true, skipped: false, type: method.type };
      } catch {
        fail('Validation failed again.');
        // Loop back to retry/skip/continue choice
      }
    } else {
      // No validateCommand — assume success after re-entry
      return { success: true, skipped: false, type: method.type };
    }
  }
}

/**
 * Prompt for a single config field value.
 * No masking — all input is plain text during setup.
 */
async function promptField(field: SkillSetupField): Promise<string | number | boolean | undefined> {
  const defaultStr = field.default !== undefined ? String(field.default) : undefined;

  if (field.type === 'boolean') {
    return await confirm(
      `  ${field.label}${field.description ? ` (${field.description})` : ''}`,
      (field.default as boolean) ?? true,
    );
  }

  if (field.type === 'select' && field.options?.length) {
    return await choose(`  ${field.label}:`, field.options);
  }

  const raw = await ask(
    `  ${field.label}${field.description ? ` (${field.description})` : ''}`,
    { default: defaultStr },
  );

  if (field.type === 'number') return parseFloat(raw) || ((field.default as number) ?? 0);
  return raw;
}

// ── Main ────────────────────────────────────────────────────────

type StepFn = (config: OrionOmegaConfig, stepIdx: number, totalSteps: number) => Promise<StepAction>;

/**
 * Run the interactive setup wizard.
 * Steps are navigable: back, redo, and quit are available after every step.
 */
export async function runSetup(): Promise<void> {
  println();
  println(`${BOLD}╔══════════════════════════════════════╗${RESET}`);
  println(`${BOLD}║     OrionOmega — Setup Wizard        ║${RESET}`);
  println(`${BOLD}╚══════════════════════════════════════╝${RESET}`);
  println();
  println(`  Navigate with: ${BOLD}↵${RESET} continue   ${BOLD}b${RESET} back   ${BOLD}r${RESET} redo step   ${BOLD}q${RESET} quit`);

  const config = getDefaultConfig();

  const steps: StepFn[] = [
    stepApiKey,
    stepModel,
    stepGatewaySecurity,
    stepHindsight,
    stepWorkspace,
    stepAgentSdk,
    stepSkills,
  ];

  initRL();

  try {
    let idx = 0;
    while (idx < steps.length) {
      const action = await steps[idx](config, idx, steps.length);
      switch (action) {
        case 'next':
          idx++;
          break;
        case 'back':
          if (idx > 0) idx--;
          break;
        case 'redo':
          // Re-run the same step
          break;
        case 'quit':
          println();
          warn('Setup exited without saving.');
          process.exit(0);
      }
    }

    // ── Post-wizard finalization ──────────────────────────────

    // Ensure skills & logs directories exist
    if (!existsSync(config.skills.directory)) {
      mkdirSync(config.skills.directory, { recursive: true });
    }

    // Install any default skills not yet present in the user directory
    try {
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
            execSync(
              `find ${dest}/handlers -name "*.js" -exec chmod +x {} \\; 2>/dev/null || true`,
            );
            println(`  ${DIM}Installed default skill: ${skillName}${RESET}`);
            installed++;
          }
        }
        if (installed > 0) {
          success(`Installed ${installed} default skill(s).`);
        }
      }
    } catch (err) {
      warn(`Could not install default skills: ${err instanceof Error ? err.message : String(err)}`);
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

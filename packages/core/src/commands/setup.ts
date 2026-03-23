/**
 * @module commands/setup
 * Interactive setup wizard for OrionOmega.
 *
 * Features:
 * - Visual progress bar and step overview menu with jump-to
 * - Back / redo / save & exit / menu / quit navigation at every step
 * - Loads existing config on re-run — Enter keeps current values
 * - Boxed current-value display at the top of each step
 * - Grouped summary with colored values and "changed" indicators
 * - Secrets masked in all displays (first 7 + last 4 chars)
 * - Input validation with re-prompt on errors
 * - Ctrl+C handled gracefully
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { writeConfig, readConfig, getConfigPath, getDefaultConfig } from '../config/index.js';
import type { OrionOmegaConfig } from '../config/index.js';
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { SkillManifest, SkillAuthMethod, SkillSetupField } from '@orionomega/skills-sdk';
import { githubDeviceFlowAuth, isGhWebAuthCommand, extractGitProtocol } from './github-device-auth.js';
import {
  GREEN, RED, YELLOW, BLUE, CYAN, BOLD, DIM, RESET,
  print, println, success, fail, warn, heading,
  progressBar, maskSecret, initRL, closeRL, ask, choose, confirm,
  chmodJsFiles,
} from './cli-utils.js';

// ── Change tracking ─────────────────────────────────────────────

interface ConfigSnapshot {
  apiKey: string;
  model: string;
  planner: string;
  authMode: string;
  keyHash: string | undefined;
  hindsightUrl: string;
  workspace: string;
  logLevel: string;
  logFile: string;
  agentSdkEnabled: boolean;
  agentSdkPermission: string;
  agentSdkEffort: string;
  agentSdkBudget: number | undefined;
}

function snapshotConfig(c: OrionOmegaConfig): ConfigSnapshot {
  return {
    apiKey: c.models.apiKey,
    model: c.models.default,
    planner: c.models.planner,
    authMode: c.gateway.auth.mode,
    keyHash: c.gateway.auth.keyHash,
    hindsightUrl: c.hindsight.url,
    workspace: c.workspace.path,
    logLevel: c.logging.level,
    logFile: c.logging.file,
    agentSdkEnabled: c.agentSdk.enabled,
    agentSdkPermission: c.agentSdk.permissionMode,
    agentSdkEffort: c.agentSdk.effort,
    agentSdkBudget: c.agentSdk.maxBudgetUsd,
  };
}

function changedTag(before: unknown, after: unknown): string {
  if (before !== after) return ` ${YELLOW}*${RESET}`;
  return '';
}

// ── Navigation ──────────────────────────────────────────────────

type StepAction = 'next' | 'back' | 'redo' | 'quit' | 'menu' | 'save';

async function nav(stepIdx: number, totalSteps: number): Promise<StepAction> {
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === totalSteps - 1;
  const nextWord = isLast ? 'finish' : 'next';

  println();
  println(`${DIM}──────────────────────────────────────────────────${RESET}`);
  println(`  ${DIM}Step ${stepIdx + 1}/${totalSteps}${RESET}   ${BOLD}↵${RESET} ${nextWord}${!isFirst ? `   ${BOLD}b${RESET} back` : ''}   ${BOLD}s${RESET} save & exit`);
  println(`           ${BOLD}r${RESET} redo   ${BOLD}m${RESET} menu   ${BOLD}q${RESET} quit`);

  for (;;) {
    const input = await ask(' ');
    const a = input.toLowerCase().trim();
    if (a === '' || a === 'n' || a === 'f' || a === 'c') return 'next';
    if (a === 'b' && !isFirst) return 'back';
    if (a === 'r') return 'redo';
    if (a === 's') return 'save';
    if (a === 'm') return 'menu';
    if (a === 'q') {
      const yes = await confirm('Exit setup without saving?', false);
      if (yes) return 'quit';
      println();
      println(`${DIM}──────────────────────────────────────────────────${RESET}`);
      println(`  ${DIM}Step ${stepIdx + 1}/${totalSteps}${RESET}   ${BOLD}↵${RESET} ${nextWord}${!isFirst ? `   ${BOLD}b${RESET} back` : ''}   ${BOLD}s${RESET} save & exit`);
      println(`           ${BOLD}r${RESET} redo   ${BOLD}m${RESET} menu   ${BOLD}q${RESET} quit`);
    } else if (a === 'b' && isFirst) {
      warn('Already at the first step.');
    } else {
      warn(`Unknown input. Enter=${nextWord}, b=back, s=save, r=redo, m=menu, q=quit.`);
    }
  }
}

// ── Step status helpers ─────────────────────────────────────────

interface StepInfo {
  name: string;
  group: 'required' | 'optional';
  summary: (config: OrionOmegaConfig) => string;
  configured: (config: OrionOmegaConfig) => boolean;
}

const STEP_INFO: StepInfo[] = [
  {
    name: 'Anthropic API Key',
    group: 'required',
    summary: (c) => c.models.apiKey ? maskSecret(c.models.apiKey) : 'not set',
    configured: (c) => !!c.models.apiKey,
  },
  {
    name: 'Default Model',
    group: 'required',
    summary: (c) => c.models.default || 'not set',
    configured: (c) => !!c.models.default,
  },
  {
    name: 'Gateway Security',
    group: 'required',
    summary: (c) => c.gateway.auth.mode,
    configured: (_c) => true,
  },
  {
    name: 'Hindsight Memory',
    group: 'optional',
    summary: (c) => c.hindsight.url || 'not set',
    configured: (c) => !!c.hindsight.url,
  },
  {
    name: 'Workspace',
    group: 'required',
    summary: (c) => c.workspace.path.replace(homedir(), '~') || 'not set',
    configured: (c) => !!c.workspace.path,
  },
  {
    name: 'Logging',
    group: 'optional',
    summary: (c) => `${c.logging.level}, ${c.logging.file.replace(homedir(), '~')}`,
    configured: (_c) => true,
  },
  {
    name: 'Claude Agent SDK',
    group: 'optional',
    summary: (c) => c.agentSdk.enabled ? `enabled (${c.agentSdk.permissionMode})` : 'disabled',
    configured: (_c) => true,
  },
  {
    name: 'Skills',
    group: 'optional',
    summary: (_c) => 'see step',
    configured: (_c) => true,
  },
];

async function showMenu(config: OrionOmegaConfig): Promise<number> {
  println();
  println(`${BOLD}${BLUE}  OrionOmega Setup${RESET}`);
  println();

  const configuredCount = STEP_INFO.filter((s) => s.configured(config) && s.summary(config) !== 'not set').length;
  println(`  ${DIM}${configuredCount}/${STEP_INFO.length} steps configured${RESET}`);
  println();

  const required = STEP_INFO.map((info, i) => ({ info, i })).filter(({ info }) => info.group === 'required');
  const optional = STEP_INFO.map((info, i) => ({ info, i })).filter(({ info }) => info.group === 'optional');

  println(`  ${DIM}${'#'.padEnd(4)}${'Step'.padEnd(24)}${'  '}${'Current Value'}${RESET}`);
  println(`  ${'─'.repeat(56)}`);

  println(`  ${BOLD}${CYAN}Required${RESET}`);
  for (const { info, i } of required) {
    const configured = info.configured(config);
    const icon = configured && info.summary(config) !== 'not set' ? `${GREEN}✓${RESET}` : `${RED}○${RESET}`;
    const summary = info.summary(config);
    const summaryColor = summary === 'not set' ? `${RED}${summary}${RESET}` : `${DIM}${summary}${RESET}`;
    println(`    ${BOLD}${i + 1}${RESET}. ${info.name.padEnd(22)}${icon}  ${summaryColor}`);
  }
  println();

  println(`  ${BOLD}${CYAN}Optional${RESET}`);
  for (const { info, i } of optional) {
    const configured = info.configured(config);
    const icon = configured && info.summary(config) !== 'not set' ? `${GREEN}✓${RESET}` : `${DIM}○${RESET}`;
    const summary = info.summary(config);
    const summaryColor = summary === 'not set' ? `${RED}${summary}${RESET}` : `${DIM}${summary}${RESET}`;
    println(`    ${BOLD}${i + 1}${RESET}. ${info.name.padEnd(22)}${icon}  ${summaryColor}`);
  }

  println();
  println(`  ${DIM}Enter a step number, or:${RESET}  ${BOLD}↵${RESET} start from 1   ${BOLD}s${RESET} save & exit`);
  const input = await ask(' ');
  const a = input.toLowerCase().trim();
  if (a === '' || a === '\n') return 0;
  if (a === 's') return -1;
  const idx = parseInt(a, 10) - 1;
  if (idx >= 0 && idx < STEP_INFO.length) return idx;
  warn(`Invalid step number. Starting from step 1.`);
  return 0;
}

// ── Current value display ───────────────────────────────────────

function showCurrentBox(fields: [string, string][]): void {
  const filtered = fields.filter(([_, v]) => v);
  if (filtered.length === 0) return;
  println(`  ${DIM}┌─ current ────────────────────────────────────${RESET}`);
  for (const [label, value] of filtered) {
    println(`  ${DIM}│  ${label}: ${value}${RESET}`);
  }
  println(`  ${DIM}└──────────────────────────────────────────────${RESET}`);
  println();
}

// ── Step heading ────────────────────────────────────────────────

function stepHeading(stepIdx: number, totalSteps: number, title: string): void {
  println();
  println(progressBar(stepIdx + 1, totalSteps));
  println(`  ${BOLD}${BLUE}${title}${RESET}`);
  println();
}

// ── Steps ───────────────────────────────────────────────────────

async function stepApiKey(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  stepHeading(stepIdx, totalSteps, 'Anthropic API Key');
  showCurrentBox([['API Key', config.models.apiKey ? maskSecret(config.models.apiKey) : '']]);

  const existing = config.models.apiKey;
  const defaultHint = existing ? 'Enter to keep current' : undefined;

  const key = await ask('Enter your Anthropic API key', { default: defaultHint });

  if (key === defaultHint && existing) {
    success('Keeping existing API key.');
    return nav(stepIdx, totalSteps);
  }

  if (!key) {
    warn('No API key set. The gateway will not be able to use Anthropic models.');
    return nav(stepIdx, totalSteps);
  }

  config.models.apiKey = key;

  if (!key.startsWith('sk-ant-')) {
    warn('Key doesn\'t start with "sk-ant-" — skipping validation.');
    return nav(stepIdx, totalSteps);
  }

  print('  Testing key... ');
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      success('API key is valid!');
    } else {
      const body = await res.text();
      fail(`API returned ${res.status}: ${body.slice(0, 120)}`);
      const retry = await confirm('  Re-enter the key?', true);
      if (retry) return 'redo';
    }
  } catch (err: unknown) {
    fail(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return nav(stepIdx, totalSteps);
}

async function stepModel(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  stepHeading(stepIdx, totalSteps, 'Default Model');
  showCurrentBox([['Model', config.models.default]]);

  if (config.models.default) {
    const keep = await confirm(`  Keep ${BOLD}${config.models.default}${RESET}?`, true);
    if (keep) {
      success(`Keeping model: ${config.models.default}`);
      return nav(stepIdx, totalSteps);
    }
  }

  let options: { label: string; value: string }[] = [];
  let recommendedIdx: number | undefined;

  if (config.models.apiKey) {
    process.stdout.write(`  Fetching models from Anthropic API... `);
    try {
      const { discoverModels } = await import('../models/model-discovery.js');
      const models = await discoverModels(config.models.apiKey);
      if (models.length > 0) {
        println(`${GREEN}found ${models.length} models${RESET}`);
        options = models.map((m, i) => {
          let suffix = '';
          if (m.tier === 'sonnet') { suffix = ` ${DIM}(balanced)${RESET}`; recommendedIdx = i; }
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
    const model = await ask('Enter model ID', { default: config.models.default || undefined });
    if (model) {
      config.models.default = model;
      config.models.planner = model;
      success(`Default model: ${model}`);
    }
    return nav(stepIdx, totalSteps);
  }

  options.push({ label: `${DIM}Enter a model ID manually${RESET}`, value: '__custom__' });

  let model = await choose('Select your default model:', options, { recommended: recommendedIdx });

  if (model === '__custom__') {
    model = await ask('Enter model ID', { default: config.models.default || undefined });
  }

  if (model) {
    config.models.default = model;
    config.models.planner = model;
    success(`Default model: ${model}`);
  }

  return nav(stepIdx, totalSteps);
}

async function stepGatewaySecurity(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  stepHeading(stepIdx, totalSteps, 'Gateway Security');
  showCurrentBox([
    ['Auth mode', config.gateway.auth.mode],
    ['Key hash', config.gateway.auth.keyHash ? maskSecret(config.gateway.auth.keyHash) : ''],
  ]);

  if (config.gateway.auth.mode) {
    const keep = await confirm(`  Keep ${BOLD}${config.gateway.auth.mode}${RESET} auth mode?`, true);
    if (keep) {
      success(`Keeping auth mode: ${config.gateway.auth.mode}`);
      return nav(stepIdx, totalSteps);
    }
  }

  const mode = await choose('Authentication mode for the gateway:', [
    { label: 'API Key authentication', value: 'api-key' },
    { label: `No authentication ${DIM}(local use only)${RESET}`, value: 'none' },
  ], { recommended: 0 });

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
    config.gateway.auth.keyHash = undefined;
    success('No authentication. Ensure the gateway is not exposed publicly.');
  }

  return nav(stepIdx, totalSteps);
}

async function stepHindsight(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  stepHeading(stepIdx, totalSteps, 'Hindsight Memory');
  showCurrentBox([['Hindsight URL', config.hindsight.url]]);

  if (config.hindsight.url) {
    const keep = await confirm(`  Keep ${BOLD}${config.hindsight.url}${RESET}?`, true);
    if (keep) {
      success(`Keeping Hindsight URL: ${config.hindsight.url}`);
      return nav(stepIdx, totalSteps);
    }
  }

  const mode = await choose('Hindsight server:', [
    { label: `Local ${DIM}(localhost:8888)${RESET}`, value: 'local' },
    { label: 'Remote (custom URL)', value: 'remote' },
  ]);

  let url = 'http://localhost:8888';
  if (mode === 'remote') {
    url = await ask('Hindsight URL', { default: config.hindsight.url || 'http://localhost:8888' });
  }
  config.hindsight.url = url;

  print('  Testing connection... ');
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      success('Hindsight is reachable!');
    } else {
      fail(`Hindsight returned ${res.status}.`);
      if (url.includes('localhost') || url.includes('127.0.0.1')) {
        await tryStartHindsightContainer(config);
      }
    }
  } catch {
    println(`${YELLOW}not reachable${RESET}`);
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      await tryStartHindsightContainer(config);
    } else {
      warn('Remote Hindsight is not reachable. Check the URL and try again.');
    }
  }

  return nav(stepIdx, totalSteps);
}

async function tryStartHindsightContainer(config: OrionOmegaConfig): Promise<void> {
  try {
    execSync('docker --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    warn('Docker not found — cannot start Hindsight automatically.');
    println(`  ${DIM}Install Docker or point to a remote Hindsight instance.${RESET}`);
    return;
  }

  if (!config.models.apiKey) {
    warn('No Anthropic API key configured — Hindsight requires one to start.');
    println(`  ${DIM}Complete step 1 (API Key) first, then revisit this step.${RESET}`);
    return;
  }

  const startIt = await confirm('  Start Hindsight Docker container?', true);
  if (!startIt) return;

  print('  Stopping existing container... ');
  try {
    execSync('sudo docker stop hindsight 2>/dev/null; sudo docker rm hindsight 2>/dev/null', { stdio: 'pipe', timeout: 15000 });
  } catch {}
  println('done');

  try {
    execSync('sudo mkdir -p /opt/hindsight-data && sudo chmod 777 /opt/hindsight-data', { stdio: 'pipe', timeout: 5000 });
  } catch {}

  print('  Starting Hindsight... ');
  try {
    const dockerCmd = [
      'sudo docker run -d',
      '--name hindsight',
      '--restart unless-stopped',
      '-p 8888:8888 -p 9999:9999',
      `-e "HINDSIGHT_API_LLM_API_KEY=${config.models.apiKey}"`,
      '-e "HINDSIGHT_API_LLM_PROVIDER=anthropic"',
      '-e "HINDSIGHT_API_LLM_MODEL=claude-haiku-4-5-20251001"',
      '-v /opt/hindsight-data:/home/hindsight/.pg0',
      'ghcr.io/vectorize-io/hindsight:latest',
    ].join(' ');
    execSync(dockerCmd, { stdio: 'pipe', timeout: 30000 });
    println('started');

    print('  Waiting for Hindsight to initialize (this can take 30-60s)... ');
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch('http://localhost:8888/health', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (ready) {
      success('Hindsight is running!');
    } else {
      warn('Hindsight started but not yet responding. Check: docker logs hindsight');
      println(`  ${DIM}It may still be loading embedding models (30-90s on first run).${RESET}`);
    }
  } catch (err: unknown) {
    fail(`Failed to start Hindsight: ${err instanceof Error ? err.message : String(err)}`);
    println(`  ${DIM}Check: docker logs hindsight${RESET}`);
  }
}

async function stepWorkspace(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  stepHeading(stepIdx, totalSteps, 'Workspace');
  showCurrentBox([['Workspace', config.workspace.path ? config.workspace.path.replace(homedir(), '~') : '']]);

  if (config.workspace.path) {
    const keep = await confirm(`  Keep ${BOLD}${config.workspace.path.replace(homedir(), '~')}${RESET}?`, true);
    if (keep) {
      success(`Keeping workspace: ${config.workspace.path.replace(homedir(), '~')}`);
      return nav(stepIdx, totalSteps);
    }
  }

  const defaultPath = config.workspace.path || join(homedir(), '.orionomega', 'workspace');
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

// ── Step 6: Logging ──────────────────────────────────────────────

async function stepLogging(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  stepHeading(stepIdx, totalSteps, 'Logging');
  showCurrentBox([
    ['Log level', config.logging.level],
    ['Log file', config.logging.file.replace(homedir(), '~')],
  ]);

  const keep = await confirm(`  Keep current settings?`, true);
  if (keep) {
    success(`Keeping logging: ${config.logging.level}, file: ${config.logging.file.replace(homedir(), '~')}`);
    return nav(stepIdx, totalSteps);
  }

  const levelOptions = [
    { label: `info ${DIM}(default — startup, connections, errors)${RESET}`, value: 'info' },
    { label: `verbose ${DIM}(conversations, tool calls, Hindsight, tokens)${RESET}`, value: 'verbose' },
    { label: `debug ${DIM}(everything — full request/response bodies)${RESET}`, value: 'debug' },
    { label: `warn ${DIM}(warnings and errors only)${RESET}`, value: 'warn' },
    { label: `error ${DIM}(errors only)${RESET}`, value: 'error' },
  ];
  config.logging.level = (await choose('Log level:', levelOptions, { recommended: 0 })) as OrionOmegaConfig['logging']['level'];

  const defaultLogFile = config.logging.file || join(homedir(), '.orionomega', 'logs', 'orionomega.log');
  config.logging.file = await ask('Log file path', { default: defaultLogFile });

  const logDir = join(config.logging.file, '..');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
    println(`  ${DIM}Created log directory: ${logDir}${RESET}`);
  }

  success(`Logging: ${config.logging.level}, file: ${config.logging.file.replace(homedir(), '~')}`);

  return nav(stepIdx, totalSteps);
}

// ── Step 7: Agent SDK ────────────────────────────────────────────

async function stepAgentSdk(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  stepHeading(stepIdx, totalSteps, 'Claude Agent SDK (Coding Agents)');

  const currentStatus = config.agentSdk.enabled
    ? `enabled, ${config.agentSdk.permissionMode}, effort=${config.agentSdk.effort}`
    : 'disabled';
  showCurrentBox([
    ['Agent SDK', currentStatus],
    ...(config.agentSdk.enabled && config.agentSdk.maxBudgetUsd ? [['Max Budget', `$${config.agentSdk.maxBudgetUsd}`] as [string, string]] : []),
  ]);

  const keep = await confirm(`  Keep current settings?`, true);
  if (keep) {
    success(`Keeping Agent SDK: ${currentStatus}`);
    return nav(stepIdx, totalSteps);
  }

  println(`  The Claude Agent SDK powers coding tasks in workflows.`);
  println(`  It uses the same Anthropic API key configured in Step 1.`);
  println(`  When enabled, the orchestrator can spawn CODING_AGENT workers`);
  println(`  with the full Claude Code toolset (Read, Write, Edit, Bash, etc.).`);
  println();

  const enable = await ask('Enable Claude Agent SDK?', { default: config.agentSdk.enabled ? 'yes' : 'no' });
  const enabled = enable.toLowerCase().startsWith('y');
  config.agentSdk.enabled = enabled;

  if (!enabled) {
    println(`  ${DIM}Agent SDK disabled. Coding tasks will use generic AGENT workers.${RESET}`);
    return nav(stepIdx, totalSteps);
  }

  const permOptions = [
    { label: `Accept file edits automatically`, value: 'acceptEdits' },
    { label: 'Bypass all permissions (caution!)', value: 'bypassPermissions' },
    { label: 'Require approval for each tool', value: 'default' },
  ];
  config.agentSdk.permissionMode = (await choose(
    'Permission mode for coding agents:', permOptions, { recommended: 0 },
  )) as OrionOmegaConfig['agentSdk']['permissionMode'];

  const effortOptions = [
    { label: `High ${DIM}(good balance of thoroughness and speed)${RESET}`, value: 'high' },
    { label: 'Max (deepest reasoning, slowest)', value: 'max' },
    { label: 'Medium (faster, less thorough)', value: 'medium' },
    { label: 'Low (fastest, minimal reasoning)', value: 'low' },
  ];
  config.agentSdk.effort = (await choose(
    'Effort level:', effortOptions, { recommended: 0 },
  )) as OrionOmegaConfig['agentSdk']['effort'];

  const currentBudget = config.agentSdk.maxBudgetUsd ? String(config.agentSdk.maxBudgetUsd) : '0';
  const budget = await ask('Max budget per coding task (USD, 0 for unlimited)', { default: currentBudget });
  const budgetNum = parseFloat(budget);
  if (budgetNum > 0) {
    config.agentSdk.maxBudgetUsd = budgetNum;
  } else {
    config.agentSdk.maxBudgetUsd = undefined;
  }

  success(`Agent SDK configured: ${config.agentSdk.permissionMode}, effort=${config.agentSdk.effort}`);

  return nav(stepIdx, totalSteps);
}

// ── Step 8: Skills ───────────────────────────────────────────────

async function stepSkills(config: OrionOmegaConfig, stepIdx: number, totalSteps: number): Promise<StepAction> {
  stepHeading(stepIdx, totalSteps, 'Skills');

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

  if (allManifests.length > 0) {
    let enabledCount = 0, configuredCount = 0;
    for (const m of allManifests) {
      try {
        const cfg = readSkillConfig(config.skills.directory, m.name);
        if (cfg.enabled) { enabledCount++; if (cfg.configured) configuredCount++; }
      } catch {}
    }
    showCurrentBox([
      ['Skills directory', config.skills.directory.replace(homedir(), '~')],
      ['Available', `${allManifests.length} skills (${configuredCount} configured, ${enabledCount} enabled)`],
    ]);
  }

  if (allManifests.length === 0) {
    println('  No skills found. You can install skills later with: orionomega skill install <path>');
    return nav(stepIdx, totalSteps);
  }

  const skip = await confirm('  Skip skill setup for now?', false);
  if (skip) {
    println(`  ${DIM}You can configure skills later with: orionomega setup skills${RESET}`);
    return nav(stepIdx, totalSteps);
  }

  println('  Available skills:');
  println();
  for (let i = 0; i < allManifests.length; i++) {
    const m = allManifests[i];
    const setupTag = m.setup?.required ? ` ${DIM}(requires setup)${RESET}` : '';
    let statusTag = '';
    try {
      const cfg = readSkillConfig(config.skills.directory, m.name);
      if (cfg.enabled && cfg.configured) statusTag = ` ${GREEN}✓ configured${RESET}`;
      else if (cfg.enabled) statusTag = ` ${YELLOW}○ needs setup${RESET}`;
      else statusTag = ` ${DIM}disabled${RESET}`;
    } catch {}
    println(`  ${BOLD}${i + 1}${RESET}) ${m.name} — ${m.description}${setupTag}${statusTag}`);
  }
  println();

  const selection = await ask("Enable which skills? (comma-separated numbers, 'all', or 'none')", { default: 'all' });

  let selectedIndices: number[];
  if (selection.toLowerCase() === 'none') {
    println(`  ${DIM}Skipping skill configuration. Run later with: orionomega setup skills${RESET}`);
    return nav(stepIdx, totalSteps);
  } else if (selection.toLowerCase() === 'all') {
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

  for (const m of selected) {
    const dest = join(config.skills.directory, m.name);
    const src = join(defaultSkillsDir, m.name);
    if (!existsSync(dest) && existsSync(src)) {
      const { cpSync } = await import('node:fs');
      cpSync(src, dest, { recursive: true });
      println(`  ${DIM}Installed: ${m.name}${RESET}`);
    }
  }

  for (const m of allManifests) {
    if (!selected.find((s) => s.name === m.name)) {
      const cfg = readSkillConfig(config.skills.directory, m.name);
      cfg.enabled = false;
      writeSkillConfig(config.skills.directory, cfg);
    }
  }

  for (const m of selected) {
    const cfg = readSkillConfig(config.skills.directory, m.name);
    cfg.enabled = true;

    if (m.setup?.required && !cfg.configured) {
      println();
      println(`  ${BOLD}${BLUE}Skill Setup: ${m.name}${RESET}`);
      if (m.setup.description) println(`  ${m.setup.description}`);
      println();

      const skipThis = await confirm(`  Skip ${m.name} setup for now?`, false);
      if (skipThis) {
        cfg.enabled = false;
        writeSkillConfig(config.skills.directory, cfg);
        println(`  ${DIM}Skipped. Configure later with: orionomega skill setup ${m.name}${RESET}`);
        continue;
      }

      let authSucceeded = true;
      if (m.setup.auth?.methods?.length) {
        const authResult = await runAuthSetup(m.setup.auth.methods, config.skills.directory, m.name);
        if (authResult.type) cfg.authMethod = authResult.type;

        if (authResult.skipped) {
          cfg.enabled = false;
          writeSkillConfig(config.skills.directory, cfg);
          warn(`Skipped ${m.name} — auth not configured. Re-run with: orionomega skill setup ${m.name}`);
          continue;
        }

        if (!authResult.success) {
          warn(`Auth failed for ${m.name}. The skill may not work correctly.`);
          authSucceeded = false;
        }
      }

      if (m.setup.fields?.length) {
        for (const field of m.setup.fields) {
          const value = await promptField(field);
          if (value !== undefined && value !== '') {
            cfg.fields[field.name] = value;
          }
        }
      }

      if (m.setup.handler) {
        const handlerPath = join(config.skills.directory, m.name, m.setup.handler);
        if (existsSync(handlerPath)) {
          print('  Running setup validation... ');
          try {
            const result = execFileSync('node', [handlerPath], {
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
    } else if (m.setup?.required && cfg.configured) {
      const reconfigure = await confirm(`  ${m.name} is already configured. Reconfigure?`, false);
      if (!reconfigure) {
        println(`  ${DIM}Skipping ${m.name}${RESET}`);
        writeSkillConfig(config.skills.directory, cfg);
        continue;
      }

      let authSucceeded = true;
      if (m.setup.auth?.methods?.length) {
        const authResult = await runAuthSetup(m.setup.auth.methods, config.skills.directory, m.name);
        if (authResult.type) cfg.authMethod = authResult.type;
        if (authResult.skipped) {
          cfg.enabled = false;
          writeSkillConfig(config.skills.directory, cfg);
          warn(`Skipped ${m.name}. Re-run with: orionomega skill setup ${m.name}`);
          continue;
        }
        if (!authResult.success) {
          warn(`Auth failed for ${m.name}.`);
          authSucceeded = false;
        }
      }
      if (m.setup.fields?.length) {
        for (const field of m.setup.fields) {
          const value = await promptField(field);
          if (value !== undefined && value !== '') {
            cfg.fields[field.name] = value;
          }
        }
      }
      if (m.setup.handler) {
        const handlerPath = join(config.skills.directory, m.name, m.setup.handler);
        if (existsSync(handlerPath)) {
          print('  Running setup validation... ');
          try {
            const result = execFileSync('node', [handlerPath], {
              encoding: 'utf-8',
              timeout: 30000,
              input: JSON.stringify(cfg),
              env: { ...process.env },
            }).trim();
            try {
              const updates = JSON.parse(result);
              if (updates.fields) Object.assign(cfg.fields, updates.fields);
              if (updates.authMethod) cfg.authMethod = updates.authMethod;
              if (updates.validated === false) {
                fail('Setup handler rejected the configuration.');
                authSucceeded = false;
              }
            } catch {}
            if (authSucceeded) success('Validation passed.');
          } catch (err: unknown) {
            fail(`Setup handler failed: ${err instanceof Error ? err.message : String(err)}`);
            warn(`You can retry with: orionomega skill setup ${m.name}`);
            authSucceeded = false;
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

// ── Auth helpers ────────────────────────────────────────────────

interface AuthResult {
  success: boolean;
  skipped: boolean;
  type?: string;
}

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

  if (method.validateCommand) {
    return await validateAuth(method, skillsDir, skillName, methods);
  }

  return { success: true, skipped: false, type: method.type };
}

function buildSkillEnv(skillsDir: string, skillName: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  try {
    const cfg = readSkillConfig(skillsDir, skillName);
    for (const [key, value] of Object.entries(cfg.fields)) {
      if (typeof value === 'string' && value) {
        env[key] = value;
      }
    }
  } catch {}
  return env;
}

async function validateAuth(
  method: SkillAuthMethod,
  skillsDir: string,
  skillName: string,
  allMethods: SkillAuthMethod[],
): Promise<AuthResult> {
  print('  Validating... ');
  try {
    const env = buildSkillEnv(skillsDir, skillName);
    execSync(method.validateCommand!, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe', env });
    success('Auth is valid!');
    return { success: true, skipped: false, type: method.type };
  } catch {
    fail('Validation failed.');
    return await handleAuthFailure(method, skillsDir, skillName, allMethods);
  }
}

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

    if (method.type === 'api-key' || method.type === 'pat') {
      if (method.tokenUrl) {
        println(`  Token URL: ${BLUE}${method.tokenUrl}${RESET}`);
      }
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

    if (method.validateCommand) {
      print('  Validating... ');
      try {
        const env = buildSkillEnv(skillsDir, skillName);
        execSync(method.validateCommand, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe', env });
        success('Auth is valid!');
        return { success: true, skipped: false, type: method.type };
      } catch {
        fail('Validation failed again.');
      }
    } else {
      return { success: true, skipped: false, type: method.type };
    }
  }
}

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

// ── Summary screen ──────────────────────────────────────────────

function colorValue(value: string | undefined | null, fallback: string = 'not set'): string {
  if (!value) return `${RED}${fallback}${RESET}`;
  return `${GREEN}${value}${RESET}`;
}

async function showSummary(config: OrionOmegaConfig, initialSnap: ConfigSnapshot): Promise<boolean> {
  println();
  println(`  ${BOLD}${BLUE}Configuration Summary${RESET}`);
  println();

  println(`  ${BOLD}${CYAN}Models${RESET}`);
  println(`    Anthropic API Key:    ${config.models.apiKey ? `${GREEN}${maskSecret(config.models.apiKey)}${RESET}` : `${RED}not set${RESET}`}${changedTag(initialSnap.apiKey, config.models.apiKey)}`);
  println(`    Default Model:        ${colorValue(config.models.default)}${changedTag(initialSnap.model, config.models.default)}`);
  println(`    Planner Model:        ${config.models.planner ? colorValue(config.models.planner) : `${DIM}(same as default)${RESET}`}${changedTag(initialSnap.planner, config.models.planner)}`);
  println();

  println(`  ${BOLD}${CYAN}Gateway${RESET}`);
  println(`    Port:                 ${DIM}${config.gateway.port}${RESET}`);
  println(`    Bind:                 ${DIM}${config.gateway.bind}${RESET}`);
  println(`    Auth:                 ${colorValue(config.gateway.auth.mode)}${config.gateway.auth.keyHash ? ` ${DIM}(key hash: ${maskSecret(config.gateway.auth.keyHash)})${RESET}` : ''}${changedTag(initialSnap.authMode, config.gateway.auth.mode)}`);
  println();

  println(`  ${BOLD}${CYAN}Memory${RESET}`);
  println(`    Hindsight URL:        ${colorValue(config.hindsight.url)}${changedTag(initialSnap.hindsightUrl, config.hindsight.url)}`);
  println(`    Default Bank:         ${DIM}${config.hindsight.defaultBank}${RESET}`);
  println();

  println(`  ${BOLD}${CYAN}Workspace${RESET}`);
  println(`    Path:                 ${colorValue(config.workspace.path.replace(homedir(), '~'))}${changedTag(initialSnap.workspace, config.workspace.path)}`);
  println();

  println(`  ${BOLD}${CYAN}Agent SDK${RESET}`);
  println(`    Enabled:              ${config.agentSdk.enabled ? `${GREEN}yes${RESET}` : `${DIM}no${RESET}`}${changedTag(initialSnap.agentSdkEnabled, config.agentSdk.enabled)}`);
  if (config.agentSdk.enabled) {
    println(`    Permission Mode:      ${DIM}${config.agentSdk.permissionMode}${RESET}${changedTag(initialSnap.agentSdkPermission, config.agentSdk.permissionMode)}`);
    println(`    Effort:               ${DIM}${config.agentSdk.effort}${RESET}${changedTag(initialSnap.agentSdkEffort, config.agentSdk.effort)}`);
    if (config.agentSdk.maxBudgetUsd) {
      println(`    Max Budget:           ${DIM}$${config.agentSdk.maxBudgetUsd}${RESET}${changedTag(initialSnap.agentSdkBudget, config.agentSdk.maxBudgetUsd)}`);
    }
  }
  println();

  println(`  ${BOLD}${CYAN}Logging & Skills${RESET}`);
  println(`    Log Level:            ${DIM}${config.logging.level}${RESET}${changedTag(initialSnap.logLevel, config.logging.level)}`);
  println(`    Log File:             ${DIM}${config.logging.file.replace(homedir(), '~')}${RESET}${changedTag(initialSnap.logFile, config.logging.file)}`);
  println(`    Skills Directory:     ${DIM}${config.skills.directory.replace(homedir(), '~')}${RESET}`);

  try {
    const loader = new SkillLoader(config.skills.directory);
    const manifests = await loader.discoverAll();
    let enabled = 0, configured = 0, disabled = 0;
    for (const m of manifests) {
      try {
        const cfg = readSkillConfig(config.skills.directory, m.name);
        if (!cfg.enabled) disabled++;
        else if (cfg.configured) { enabled++; configured++; }
        else enabled++;
      } catch { disabled++; }
    }
    println(`    Skills:               ${GREEN}${configured} configured${RESET}, ${enabled > configured ? `${YELLOW}${enabled - configured} needs setup${RESET}, ` : ''}${DIM}${disabled} disabled${RESET}`);
  } catch {}

  println();
  println(`  ${DIM}Config will be saved to: ${getConfigPath()}${RESET}`);

  const hasChanges = JSON.stringify(initialSnap) !== JSON.stringify(snapshotConfig(config));
  if (hasChanges) {
    println(`  ${YELLOW}* = changed during this session${RESET}`);
  }
  println();

  return await confirm(`${BOLD}Save this configuration?${RESET}`, true);
}

// ── Post-wizard finalization ─────────────────────────────────────

async function finalizeSetup(config: OrionOmegaConfig): Promise<void> {
  if (!existsSync(config.skills.directory)) {
    mkdirSync(config.skills.directory, { recursive: true });
  }

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
          chmodJsFiles(join(dest, 'handlers'));
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

  writeConfig(config);

  try {
    const state = execSync('systemctl is-active orionomega 2>/dev/null', { encoding: 'utf-8' }).trim();
    const action = state === 'active' ? 'restart' : 'start';
    const verb = state === 'active' ? 'Restarting' : 'Starting';
    print(`  ${verb} gateway... `);
    try {
      execSync(`sudo systemctl ${action} orionomega`, { stdio: 'ignore', timeout: 15000 });
      println(`${GREEN}✓${RESET} Gateway ${action === 'restart' ? 'restarted' : 'started'}`);
    } catch {
      try {
        execSync(`systemctl ${action} orionomega`, { stdio: 'ignore', timeout: 15000 });
        println(`${GREEN}✓${RESET} Gateway ${action === 'restart' ? 'restarted' : 'started'}`);
      } catch {
        println(`${YELLOW}⚠${RESET} Could not ${action} gateway. Run: sudo systemctl ${action} orionomega`);
      }
    }
  } catch {
    print('  Starting gateway... ');
    try {
      execSync('sudo systemctl start orionomega', { stdio: 'ignore', timeout: 15000 });
      println(`${GREEN}✓${RESET} Gateway started`);
    } catch {
      try {
        const pidFile = join(homedir(), '.orionomega', 'gateway.pid');
        if (existsSync(pidFile)) {
          const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
          if (!isNaN(pid)) {
            try { process.kill(pid, 'SIGTERM'); } catch {}
          }
        }
      } catch {}
      println(`${YELLOW}⚠${RESET} Could not start gateway. Run: orionomega gateway start`);
    }
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
}

// ── Main ────────────────────────────────────────────────────────

type StepFn = (config: OrionOmegaConfig, stepIdx: number, totalSteps: number) => Promise<StepAction>;

export async function runSetup(): Promise<void> {
  println();
  println(`${BOLD}╔══════════════════════════════════════╗${RESET}`);
  println(`${BOLD}║     OrionOmega — Setup Wizard        ║${RESET}`);
  println(`${BOLD}╚══════════════════════════════════════╝${RESET}`);
  println();

  const config = readConfig();
  const initialSnap = snapshotConfig(config);

  const steps: StepFn[] = [
    stepApiKey,
    stepModel,
    stepGatewaySecurity,
    stepHindsight,
    stepWorkspace,
    stepLogging,
    stepAgentSdk,
    stepSkills,
  ];

  initRL();

  try {
    let idx = await showMenu(config);

    if (idx === -1) {
      await finalizeSetup(config);
      return;
    }

    let saved = false;
    while (!saved) {
      while (idx < steps.length && !saved) {
        const action = await steps[idx](config, idx, steps.length);
        switch (action) {
          case 'next':
            idx++;
            break;
          case 'back':
            if (idx > 0) idx--;
            break;
          case 'redo':
            break;
          case 'menu': {
            const menuResult = await showMenu(config);
            if (menuResult === -1) {
              saved = true;
            } else {
              idx = menuResult;
            }
            break;
          }
          case 'save':
            saved = true;
            break;
          case 'quit':
            println();
            warn('Setup exited without saving.');
            process.exit(0);
        }
      }

      if (saved) break;

      const confirmed = await showSummary(config, initialSnap);
      if (confirmed) {
        saved = true;
      } else {
        println();
        warn('Not saved. Returning to menu...');
        const menuResult = await showMenu(config);
        if (menuResult === -1) {
          saved = true;
        } else {
          idx = menuResult;
        }
      }
    }

    await finalizeSetup(config);
  } finally {
    closeRL();
  }
}

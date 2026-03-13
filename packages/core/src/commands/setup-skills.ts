/**
 * @module commands/setup-skills
 * Standalone interactive skill setup command.
 *
 * Accessible via:
 *   - `orionomega setup skills`        — configure all skills interactively
 *   - `orionomega setup skills github`  — configure a specific skill
 *   - `orionomega skill setup`          — same as `setup skills`
 *   - `orionomega skill setup github`   — same as `setup skills github`
 *
 * Shows available skills, their configuration status, and guides through
 * authentication and configuration for each skill.
 */

import { createInterface } from 'node:readline';
import { existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { readConfig } from '../config/index.js';
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { SkillManifest, SkillAuthMethod, SkillSetupField, SkillConfig } from '@orionomega/skills-sdk';
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

// ── Secret masking ──────────────────────────────────────────────

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length < 12) return '***';
  return value.slice(0, 7) + '***' + value.slice(-4);
}

// ── Readline helpers ────────────────────────────────────────────

let rl: ReturnType<typeof createInterface>;

function initRL(): void {
  rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => {
    println(`\n${YELLOW}Skill setup cancelled.${RESET}`);
    process.exit(0);
  });
}

function closeRL(): void {
  rl.removeAllListeners('close');
  rl.close();
}

function ask(question: string, opts?: { default?: string }): Promise<string> {
  return new Promise((resolve) => {
    const suffix = opts?.default ? ` ${DIM}(${opts.default})${RESET}` : '';
    const prompt = `${question}${suffix}: `;
    rl.question(prompt, (answer: string) => {
      resolve(answer.trim() || opts?.default || '');
    });
  });
}

function choose(question: string, options: { label: string; value: string }[]): Promise<string> {
  return new Promise((resolve) => {
    println(question);
    for (let i = 0; i < options.length; i++) {
      println(`  ${BOLD}${i + 1}${RESET}) ${options[i].label}`);
    }
    const promptForChoice = (): void => {
      rl.question(`\nChoice [1-${options.length}]: `, (answer: string) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        if (idx >= 0 && idx < options.length) {
          resolve(options[idx].value);
        } else {
          warn(`Please enter a number between 1 and ${options.length}.`);
          promptForChoice();
        }
      });
    };
    promptForChoice();
  });
}

function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    rl.question(`${question} [${hint}]: `, (answer: string) => {
      const a = answer.trim().toLowerCase();
      resolve(a === '' ? defaultYes : a === 'y' || a === 'yes');
    });
  });
}

/** Prompt for masked input (secrets). */
function askSecret(message: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(message);
    let value = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', onData);
          origWrite('\n');
          resolve(value);
          return;
        } else if (ch === '\u0003') {
          process.stdin.setRawMode?.(false);
          process.exit(1);
        } else if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            origWrite('\b \b');
          }
        } else {
          value += ch;
          origWrite('•');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

// ── Skill discovery ─────────────────────────────────────────────

interface DiscoveredSkill {
  manifest: SkillManifest;
  config: SkillConfig;
  sourceDir: string;
}

/**
 * Discover all available skills from default-skills and user skills directories.
 */
async function discoverSkills(skillsDir: string): Promise<DiscoveredSkill[]> {
  const dirs: string[] = [];

  // Default skills bundled with the installation
  const repoRoot = new URL('../../../../', import.meta.url).pathname;
  const defaultSkillsDir = join(repoRoot, 'default-skills');
  if (existsSync(defaultSkillsDir)) dirs.push(defaultSkillsDir);

  // User skills directory
  if (existsSync(skillsDir)) dirs.push(skillsDir);

  const results: DiscoveredSkill[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    try {
      const loader = new SkillLoader(dir);
      const manifests = await loader.discoverAll();
      for (const m of manifests) {
        if (!seen.has(m.name)) {
          seen.add(m.name);
          results.push({
            manifest: m,
            config: readSkillConfig(skillsDir, m.name),
            sourceDir: dir,
          });
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  return results;
}

/**
 * Get the status string and raw status for a skill.
 */
function getSkillStatus(skill: DiscoveredSkill): { label: string; raw: 'configured' | 'needs-setup' | 'disabled' | 'no-setup' } {
  const { manifest, config } = skill;
  if (!config.enabled) {
    return { label: `${RED}disabled${RESET}`, raw: 'disabled' };
  }
  if (manifest.setup?.required && !config.configured) {
    return { label: `${YELLOW}needs setup${RESET}`, raw: 'needs-setup' };
  }
  if (config.configured) {
    return { label: `${GREEN}configured${RESET}`, raw: 'configured' };
  }
  return { label: `${GREEN}ready${RESET}`, raw: 'no-setup' };
}

// ── Skill listing ───────────────────────────────────────────────

function listSkillsTable(skills: DiscoveredSkill[]): void {
  println(`  ${BOLD}${'Name'.padEnd(18)}${'Status'.padEnd(22)}Description${RESET}`);
  println(`  ${'─'.repeat(70)}`);

  for (const skill of skills) {
    const { manifest, config } = skill;
    const name = manifest.name.padEnd(18);
    const status = getSkillStatus(skill);

    // Compute padding to account for ANSI escape codes in status label
    const rawLen = status.raw === 'configured' ? 10 : status.raw === 'needs-setup' ? 11 : status.raw === 'disabled' ? 8 : 5;
    const statusPad = status.label + ' '.repeat(Math.max(0, 14 - rawLen));

    const authInfo = config.authMethod ? ` ${DIM}(${config.authMethod})${RESET}` : '';
    const desc = manifest.description.length > 50
      ? manifest.description.slice(0, 47) + '...'
      : manifest.description;

    println(`  ${name}${statusPad}${desc}${authInfo}`);
  }
}

// ── Auth setup ──────────────────────────────────────────────────

/**
 * Build an env object that includes stored skill config fields.
 */
function buildSkillEnv(skillsDir: string, skillName: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  try {
    const cfg = readSkillConfig(skillsDir, skillName);
    for (const [key, value] of Object.entries(cfg.fields)) {
      if (typeof value === 'string' && value) {
        env[key] = value;
      }
    }
  } catch { /* ignore */ }
  return env;
}

interface AuthResult {
  success: boolean;
  skipped: boolean;
  type?: string;
}

/**
 * Run authentication setup for a skill.
 * Handles oauth, pat, api-key, login, env, and ssh-key methods.
 */
async function runAuthSetup(
  methods: SkillAuthMethod[],
  skillsDir: string,
  skillName: string,
): Promise<AuthResult> {
  // Pick method: single → use it; multiple → prompt
  let method = methods[0];
  if (methods.length === 1) {
    println(`  Auth: ${BOLD}${method.label}${RESET}`);
    if (method.description) println(`  ${DIM}${method.description}${RESET}`);
  } else {
    const options = methods.map((m) => ({
      label: m.label + (m.description ? ` — ${DIM}${m.description}${RESET}` : ''),
      value: m.type,
    }));
    const chosen = await choose('  Choose authentication method:', options);
    method = methods.find((m) => m.type === chosen) ?? methods[0];
  }

  switch (method.type) {
    case 'oauth':
    case 'login': {
      if (method.command) {
        if (isGhWebAuthCommand(method.command)) {
          const protocol = extractGitProtocol(method.command);
          const ok = await githubDeviceFlowAuth(protocol);
          if (!ok) {
            fail('Authentication failed.');
            return handleAuthFailure(method, skillsDir, skillName, methods);
          }
          success('Authentication complete.');
        } else {
          println(`  Running: ${BOLD}${method.command}${RESET}`);
          try {
            execSync(method.command, { stdio: 'inherit', timeout: 120000 });
            success('Authentication complete.');
          } catch {
            fail('Authentication command failed.');
            return handleAuthFailure(method, skillsDir, skillName, methods);
          }
        }
      }
      break;
    }

    case 'pat':
    case 'api-key': {
      if (method.tokenUrl) {
        println(`  Get your ${method.type === 'pat' ? 'token' : 'API key'} at: ${BLUE}${method.tokenUrl}${RESET}`);
        if (method.scopes?.length) {
          println(`  Required scopes: ${method.scopes.join(', ')}`);
        }
      }
      const label = method.type === 'pat' ? 'personal access token' : 'API key';
      const envVar = method.envVar ?? 'API_KEY';

      // Show current value if exists
      const existing = readSkillConfig(skillsDir, skillName).fields[envVar];
      if (existing && typeof existing === 'string') {
        println(`  ${DIM}Current: ${maskSecret(existing)}${RESET}`);
      }

      const token = await askSecret(`  Enter ${label}: `);
      if (!token?.trim()) {
        if (existing) {
          success(`Keeping existing ${label}.`);
        } else {
          fail(`No ${label} provided.`);
          return handleAuthFailure(method, skillsDir, skillName, methods);
        }
      } else {
        const cfg = readSkillConfig(skillsDir, skillName);
        cfg.fields[envVar] = token.trim();
        writeSkillConfig(skillsDir, cfg);
        println(`  ${DIM}Stored as ${envVar}${RESET}`);
      }
      break;
    }

    case 'env': {
      if (method.envVar) {
        if (process.env[method.envVar]) {
          success(`${method.envVar} is set in environment.`);
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

  // Validate
  if (method.validateCommand) {
    return validateAuth(method, skillsDir, skillName, methods);
  }

  return { success: true, skipped: false, type: method.type };
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
    return handleAuthFailure(method, skillsDir, skillName, allMethods);
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
      { label: `Skip ${skillName} — configure later`, value: 'skip' },
      { label: 'Continue anyway — skill may not work correctly', value: 'continue' },
    ]);

    if (choice === 'skip') {
      return { success: false, skipped: true, type: method.type };
    }
    if (choice === 'continue') {
      return { success: false, skipped: false, type: method.type };
    }

    // Retry
    if (method.type === 'api-key' || method.type === 'pat') {
      if (method.tokenUrl) {
        println(`  Token URL: ${BLUE}${method.tokenUrl}${RESET}`);
      }
      const label = method.type === 'pat' ? 'personal access token' : 'API key';
      const token = await askSecret(`  Re-enter ${label}: `);
      if (token?.trim() && method.envVar) {
        const cfg = readSkillConfig(skillsDir, skillName);
        cfg.fields[method.envVar] = token.trim();
        writeSkillConfig(skillsDir, cfg);
      }
    } else if (method.type === 'oauth' || method.type === 'login') {
      if (method.command) {
        if (isGhWebAuthCommand(method.command)) {
          const protocol = extractGitProtocol(method.command);
          const ok = await githubDeviceFlowAuth(protocol);
          if (!ok) {
            fail('Authentication failed again.');
            continue;
          }
        } else {
          println(`  Running: ${BOLD}${method.command}${RESET}`);
          try {
            execSync(method.command, { stdio: 'inherit', timeout: 120000 });
          } catch {
            fail('Auth command failed again.');
            continue;
          }
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

// ── Field prompting ─────────────────────────────────────────────

async function promptField(field: SkillSetupField, existingValue?: string | number | boolean): Promise<string | number | boolean | undefined> {
  const defaultStr = existingValue !== undefined
    ? String(existingValue)
    : field.default !== undefined ? String(field.default) : undefined;

  if (field.type === 'boolean') {
    const defaultBool = defaultStr === 'true';
    return confirm(
      `  ${field.label}${field.description ? ` (${field.description})` : ''}`,
      defaultBool,
    );
  }

  if (field.type === 'select' && field.options?.length) {
    return choose(`  ${field.label}:`, field.options);
  }

  const hint = defaultStr ? defaultStr : undefined;
  const raw = field.mask
    ? await askSecret(`  ${field.label}${field.description ? ` ${DIM}(${field.description})${RESET}` : ''}${hint ? ` ${DIM}[${maskSecret(hint)}]${RESET}` : ''}: `)
    : await ask(`  ${field.label}${field.description ? ` ${DIM}(${field.description})${RESET}` : ''}`, { default: hint });

  if (!raw && field.required && !existingValue) {
    warn(`Required field "${field.name}" not provided.`);
    return undefined;
  }

  if (!raw) return existingValue;

  if (field.type === 'number') return parseFloat(raw) || ((field.default as number | undefined) ?? 0);
  return raw;
}

// ── Single skill setup ──────────────────────────────────────────

/**
 * Run interactive setup for a single skill.
 * Returns true if configuration was successful.
 */
async function setupSingleSkill(manifest: SkillManifest, skillsDir: string): Promise<boolean> {
  println();
  heading(`Setting up: ${manifest.name}`);
  println(`  ${manifest.description}`);

  if (manifest.setup?.description) {
    println(`  ${DIM}${manifest.setup.description}${RESET}`);
  }
  println();

  const config = readSkillConfig(skillsDir, manifest.name);
  let authSucceeded = true;

  // Auth methods
  if (manifest.setup?.auth?.methods?.length) {
    const authResult = await runAuthSetup(manifest.setup.auth.methods, skillsDir, manifest.name);
    if (authResult.type) config.authMethod = authResult.type;

    if (authResult.skipped) {
      config.enabled = false;
      writeSkillConfig(skillsDir, config);
      warn(`Skipped ${manifest.name}. Configure later with: orionomega setup skills ${manifest.name}`);
      return false;
    }

    if (!authResult.success) {
      warn(`Auth failed for ${manifest.name}. The skill may not work correctly.`);
      authSucceeded = false;
    }
  }

  // Config fields
  if (manifest.setup?.fields?.length) {
    println();
    for (const field of manifest.setup.fields) {
      const existing = config.fields[field.name];
      const value = await promptField(field, existing as string | number | boolean | undefined);
      if (value !== undefined && value !== '') {
        config.fields[field.name] = value;
      }
    }
  }

  // Run setup handler
  if (manifest.setup?.handler) {
    const handlerPath = join(skillsDir, manifest.name, manifest.setup.handler);
    if (existsSync(handlerPath)) {
      print('  Running setup validation... ');
      try {
        const env = buildSkillEnv(skillsDir, manifest.name);
        const result = execSync(`node ${handlerPath}`, {
          encoding: 'utf-8',
          timeout: 30000,
          input: JSON.stringify(config),
          env: { ...process.env, ...env },
        }).trim();
        try {
          const updates = JSON.parse(result) as { fields?: Record<string, string | number | boolean>; validated?: boolean; authMethod?: string };
          if (updates.fields) Object.assign(config.fields, updates.fields);
          if (updates.authMethod) config.authMethod = updates.authMethod;
          if (updates.validated === false) {
            fail('Setup handler rejected the configuration.');
            return false;
          }
        } catch { /* non-JSON output is fine */ }
        success('Validation passed.');
      } catch (err: unknown) {
        fail(`Setup handler failed: ${err instanceof Error ? err.message : String(err)}`);
        warn(`You can retry with: orionomega setup skills ${manifest.name}`);
        return false;
      }
    }
  }

  config.enabled = true;
  config.configured = authSucceeded;
  config.configuredAt = new Date().toISOString();
  writeSkillConfig(skillsDir, config);

  if (authSucceeded) {
    success(`Skill "${manifest.name}" is configured and enabled.`);
  } else {
    warn(`Skill "${manifest.name}" is enabled but auth may not be working.`);
  }

  return authSucceeded;
}

// ── Install default skill to user dir ───────────────────────────

function ensureSkillInstalled(manifest: SkillManifest, sourceDir: string, skillsDir: string): void {
  const dest = join(skillsDir, manifest.name);
  const src = join(sourceDir, manifest.name);
  if (!existsSync(dest) && existsSync(src)) {
    cpSync(src, dest, { recursive: true });
    try {
      execSync(`find ${dest}/handlers -name "*.js" -exec chmod +x {} \\; 2>/dev/null || true`);
    } catch { /* ignore */ }
    println(`  ${DIM}Installed: ${manifest.name}${RESET}`);
  }
}

// ── Main entry point ────────────────────────────────────────────

/**
 * Run the standalone skill setup command.
 *
 * @param args - Optional arguments: [skillName] to configure a specific skill.
 */
export async function runSetupSkills(args: string[] = []): Promise<void> {
  const config = readConfig();
  const skillsDir = config.skills.directory;

  // Ensure skills directory exists
  if (!existsSync(skillsDir)) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(skillsDir, { recursive: true });
  }

  const skills = await discoverSkills(skillsDir);

  if (skills.length === 0) {
    println(`\n  ${YELLOW}No skills found.${RESET}`);
    println(`  Install skills with: ${BOLD}orionomega skill install <path>${RESET}\n`);
    return;
  }

  const targetName = args[0];

  initRL();

  try {
    if (targetName) {
      // ── Configure a specific skill ────────────────────────
      const skill = skills.find((s) => s.manifest.name === targetName);
      if (!skill) {
        fail(`Skill "${targetName}" not found.`);
        println();
        println(`  Available skills: ${skills.map((s) => s.manifest.name).join(', ')}`);
        return;
      }

      ensureSkillInstalled(skill.manifest, skill.sourceDir, skillsDir);
      await setupSingleSkill(skill.manifest, skillsDir);
    } else {
      // ── Interactive: list all and configure ───────────────
      heading('Skill Setup');
      println('  Configure skills to enable integrations with external services.\n');

      listSkillsTable(skills);
      println();

      // Prompt for selection
      println(`  Enter skill numbers to configure (comma-separated), ${BOLD}all${RESET} to configure all,`);
      println(`  or a skill name directly.`);
      println();

      for (let i = 0; i < skills.length; i++) {
        const tag = skills[i].manifest.setup?.required && !skills[i].config.configured
          ? ` ${YELLOW}← needs setup${RESET}`
          : '';
        println(`  ${BOLD}${i + 1}${RESET}) ${skills[i].manifest.name}${tag}`);
      }
      println();

      const selection = await ask("Select skills to configure", { default: 'all' });

      let selected: DiscoveredSkill[];
      if (selection.toLowerCase() === 'all') {
        selected = skills;
      } else {
        // Try parsing as numbers first, then as skill names
        const parts = selection.split(',').map((s) => s.trim());
        selected = [];
        for (const part of parts) {
          const idx = parseInt(part, 10) - 1;
          if (idx >= 0 && idx < skills.length) {
            selected.push(skills[idx]);
          } else {
            const byName = skills.find((s) => s.manifest.name === part);
            if (byName) selected.push(byName);
          }
        }
      }

      if (selected.length === 0) {
        warn('No skills selected.');
        return;
      }

      success(`Selected: ${selected.map((s) => s.manifest.name).join(', ')}`);

      // Install and configure each selected skill
      let configured = 0;
      let failed = 0;

      for (const skill of selected) {
        ensureSkillInstalled(skill.manifest, skill.sourceDir, skillsDir);

        if (!skill.manifest.setup?.required && !skill.manifest.setup?.auth?.methods?.length) {
          // No setup needed — just enable
          const cfg = readSkillConfig(skillsDir, skill.manifest.name);
          cfg.enabled = true;
          if (!cfg.configured) {
            cfg.configured = true;
            cfg.configuredAt = new Date().toISOString();
          }
          writeSkillConfig(skillsDir, cfg);
          success(`${skill.manifest.name} — enabled (no setup required).`);
          configured++;
          continue;
        }

        // Check if already configured — ask to reconfigure
        if (skill.config.configured) {
          const reconfigure = await confirm(
            `  ${skill.manifest.name} is already configured. Reconfigure?`,
            false,
          );
          if (!reconfigure) {
            println(`  ${DIM}Skipping ${skill.manifest.name}${RESET}`);
            continue;
          }
        }

        const ok = await setupSingleSkill(skill.manifest, skillsDir);
        if (ok) configured++;
        else failed++;
      }

      // Summary
      println();
      println(`${DIM}${'─'.repeat(50)}${RESET}`);
      heading('Skill Setup Summary');
      if (configured > 0) success(`${configured} skill(s) configured successfully.`);
      if (failed > 0) warn(`${failed} skill(s) failed or were skipped.`);

      // Refresh and show final status
      const updatedSkills = await discoverSkills(skillsDir);
      println();
      listSkillsTable(updatedSkills);
      println();

      println(`  ${DIM}Reconfigure anytime with: ${BOLD}orionomega setup skills [name]${RESET}`);
      println();
    }
  } finally {
    closeRL();
  }
}

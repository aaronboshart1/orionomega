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
 * Shows available skills with status and selection numbers in a single unified
 * listing, then guides through authentication and configuration for each.
 */

import { existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { readConfig } from '../config/index.js';
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { SkillManifest, SkillAuthMethod, SkillSetupField, SkillConfig } from '@orionomega/skills-sdk';
import { githubDeviceFlowAuth, isGhWebAuthCommand, extractGitProtocol } from './github-device-auth.js';
import {
  GREEN, RED, YELLOW, BLUE, CYAN, BOLD, DIM, RESET,
  print, println, success, fail, warn, heading,
  maskSecret, initRL, closeRL, ask, choose, confirm,
  chmodJsFiles,
} from './cli-utils.js';

// ── Skill discovery ─────────────────────────────────────────────

interface DiscoveredSkill {
  manifest: SkillManifest;
  config: SkillConfig;
  sourceDir: string;
}

async function discoverSkills(skillsDir: string): Promise<DiscoveredSkill[]> {
  const dirs: string[] = [];

  const repoRoot = new URL('../../../../', import.meta.url).pathname;
  const defaultSkillsDir = join(repoRoot, 'default-skills');
  if (existsSync(defaultSkillsDir)) dirs.push(defaultSkillsDir);

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

// ── Unified skill listing ───────────────────────────────────────

function listSkillsNumbered(skills: DiscoveredSkill[]): void {
  println(`  ${BOLD}${'#'.padEnd(4)}${'Name'.padEnd(18)}${'Status'.padEnd(22)}Description${RESET}`);
  println(`  ${'─'.repeat(74)}`);

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const { manifest, config } = skill;
    const num = `${BOLD}${i + 1}${RESET})`.padEnd(4 + BOLD.length + RESET.length);
    const name = manifest.name.padEnd(18);
    const status = getSkillStatus(skill);

    const rawLen = status.raw === 'configured' ? 10 : status.raw === 'needs-setup' ? 11 : status.raw === 'disabled' ? 8 : 5;
    const statusPad = status.label + ' '.repeat(Math.max(0, 14 - rawLen));

    const authInfo = config.authMethod ? ` ${DIM}(${config.authMethod})${RESET}` : '';
    const desc = manifest.description.length > 40
      ? manifest.description.slice(0, 37) + '...'
      : manifest.description;

    println(`  ${num}${name}${statusPad}${desc}${authInfo}`);
  }
}

// ── Auth setup ──────────────────────────────────────────────────

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

async function runAuthSetup(
  methods: SkillAuthMethod[],
  skillsDir: string,
  skillName: string,
): Promise<AuthResult> {
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

      const existing = readSkillConfig(skillsDir, skillName).fields[envVar];
      if (existing && typeof existing === 'string') {
        println(`  ${DIM}Current: ${maskSecret(existing)}${RESET}`);
      }

      const token = await ask(`  Enter ${label}`);
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

    if (method.type === 'api-key' || method.type === 'pat') {
      if (method.tokenUrl) {
        println(`  Token URL: ${BLUE}${method.tokenUrl}${RESET}`);
      }
      const label = method.type === 'pat' ? 'personal access token' : 'API key';
      const token = await ask(`  Re-enter ${label}`);
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
  const raw = await ask(`  ${field.label}${field.description ? ` ${DIM}(${field.description})${RESET}` : ''}`, { default: hint });

  if (!raw && field.required && !existingValue) {
    warn(`Required field "${field.name}" not provided.`);
    return undefined;
  }

  if (!raw) return existingValue;

  if (field.type === 'number') return parseFloat(raw) || ((field.default as number | undefined) ?? 0);
  return raw;
}

// ── Single skill setup ──────────────────────────────────────────

async function setupSingleSkill(manifest: SkillManifest, skillsDir: string): Promise<boolean> {
  println();
  println(`  ${BOLD}${BLUE}Setting up: ${manifest.name}${RESET}`);
  println(`  ${manifest.description}`);

  if (manifest.setup?.description) {
    println(`  ${DIM}${manifest.setup.description}${RESET}`);
  }
  println();

  const config = readSkillConfig(skillsDir, manifest.name);
  let authSucceeded = true;

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

  if (manifest.setup?.handler) {
    const handlerPath = join(skillsDir, manifest.name, manifest.setup.handler);
    if (existsSync(handlerPath)) {
      print('  Running setup validation... ');
      try {
        const env = buildSkillEnv(skillsDir, manifest.name);
        const result = execFileSync('node', [handlerPath], {
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
    chmodJsFiles(join(dest, 'handlers'));
    println(`  ${DIM}Installed: ${manifest.name}${RESET}`);
  }
}

// ── Main entry point ────────────────────────────────────────────

export async function runSetupSkills(args: string[] = []): Promise<void> {
  const config = readConfig();
  const skillsDir = config.skills.directory;

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
      println();
      println(`  ${BOLD}${BLUE}Skill Setup${RESET}`);
      println(`  ${DIM}Configure skills to enable integrations with external services.${RESET}`);
      println();

      listSkillsNumbered(skills);
      println();

      println(`  ${DIM}Enter skill numbers (comma-separated), ${BOLD}all${RESET}${DIM} to configure all, or a skill name.${RESET}`);
      println();

      const selection = await ask("Select skills to configure", { default: 'all' });

      let selected: DiscoveredSkill[];
      if (selection.toLowerCase() === 'all') {
        selected = skills;
      } else {
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

      let configured = 0;
      let failed = 0;

      for (const skill of selected) {
        ensureSkillInstalled(skill.manifest, skill.sourceDir, skillsDir);

        if (!skill.manifest.setup?.required && !skill.manifest.setup?.auth?.methods?.length) {
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

      println();
      println(`${DIM}${'─'.repeat(50)}${RESET}`);
      println();
      println(`  ${BOLD}${BLUE}Skill Setup Summary${RESET}`);
      println();
      if (configured > 0) success(`${configured} skill(s) configured successfully.`);
      if (failed > 0) warn(`${failed} skill(s) failed or were skipped.`);

      const updatedSkills = await discoverSkills(skillsDir);
      println();
      listSkillsNumbered(updatedSkills);
      println();

      println(`  ${DIM}Reconfigure anytime with: ${BOLD}orionomega setup skills [name]${RESET}`);
      println();
    }
  } finally {
    closeRL();
  }
}

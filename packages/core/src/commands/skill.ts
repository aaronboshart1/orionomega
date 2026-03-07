/**
 * @module commands/skill
 * Manage OrionOmega skills: list, install, create, test.
 */

import { existsSync, cpSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readConfig } from "../config/index.js";
import { SkillLoader, readSkillConfig, writeSkillConfig } from "@orionomega/skills-sdk";
import type { SkillManifest, SkillConfig } from "@orionomega/skills-sdk";

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Dynamically load the skills SDK (optional dependency). */
async function loadSDK(): Promise<Record<string, unknown> | null> {
  try {
    return await (Function('return import("@orionomega/skills-sdk")')() as Promise<Record<string, unknown>>);
  } catch {
    process.stdout.write(`${RED}✗${RESET} Skills SDK not available. Run ${BOLD}pnpm build${RESET} first.\n`);
    return null;
  }
}

/**
 * Handle skill subcommands: list, install, create, test.
 */
export async function runSkill(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || !['list', 'install', 'create', 'test', 'setup', 'enable', 'disable'].includes(sub)) {
    process.stdout.write(`\n${BOLD}Usage:${RESET} orionomega skill <list|install|create|test> [args]\n\n`);
    process.stdout.write(`  ${BOLD}list${RESET}              List installed skills\n`);
    process.stdout.write(`  ${BOLD}install${RESET} <path>     Install a skill from a directory\n`);
    process.stdout.write(`  ${BOLD}create${RESET} <name>      Scaffold a new skill\n`);
    process.stdout.write(`  ${BOLD}test${RESET} <name>        Run a skill's health check\n\n`);
    return;
  }

  const config = readConfig();

  try {
    switch (sub) {
      case 'list': await listSkills(config.skills.directory); break;
      case 'install': await installSkill(args[1], config.skills.directory); break;
      case 'create': await createSkill(args[1], config.skills.directory); break;
      case 'test': await testSkill(args[1], config.skills.directory); break;
      case 'setup': await setupSkill(args[1], config.skills.directory); break;
      case 'enable': await toggleSkill(args[1], config.skills.directory, true); break;
      case 'disable': await toggleSkill(args[1], config.skills.directory, false); break;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET} ${msg}\n`);
  }
}

async function listSkills(skillsDir: string): Promise<void> {
  const sdk = await loadSDK();
  if (!sdk) return;

  const SkillLoader = sdk.SkillLoader as new (dir: string) => {
    discoverAll(): Promise<Array<{ name: string; version: string; description: string }>>;
  };

  const loader = new SkillLoader(skillsDir);
  const skills = await loader.discoverAll();

  if (skills.length === 0) {
    process.stdout.write(`\n  No skills installed in ${DIM}${skillsDir}${RESET}\n`);
    process.stdout.write(`  Create one with: ${BOLD}orionomega skill create my-skill${RESET}\n\n`);
    return;
  }

  process.stdout.write(`\n${BOLD}Installed Skills${RESET}\n\n`);
  process.stdout.write(`  ${BOLD}${'Name'.padEnd(25)}${'Version'.padEnd(12)}Description${RESET}\n`);
  process.stdout.write(`  ${'─'.repeat(60)}\n`);

  for (const s of skills) {
    const cfg = readSkillConfig(skillsDir, (s as any).name ?? 'unknown');
    const name = ((s as any).name ?? 'unknown').padEnd(18);
    const ver = ((s as any).version ?? '-').padEnd(10);
    const manifest = s as any;
    let status: string;
    if (!cfg.enabled) {
      status = RED + 'disabled' + RESET;
    } else if (manifest.setup?.required && !cfg.configured) {
      status = YELLOW + 'needs setup' + RESET;
    } else {
      status = GREEN + 'ready' + RESET;
    }
    const statusPad = status + ' '.repeat(Math.max(0, 14 - (cfg.enabled ? (manifest.setup?.required && !cfg.configured ? 11 : 5) : 8)));
    const desc = (s as any).description ?? '';
    process.stdout.write('  ' + name + ver + statusPad + desc + '\n');
  }
  process.stdout.write('\n');
}

async function installSkill(sourcePath: string | undefined, skillsDir: string): Promise<void> {
  if (!sourcePath) {
    process.stdout.write(`${RED}✗${RESET} Usage: orionomega skill install <path>\n`);
    return;
  }

  if (!existsSync(sourcePath)) {
    process.stdout.write(`${RED}✗${RESET} Path not found: ${sourcePath}\n`);
    return;
  }

  const name = basename(sourcePath);
  const dest = join(skillsDir, name);

  if (existsSync(dest)) {
    process.stdout.write(`${YELLOW}⚠${RESET} Skill "${name}" already exists. Overwriting.\n`);
  }

  cpSync(sourcePath, dest, { recursive: true });
  process.stdout.write(`${GREEN}✓${RESET} Skill "${name}" installed to ${dest}\n`);

  // Try to run hooks
  const sdk = await loadSDK();
  if (sdk) {
    try {
      const SkillLoader = sdk.SkillLoader as new (dir: string) => {
        load(name: string): Promise<{
          postInstall?(): Promise<void>;
          healthCheck?(): Promise<{ ok: boolean }>;
        }>;
      };
      const loader = new SkillLoader(skillsDir);
      const skill = await loader.load(name);
      if (typeof skill.postInstall === 'function') {
        await skill.postInstall();
        process.stdout.write(`${GREEN}✓${RESET} Post-install hook completed\n`);
      }
      if (typeof skill.healthCheck === 'function') {
        const result = await skill.healthCheck();
        if (result.ok) {
          process.stdout.write(`${GREEN}✓${RESET} Health check passed\n`);
        } else {
          process.stdout.write(`${YELLOW}⚠${RESET} Health check returned warnings\n`);
        }
      }
    } catch {
      // Hooks are optional
    }
  }
}

async function createSkill(name: string | undefined, skillsDir: string): Promise<void> {
  if (!name) {
    process.stdout.write(`${RED}✗${RESET} Usage: orionomega skill create <name>\n`);
    return;
  }

  const sdk = await loadSDK();
  if (!sdk) return;

  try {
    const scaffoldSkill = sdk.scaffoldSkill as (name: string, dir: string) => Promise<void>;
    await scaffoldSkill(name, skillsDir);
    process.stdout.write(`${GREEN}✓${RESET} Skill "${name}" created at ${join(skillsDir, name)}\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET} Failed to scaffold skill: ${msg}\n`);
  }
}

async function testSkill(name: string | undefined, skillsDir: string): Promise<void> {
  if (!name) {
    process.stdout.write(`${RED}✗${RESET} Usage: orionomega skill test <name>\n`);
    process.stdout.write(`  ${BOLD}setup${RESET} <name>      Run interactive setup for a skill\n`);    process.stdout.write(`  ${BOLD}enable${RESET} <name>     Enable a skill\n`);    process.stdout.write(`  ${BOLD}disable${RESET} <name>    Disable a skill\n`);
    return;
  }

  const sdk = await loadSDK();
  if (!sdk) return;

  try {
    const SkillLoader = sdk.SkillLoader as new (dir: string) => {
      load(name: string): Promise<{
        healthCheck?(): Promise<{ ok: boolean; message?: string }>;
      }>;
    };
    const loader = new SkillLoader(skillsDir);
    const skill = await loader.load(name);

    if (typeof skill.healthCheck !== 'function') {
      process.stdout.write(`${YELLOW}⚠${RESET} Skill "${name}" has no healthCheck hook\n`);
      return;
    }

    const result = await skill.healthCheck();
    if (result.ok) {
      process.stdout.write(`${GREEN}✓${RESET} Skill "${name}" is healthy${result.message ? `: ${result.message}` : ''}\n`);
    } else {
      process.stdout.write(`${RED}✗${RESET} Skill "${name}" health check failed${result.message ? `: ${result.message}` : ''}\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET} ${msg}\n`);
  }
}

async function setupSkill(name: string | undefined, skillsDir: string): Promise<void> {
  if (!name) {
    process.stdout.write(`${RED}✗${RESET} Usage: orionomega skill setup <name>\n`);
    return;
  }

  const sdk = await loadSDK();
  if (!sdk) return;

  const SkillLoaderCls = sdk.SkillLoader as new (dir: string) => {
    discoverAll(): Promise<SkillManifest[]>;
  };

  const loader = new SkillLoaderCls(skillsDir);
  const manifests = await loader.discoverAll();
  const manifest = manifests.find((m) => m.name === name);

  if (!manifest) {
    process.stdout.write(`${RED}✗${RESET} Skill "${name}" not found in ${skillsDir}\n`);
    return;
  }

  if (!manifest.setup) {
    process.stdout.write(`${YELLOW}⚠${RESET} Skill "${name}" has no setup configuration.\n`);
    return;
  }

  process.stdout.write(`\n${BOLD}Setting up: ${name}${RESET}\n`);
  if (manifest.setup.description) {
    process.stdout.write(`  ${manifest.setup.description}\n\n`);
  }

  const config = readSkillConfig(skillsDir, name);

  // Auth methods
  if (manifest.setup.auth?.methods?.length) {
    const methods = manifest.setup.auth.methods;
    process.stdout.write(`\nAuthentication methods:\n`);
    for (let i = 0; i < methods.length; i++) {
      process.stdout.write(`  ${BOLD}${i + 1}${RESET}) ${methods[i].label}${methods[i].description ? ` — ${DIM}${methods[i].description}${RESET}` : ''}\n`);
    }
    // For non-interactive CLI: run the first method's command if available
    const method = methods[0];
    if (method.command) {
      process.stdout.write(`\nRunning: ${BOLD}${method.command}${RESET}\n`);
      try {
        const { execSync: exec } = await import('node:child_process');
        exec(method.command, { stdio: 'inherit', timeout: 120000 });
        config.authMethod = method.type;
        process.stdout.write(`${GREEN}✓${RESET} Authentication complete.\n`);
      } catch {
        process.stdout.write(`${RED}✗${RESET} Authentication failed.\n`);
      }
    }

    // Validate
    if (method.validateCommand) {
      try {
        const { execSync: exec } = await import('node:child_process');
        exec(method.validateCommand, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
        process.stdout.write(`${GREEN}✓${RESET} Auth validated.\n`);
      } catch {
        process.stdout.write(`${RED}✗${RESET} Auth validation failed.\n`);
      }
    }
  }

  // Run setup handler
  if (manifest.setup.handler) {
    const handlerPath = join(skillsDir, name, manifest.setup.handler);
    if (existsSync(handlerPath)) {
      process.stdout.write(`  Running setup handler... `);
      try {
        const { execSync: exec } = await import('node:child_process');
        const result = exec(`node ${handlerPath}`, {
          encoding: 'utf-8',
          timeout: 30000,
          input: JSON.stringify(config),
        }).trim();
        try {
          const updates = JSON.parse(result);
          if (updates.fields) Object.assign(config.fields, updates.fields);
        } catch {}
        process.stdout.write(`${GREEN}✓${RESET}\n`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`${RED}✗ ${msg}${RESET}\n`);
      }
    }
  }

  config.enabled = true;
  config.configured = true;
  config.configuredAt = new Date().toISOString();
  writeSkillConfig(skillsDir, config);
  process.stdout.write(`${GREEN}✓${RESET} Skill "${name}" is configured and enabled.\n`);
}

async function toggleSkill(name: string | undefined, skillsDir: string, enable: boolean): Promise<void> {
  if (!name) {
    process.stdout.write(`${RED}✗${RESET} Usage: orionomega skill ${enable ? 'enable' : 'disable'} <name>\n`);
    return;
  }

  const config = readSkillConfig(skillsDir, name);
  config.enabled = enable;
  writeSkillConfig(skillsDir, config);
  process.stdout.write(`${GREEN}✓${RESET} Skill "${name}" ${enable ? 'enabled' : 'disabled'}.\n`);
}

/**
 * @module skill-config
 * Read, write, and query persisted skill configuration files.
 *
 * Configuration files are stored at:
 *   `{skillsDir}/{skillName}/config.json`
 *
 * All functions are synchronous to avoid requiring callers to `await` simple
 * config reads in hot paths (e.g. skill trigger matching and health checks).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SkillConfig, SkillManifest } from './types.js';

function configPath(skillsDir: string, skillName: string): string {
  return path.join(path.resolve(skillsDir), skillName, 'config.json');
}

function defaultConfig(skillName: string): SkillConfig {
  return {
    name: skillName,
    enabled: true,
    configured: false,
    fields: {},
  };
}

export function readSkillConfig(skillsDir: string, skillName: string): SkillConfig {
  const p = configPath(skillsDir, skillName);

  if (!existsSync(p)) {
    return defaultConfig(skillName);
  }

  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as SkillConfig;
    return {
      name: parsed.name ?? skillName,
      enabled: parsed.enabled ?? true,
      configured: parsed.configured ?? false,
      authMethod: parsed.authMethod,
      configuredAt: parsed.configuredAt,
      fields: parsed.fields ?? {},
    };
  } catch {
    return defaultConfig(skillName);
  }
}

export function writeSkillConfig(
  skillsDir: string,
  skillNameOrConfig: string | SkillConfig,
  config?: SkillConfig,
): void {
  let skillName: string;
  let configObj: SkillConfig;

  if (typeof skillNameOrConfig === 'string') {
    skillName = skillNameOrConfig;
    configObj = config!;
  } else {
    configObj = skillNameOrConfig;
    skillName = configObj.name;
  }

  const dir = path.join(path.resolve(skillsDir), skillName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(configObj, null, 2),
    'utf-8',
  );
}

export function isSkillReady(config: SkillConfig, manifest: SkillManifest): boolean {
  if (!config.enabled) return false;
  if (manifest.setup?.required && !config.configured) return false;
  return true;
}

export function listSkillConfigs(skillsDir: string): SkillConfig[] {
  const resolved = path.resolve(skillsDir);
  const configs: SkillConfig[] = [];

  if (!existsSync(resolved)) {
    return configs;
  }

  try {
    const entries = readdirSync(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = path.join(resolved, entry.name, 'config.json');
      if (!existsSync(p)) continue;
      configs.push(readSkillConfig(resolved, entry.name));
    }
  } catch {
    // Return whatever we collected before the error
  }

  return configs;
}

/**
 * @module skill-config
 * Read, write, and query per-skill configuration files.
 * Config is stored at `{skillsDir}/{name}/config.json`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillConfig, SkillManifest } from './types.js';

/**
 * Read a skill's configuration.
 * Returns a default config if the file doesn't exist.
 */
export function readSkillConfig(skillsDir: string, name: string): SkillConfig {
  const configPath = join(skillsDir, name, 'config.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as SkillConfig;
  } catch {
    return {
      name,
      enabled: true,
      configured: false,
      fields: {},
    };
  }
}

/**
 * Write a skill's configuration.
 * Creates the skill directory if it doesn't exist.
 */
export function writeSkillConfig(skillsDir: string, config: SkillConfig): void {
  const dir = join(skillsDir, config.name);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Check if a skill is configured and enabled.
 * A skill that has no setup.required is always considered configured.
 */
export function isSkillReady(skillsDir: string, manifest: SkillManifest): boolean {
  const config = readSkillConfig(skillsDir, manifest.name);
  if (!config.enabled) return false;
  if (!manifest.setup?.required) return true;
  return config.configured;
}

/**
 * Get configs for all skills in a directory.
 */
export function listSkillConfigs(skillsDir: string, manifests: SkillManifest[]): Array<SkillConfig & { manifest: SkillManifest }> {
  return manifests.map((m) => ({
    ...readSkillConfig(skillsDir, m.name),
    manifest: m,
  }));
}

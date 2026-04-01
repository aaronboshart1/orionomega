import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SkillLoader,
  readSkillConfig,
  writeSkillConfig,
  getSettingsSchema,
  validateSettings,
  resolveSettings,
  maskSecrets,
} from '@orionomega/skills-sdk';
import type { SkillManifest } from '@orionomega/skills-sdk';
import type { SkillConfig, SkillSettingSchema } from '@orionomega/skills-sdk';
import { SkillSettingType } from '@orionomega/skills-sdk';
import { readConfig } from '@orionomega/core';
import type { GatewayConfig } from '../types.js';
import { readBody } from './utils.js';
import { checkAuth } from './auth-utils.js';

const MASK_SENTINEL = '[REDACTED]';

function getDefaultSkillsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = join(thisFile, '..', '..', '..', '..', '..');
  return join(repoRoot, 'default-skills');
}

function getConfiguredSkillsDir(): string {
  try {
    const cfg = readConfig();
    const dir = cfg.skills?.directory;
    if (dir) return dir;
  } catch {}
  return join(getDefaultSkillsDir(), '..', '.orionomega', 'skills');
}

async function loadFromDir(
  dir: string,
  seen: Set<string>,
  manifests: SkillManifest[],
  allowOverride: boolean,
): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    const loader = new SkillLoader(dir);
    for (const m of await loader.discoverAll()) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        manifests.push(m);
      } else if (allowOverride) {
        const idx = manifests.findIndex((existing) => existing.name === m.name);
        if (idx !== -1) manifests[idx] = m;
      }
    }
  } catch {}
}

async function discoverAllSkills(): Promise<{ manifests: SkillManifest[]; configDir: string }> {
  const seen = new Set<string>();
  const manifests: SkillManifest[] = [];
  const configDir = getConfiguredSkillsDir();

  await loadFromDir(getDefaultSkillsDir(), seen, manifests, false);
  await loadFromDir(configDir, seen, manifests, true);

  return { manifests, configDir };
}

function isSecretField(prop: SkillSettingSchema): boolean {
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  return types.includes(SkillSettingType.Password) || prop.widget === 'secret';
}

export function handleGetSkills(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;

  discoverAllSkills().then(({ manifests, configDir }) => {
    const results = manifests.map((manifest) => {
      const config = readSkillConfig(configDir, manifest.name);
      const schema = getSettingsSchema(manifest);
      const resolved = resolveSettings(manifest, config.fields);
      const masked = maskSecrets(resolved, manifest);

      return {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        icon: manifest.icon,
        enabled: config.enabled,
        configured: config.configured,
        schema: schema ?? undefined,
        settings: masked,
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ skills: results }));
  }).catch((err: unknown) => {
    console.error('[skills] Failed to list skills:', err instanceof Error ? err.message : String(err));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
}

export async function handlePutSkillConfig(
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as Partial<SkillConfig> & { settings?: Record<string, unknown> };

    const configDir = getConfiguredSkillsDir();
    const existing = readSkillConfig(configDir, skillName);

    if (payload.enabled !== undefined) {
      existing.enabled = payload.enabled;
    }

    if (payload.settings) {
      const discovered = await discoverAllSkills();
      const manifest = discovered.manifests.find((m) => m.name === skillName);

      const schema = manifest ? getSettingsSchema(manifest) : null;

      if (!manifest) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Skill "${skillName}" not found` }));
        return;
      }

      const cleanSettings: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(payload.settings)) {
        if (value === MASK_SENTINEL) {
          continue;
        }

        if (schema?.properties[key] && isSecretField(schema.properties[key]) && typeof value === 'string' && value.startsWith('••••')) {
          continue;
        }

        cleanSettings[key] = value;
      }

      {
        const merged = { ...existing.fields, ...cleanSettings };
        const resolved = resolveSettings(manifest, merged);
        const validation = validateSettings(manifest, resolved);

        if (!validation.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Settings validation failed',
            details: validation.errors,
          }));
          return;
        }
      }

      for (const [key, value] of Object.entries(cleanSettings)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          existing.fields[key] = value;
        }
      }

      existing.configured = true;
    }

    existing.configuredAt = new Date().toISOString();
    writeSkillConfig(configDir, skillName, existing);

    const safeConfig = {
      name: existing.name,
      enabled: existing.enabled,
      configured: existing.configured,
      configuredAt: existing.configuredAt,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config: safeConfig }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update skill config';
    console.error('[skills] Failed to update skill config:', message);
    const status = message.includes('exceeds limit') ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 413 ? 'Request body too large' : 'Failed to update skill configuration' }));
  }
}

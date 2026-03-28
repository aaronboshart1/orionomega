import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SkillLoader,
  readSkillConfig,
  writeSkillConfig,
  getSettingsSchema,
  validateSettings,
  resolveSettings,
  maskSecrets,
} from '@orionomega/skills-sdk';
import type { SkillConfig, SkillSettingSchema } from '@orionomega/skills-sdk';
import { SkillSettingType } from '@orionomega/skills-sdk';
import { readConfig } from '@orionomega/core';
import { validateToken } from '../auth.js';
import type { GatewayConfig } from '../types.js';

const MASK_SENTINEL = '[REDACTED]';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function checkAuth(req: IncomingMessage, res: ServerResponse, gatewayConfig: GatewayConfig): boolean {
  if (gatewayConfig.auth.mode !== 'api-key' || !gatewayConfig.auth.keyHash) {
    return true;
  }
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return false;
  }
  const result = validateToken(token, gatewayConfig.auth.keyHash);
  if (!result.valid) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication failed' }));
    return false;
  }
  return true;
}

function getSkillsDir(): string {
  try {
    const cfg = readConfig();
    return cfg.skills?.directory ?? 'default-skills';
  } catch {
    return 'default-skills';
  }
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

  try {
    const skillsDir = getSkillsDir();
    const loader = new SkillLoader(skillsDir);

    loader.discoverAll().then((manifests) => {
      const results = manifests.map((manifest) => {
        const config = readSkillConfig(skillsDir, manifest.name);
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
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to list skills' }));
    });
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to list skills' }));
  }
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

    const skillsDir = getSkillsDir();
    const existing = readSkillConfig(skillsDir, skillName);

    if (payload.enabled !== undefined) {
      existing.enabled = payload.enabled;
    }

    if (payload.settings) {
      const loader = new SkillLoader(skillsDir);
      const manifests = await loader.discoverAll();
      const manifest = manifests.find((m) => m.name === skillName);

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
    writeSkillConfig(skillsDir, skillName, existing);

    const safeConfig = {
      name: existing.name,
      enabled: existing.enabled,
      configured: existing.configured,
      configuredAt: existing.configuredAt,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config: safeConfig }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to update skill config' }));
  }
}

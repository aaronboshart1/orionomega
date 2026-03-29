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
import { auditAuthEvent } from '@orionomega/core';
import type { SkillConfig, SkillSettingSchema } from '@orionomega/skills-sdk';
import { SkillSettingType } from '@orionomega/skills-sdk';
import { readConfig } from '@orionomega/core';
import { validateToken } from '../auth.js';
import type { GatewayConfig } from '../types.js';
import { rateLimitAuth, recordAuthFailure, resetAuthFailures } from '../rate-limit.js';

const MASK_SENTINEL = '[REDACTED]';

const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB

function readBody(req: IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy(new Error(`Request body exceeds limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function checkAuth(req: IncomingMessage, res: ServerResponse, gatewayConfig: GatewayConfig): boolean {
  const actor = req.socket.remoteAddress ?? undefined;
  if (gatewayConfig.auth.mode !== 'api-key' || !gatewayConfig.auth.keyHash) {
    return true;
  }
  if (!rateLimitAuth(req, res)) {
    return false;
  }
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    recordAuthFailure(req);
    auditAuthEvent('rest_auth_failed', 'Missing token', actor);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return false;
  }
  const result = validateToken(token, gatewayConfig.auth.keyHash);
  if (!result.valid) {
    recordAuthFailure(req);
    auditAuthEvent('rest_auth_failed', 'Invalid token', actor);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication failed' }));
    return false;
  }
  resetAuthFailures(req);
  auditAuthEvent('rest_auth_success', undefined, actor);
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
      console.error('[skills] Failed to list skills:', err instanceof Error ? err.message : String(err));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
  } catch (err) {
    console.error('[skills] Failed to list skills:', err instanceof Error ? err.message : String(err));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
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
    const message = err instanceof Error ? err.message : 'Failed to update skill config';
    console.error('[skills] Failed to update skill config:', message);
    const status = message.includes('exceeds limit') ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 413 ? 'Request body too large' : 'Failed to update skill configuration' }));
  }
}

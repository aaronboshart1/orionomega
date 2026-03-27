import type { IncomingMessage, ServerResponse } from 'node:http';
import { readConfig } from '@orionomega/core';
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { SkillManifest, SkillConfig } from '@orionomega/skills-sdk';
import { validateToken } from '../auth.js';
import type { GatewayConfig } from '../types.js';

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

function getSkillsDir(): string | undefined {
  try {
    const cfg = readConfig();
    return cfg.skills?.directory;
  } catch {
    return undefined;
  }
}

function maskFieldValue(value: string): string {
  if (!value || value.length <= 4) return value ? '••••' : '';
  return '••••••••' + value.slice(-4);
}

function getAuthFieldKeys(manifest: SkillManifest): Set<string> {
  const keys = new Set<string>();
  if (manifest.setup?.auth?.methods) {
    for (const method of manifest.setup.auth.methods) {
      if (method.type === 'api-key' || method.type === 'pat') {
        const envVar = method.envVar ?? 'API_KEY';
        keys.add(envVar);
      }
    }
  }
  return keys;
}

function maskSkillConfig(
  config: SkillConfig,
  manifest: SkillManifest,
): SkillConfig {
  const masked = JSON.parse(JSON.stringify(config)) as SkillConfig;
  const maskedFields = new Set<string>();

  for (const key of getAuthFieldKeys(manifest)) {
    maskedFields.add(key);
  }

  if (manifest.setup?.fields) {
    for (const field of manifest.setup.fields) {
      if (field.mask) {
        maskedFields.add(field.name);
      }
    }
  }

  for (const fieldName of maskedFields) {
    const val = masked.fields[fieldName];
    if (typeof val === 'string' && val.length > 0) {
      masked.fields[fieldName] = maskFieldValue(val);
    }
  }

  return masked;
}

export interface SkillWithConfig {
  name: string;
  version: string;
  description: string;
  author: string;
  manifest: SkillManifest;
  config: SkillConfig;
  status: 'configured' | 'needs-setup' | 'disabled' | 'no-setup';
}

function getSkillStatus(manifest: SkillManifest, config: SkillConfig): SkillWithConfig['status'] {
  if (!config.enabled) return 'disabled';
  if (manifest.setup?.required && !config.configured) return 'needs-setup';
  if (config.configured) return 'configured';
  return 'no-setup';
}

export async function handleGetSkills(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;

  const skillsDir = getSkillsDir();
  if (!skillsDir) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ skills: [], error: null }));
    return;
  }

  try {
    const loader = new SkillLoader(skillsDir);
    const manifests = await loader.discoverAll();
    const skills: SkillWithConfig[] = manifests.map((manifest) => {
      const config = readSkillConfig(skillsDir, manifest.name);
      const maskedConfig = maskSkillConfig(config, manifest);
      return {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        manifest,
        config: maskedConfig,
        status: getSkillStatus(manifest, config),
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ skills }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to list skills' }));
  }
}

export async function handlePutSkillConfig(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
  skillName: string,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;

  const skillsDir = getSkillsDir();
  if (!skillsDir) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Skills directory not configured' }));
    return;
  }

  try {
    const body = await readBody(req);
    const update = JSON.parse(body) as Partial<SkillConfig>;

    const loader = new SkillLoader(skillsDir);
    const manifests = await loader.discoverAll();
    const manifest = manifests.find((m) => m.name === skillName);

    if (!manifest) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Skill "${skillName}" not found` }));
      return;
    }

    const existing = readSkillConfig(skillsDir, skillName);

    if (update.enabled !== undefined) {
      existing.enabled = update.enabled;
    }
    if (update.authMethod !== undefined) {
      existing.authMethod = update.authMethod;
    }
    if (update.fields) {
      for (const [key, value] of Object.entries(update.fields)) {
        if (typeof value === 'string' && value.startsWith('••••')) {
          continue;
        }
        existing.fields[key] = value;
      }
    }

    const hasSetup = update.fields && Object.keys(update.fields).some(
      (k) => {
        const v = update.fields![k];
        return !(typeof v === 'string' && v.startsWith('••••'));
      }
    );
    if (hasSetup) {
      existing.configured = true;
      existing.configuredAt = new Date().toISOString();
    }

    writeSkillConfig(skillsDir, existing);

    const maskedConfig = maskSkillConfig(existing, manifest);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      config: maskedConfig,
      status: getSkillStatus(manifest, existing),
    }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to update skill config' }));
  }
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readConfig, writeConfig, auditConfigChange, auditAuthEvent } from '@orionomega/core';
import type { OrionOmegaConfig } from '@orionomega/core';
import { validateToken } from '../auth.js';
import type { GatewayConfig } from '../types.js';
import { rateLimitAuth, recordAuthFailure, resetAuthFailures } from '../rate-limit.js';

const VALID_TOP_LEVEL_KEYS = new Set([
  'gateway', 'hindsight', 'models', 'orchestration', 'workspace', 'logging', 'skills', 'autonomous', 'agentSdk', 'webui', 'commands',
]);

const VALID_AUTH_MODES = new Set(['api-key', 'none']);
const VALID_LOG_LEVELS = new Set(['error', 'warn', 'info', 'verbose', 'debug']);
const VALID_PERMISSION_MODES = new Set(['acceptEdits', 'bypassPermissions', 'default']);
const VALID_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max']);

function maskApiKey(key: string): string {
  if (!key || key.length <= 4) return key ? '••••' : '';
  return '••••••••' + key.slice(-4);
}

function maskConfig(config: OrionOmegaConfig): Record<string, unknown> {
  const masked = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const models = masked.models as Record<string, unknown>;
  if (models && typeof models.apiKey === 'string') {
    models.apiKey = maskApiKey(models.apiKey);
  }
  return masked;
}

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

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    const existing = target[key];
    if (
      val !== null &&
      val !== undefined &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      existing !== null &&
      existing !== undefined &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(
        existing as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

function validateConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];

  for (const key of Object.keys(config)) {
    if (!VALID_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`Unknown top-level key: ${key}`);
    }
  }

  const gateway = config.gateway as Record<string, unknown> | undefined;
  if (gateway) {
    if (gateway.port !== undefined && (typeof gateway.port !== 'number' || gateway.port < 1 || gateway.port > 65535)) {
      errors.push('gateway.port must be a number between 1 and 65535');
    }
    if (gateway.bind !== undefined && typeof gateway.bind !== 'string') {
      if (Array.isArray(gateway.bind)) {
        if (!gateway.bind.every((b: unknown) => typeof b === 'string')) {
          errors.push('gateway.bind array entries must be strings');
        }
      } else {
        errors.push('gateway.bind must be a string or array of strings');
      }
    }
    const auth = gateway.auth as Record<string, unknown> | undefined;
    if (auth?.mode !== undefined && !VALID_AUTH_MODES.has(String(auth.mode))) {
      errors.push(`gateway.auth.mode must be one of: ${[...VALID_AUTH_MODES].join(', ')}`);
    }
    const cors = gateway.cors as Record<string, unknown> | undefined;
    if (cors?.origins !== undefined && !Array.isArray(cors.origins)) {
      errors.push('gateway.cors.origins must be an array');
    }
  }

  const models = config.models as Record<string, unknown> | undefined;
  if (models) {
    if (models.apiKey !== undefined && typeof models.apiKey !== 'string') {
      errors.push('models.apiKey must be a string');
    }
    if (models.default !== undefined && typeof models.default !== 'string') {
      errors.push('models.default must be a string');
    }
    if (models.planner !== undefined && typeof models.planner !== 'string') {
      errors.push('models.planner must be a string');
    }
    if (models.cheap !== undefined && typeof models.cheap !== 'string') {
      errors.push('models.cheap must be a string');
    }
    if (models.workers !== undefined && (typeof models.workers !== 'object' || Array.isArray(models.workers))) {
      errors.push('models.workers must be an object');
    }
  }

  const logging = config.logging as Record<string, unknown> | undefined;
  if (logging) {
    if (logging.level !== undefined && !VALID_LOG_LEVELS.has(String(logging.level))) {
      errors.push(`logging.level must be one of: ${[...VALID_LOG_LEVELS].join(', ')}`);
    }
    if (logging.maxFiles !== undefined && (typeof logging.maxFiles !== 'number' || logging.maxFiles < 1)) {
      errors.push('logging.maxFiles must be a positive number');
    }
    if (logging.console !== undefined && typeof logging.console !== 'boolean') {
      errors.push('logging.console must be a boolean');
    }
  }

  const orchestration = config.orchestration as Record<string, unknown> | undefined;
  if (orchestration) {
    if (orchestration.maxSpawnDepth !== undefined && (typeof orchestration.maxSpawnDepth !== 'number' || orchestration.maxSpawnDepth < 1)) {
      errors.push('orchestration.maxSpawnDepth must be a positive number');
    }
    if (orchestration.workerTimeout !== undefined && (typeof orchestration.workerTimeout !== 'number' || orchestration.workerTimeout < 1)) {
      errors.push('orchestration.workerTimeout must be a positive number');
    }
    if (orchestration.maxRetries !== undefined && (typeof orchestration.maxRetries !== 'number' || orchestration.maxRetries < 0)) {
      errors.push('orchestration.maxRetries must be a non-negative number');
    }
    if (orchestration.planFirst !== undefined && typeof orchestration.planFirst !== 'boolean') {
      errors.push('orchestration.planFirst must be a boolean');
    }
  }

  const agentSdk = config.agentSdk as Record<string, unknown> | undefined;
  if (agentSdk) {
    if (agentSdk.enabled !== undefined && typeof agentSdk.enabled !== 'boolean') {
      errors.push('agentSdk.enabled must be a boolean');
    }
    if (agentSdk.permissionMode !== undefined && !VALID_PERMISSION_MODES.has(String(agentSdk.permissionMode))) {
      errors.push(`agentSdk.permissionMode must be one of: ${[...VALID_PERMISSION_MODES].join(', ')}`);
    }
    if (agentSdk.effort !== undefined && !VALID_EFFORT_LEVELS.has(String(agentSdk.effort))) {
      errors.push(`agentSdk.effort must be one of: ${[...VALID_EFFORT_LEVELS].join(', ')}`);
    }
  }

  const autonomous = config.autonomous as Record<string, unknown> | undefined;
  if (autonomous) {
    if (autonomous.enabled !== undefined && typeof autonomous.enabled !== 'boolean') {
      errors.push('autonomous.enabled must be a boolean');
    }
    if (autonomous.maxBudgetUsd !== undefined && (typeof autonomous.maxBudgetUsd !== 'number' || autonomous.maxBudgetUsd < 0)) {
      errors.push('autonomous.maxBudgetUsd must be a non-negative number');
    }
    if (autonomous.autoAdvance !== undefined && typeof autonomous.autoAdvance !== 'boolean') {
      errors.push('autonomous.autoAdvance must be a boolean');
    }
  }

  const hindsight = config.hindsight as Record<string, unknown> | undefined;
  if (hindsight) {
    if (hindsight.url !== undefined && typeof hindsight.url !== 'string') {
      errors.push('hindsight.url must be a string');
    }
    if (hindsight.retainOnComplete !== undefined && typeof hindsight.retainOnComplete !== 'boolean') {
      errors.push('hindsight.retainOnComplete must be a boolean');
    }
    if (hindsight.retainOnError !== undefined && typeof hindsight.retainOnError !== 'boolean') {
      errors.push('hindsight.retainOnError must be a boolean');
    }
  }

  const skills = config.skills as Record<string, unknown> | undefined;
  if (skills) {
    if (skills.directory !== undefined && typeof skills.directory !== 'string') {
      errors.push('skills.directory must be a string');
    }
    if (skills.autoLoad !== undefined && typeof skills.autoLoad !== 'boolean') {
      errors.push('skills.autoLoad must be a boolean');
    }
  }

  const webui = config.webui as Record<string, unknown> | undefined;
  if (webui) {
    if (webui.port !== undefined && (typeof webui.port !== 'number' || webui.port < 1 || webui.port > 65535)) {
      errors.push('webui.port must be a number between 1 and 65535');
    }
    if (webui.bind !== undefined && typeof webui.bind !== 'string') {
      if (Array.isArray(webui.bind)) {
        if (!webui.bind.every((b: unknown) => typeof b === 'string')) {
          errors.push('webui.bind array entries must be strings');
        }
      } else {
        errors.push('webui.bind must be a string or array of strings');
      }
    }
  }

  return errors;
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

export function handleGetConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(_req, res, gatewayConfig)) return;
  try {
    const config = readConfig();
    const masked = maskConfig(config);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(masked));
  } catch (err) {
    console.error('[config] Failed to read config:', err instanceof Error ? err.message : String(err));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

export async function handlePutConfig(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): Promise<boolean> {
  if (!checkAuth(req, res, gatewayConfig)) return false;
  try {
    const body = await readBody(req);
    const partial = JSON.parse(body) as Record<string, unknown>;

    const validationErrors = validateConfig(partial);
    if (validationErrors.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Validation failed', details: validationErrors }));
      return false;
    }

    const current = readConfig();
    const currentObj = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;

    const partialModels = partial.models as Record<string, unknown> | undefined;
    if (partialModels && typeof partialModels.apiKey === 'string') {
      if (partialModels.apiKey.startsWith('••••')) {
        delete partialModels.apiKey;
      }
    }

    const merged = deepMerge(currentObj, partial);

    const mergedValidationErrors = validateConfig(merged);
    if (mergedValidationErrors.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Merged config validation failed', details: mergedValidationErrors }));
      return false;
    }

    writeConfig(merged as unknown as OrionOmegaConfig);
    auditConfigChange('config_update', `Updated keys: ${Object.keys(partial).join(', ')}`, req.socket.remoteAddress ?? undefined);

    const freshConfig = readConfig();
    const masked = maskConfig(freshConfig);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(masked));
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update config';
    console.error('[config] Failed to update config:', message);
    const status = message.includes('exceeds limit') ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 413 ? 'Request body too large' : 'Failed to update configuration' }));
    return false;
  }
}

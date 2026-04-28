import type { IncomingMessage, ServerResponse } from 'node:http';
import { readConfig, writeConfig, auditConfigChange, deepMerge } from '@orionomega/core';
import type { OrionOmegaConfig } from '@orionomega/core';
import type { GatewayConfig } from '../types.js';
import { readBody } from './utils.js';
import { checkAuth } from './auth-utils.js';

const VALID_TOP_LEVEL_KEYS = new Set([
  'gateway', 'hindsight', 'models', 'orchestration', 'workspace', 'logging', 'skills', 'autonomous', 'agentSdk', 'webui', 'commands', 'codingMode',
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

function validateBindAddress(bind: unknown, fieldName: string, errors: string[]): void {
  if (bind !== undefined && typeof bind !== 'string') {
    if (Array.isArray(bind)) {
      if (!bind.every((b: unknown) => typeof b === 'string')) {
        errors.push(`${fieldName} array entries must be strings`);
      }
    } else {
      errors.push(`${fieldName} must be a string or array of strings`);
    }
  }
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
    validateBindAddress(gateway.bind, 'gateway.bind', errors);
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
    if (orchestration.codingAgentTimeout !== undefined && (typeof orchestration.codingAgentTimeout !== 'number' || orchestration.codingAgentTimeout < 1)) {
      errors.push('orchestration.codingAgentTimeout must be a positive number');
    }
    if (orchestration.validationTimeout !== undefined && (typeof orchestration.validationTimeout !== 'number' || orchestration.validationTimeout < 1)) {
      errors.push('orchestration.validationTimeout must be a positive number');
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
    validateBindAddress(webui.bind, 'webui.bind', errors);
  }

  const codingMode = config.codingMode as Record<string, unknown> | undefined;
  if (codingMode) {
    if (codingMode.enabled !== undefined && typeof codingMode.enabled !== 'boolean') {
      errors.push('codingMode.enabled must be a boolean');
    }
    if (codingMode.maxParallelAgents !== undefined && (typeof codingMode.maxParallelAgents !== 'number' || codingMode.maxParallelAgents < 1)) {
      errors.push('codingMode.maxParallelAgents must be a positive number');
    }
    if (codingMode.templates !== undefined && (typeof codingMode.templates !== 'object' || Array.isArray(codingMode.templates))) {
      errors.push('codingMode.templates must be an object');
    }
    if (codingMode.models !== undefined && (typeof codingMode.models !== 'object' || Array.isArray(codingMode.models))) {
      errors.push('codingMode.models must be an object');
    }
    if (codingMode.budgetMultiplier !== undefined && (typeof codingMode.budgetMultiplier !== 'number' || codingMode.budgetMultiplier < 0)) {
      errors.push('codingMode.budgetMultiplier must be a non-negative number');
    }
    const validation = codingMode.validation as Record<string, unknown> | undefined;
    if (validation) {
      if (validation.autoRun !== undefined && typeof validation.autoRun !== 'boolean') {
        errors.push('codingMode.validation.autoRun must be a boolean');
      }
      if (validation.commands !== undefined && !Array.isArray(validation.commands)) {
        errors.push('codingMode.validation.commands must be an array');
      }
    }
  }

  return errors;
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
    let partial: Record<string, unknown>;
    try {
      partial = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return false;
    }

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

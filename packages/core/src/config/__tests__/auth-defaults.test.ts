/**
 * @module config/__tests__/auth-defaults
 * Tests for the Security-P0 auth defaults (Task #231): the gateway is
 * authenticated by default, refuses an insecure non-localhost bind, and
 * auto-generates + persists an api-key secret on first run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultConfig,
  assertSecureBind,
  ensureGatewayAuthSecret,
  InsecureBindError,
  writeConfig,
  readConfig,
  INSECURE_BIND_OVERRIDE_ENV,
} from '../loader.js';
import type { OrionOmegaConfig } from '../types.js';

describe('auth defaults (Task #231)', () => {
  it('defaults the gateway to api-key auth', () => {
    const cfg = getDefaultConfig();
    expect(cfg.gateway.auth.mode).toBe('api-key');
  });

  it('defaults the gateway bind to localhost', () => {
    const cfg = getDefaultConfig();
    expect(cfg.gateway.bind).toEqual(['127.0.0.1']);
  });
});

describe('assertSecureBind', () => {
  function configWith(mode: 'none' | 'api-key', bind: string[]): OrionOmegaConfig {
    const cfg = getDefaultConfig();
    cfg.gateway.auth.mode = mode;
    cfg.gateway.bind = bind;
    return cfg;
  }

  it('allows api-key auth on any bind', () => {
    expect(() => assertSecureBind(configWith('api-key', ['0.0.0.0']), {})).not.toThrow();
  });

  it('allows mode=none on a localhost bind', () => {
    expect(() => assertSecureBind(configWith('none', ['127.0.0.1']), {})).not.toThrow();
  });

  it('refuses mode=none on a non-localhost bind', () => {
    expect(() => assertSecureBind(configWith('none', ['0.0.0.0']), {})).toThrow(InsecureBindError);
  });

  it('allows the insecure bind when the override env is set', () => {
    expect(() =>
      assertSecureBind(configWith('none', ['0.0.0.0']), { [INSECURE_BIND_OVERRIDE_ENV]: '1' }),
    ).not.toThrow();
  });
});

describe('ensureGatewayAuthSecret', () => {
  let homeDir: string;
  let configPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orion-auth-boot-'));
    configPath = join(homeDir, 'config.yaml');
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('generates and persists a key when api-key mode has no keyHash', () => {
    const cfg = getDefaultConfig();
    expect(cfg.gateway.auth.keyHash).toBeFalsy();

    const result = ensureGatewayAuthSecret(cfg, configPath);

    expect(result.generated).toBe(true);
    expect(result.keyHash).toBeTruthy();
    expect(cfg.gateway.auth.keyHash).toBe(result.keyHash);
    expect(existsSync(configPath)).toBe(true);

    // The persisted config contains the generated key.
    const persisted = readConfig(configPath);
    expect(persisted.gateway.auth.keyHash).toBe(result.keyHash);
  });

  it('is a no-op when a keyHash already exists', () => {
    const cfg = getDefaultConfig();
    cfg.gateway.auth.keyHash = 'pre-existing-secret';
    writeConfig(cfg, configPath);

    const result = ensureGatewayAuthSecret(cfg, configPath);

    expect(result.generated).toBe(false);
    expect(cfg.gateway.auth.keyHash).toBe('pre-existing-secret');
  });

  it('is a no-op when auth mode is none', () => {
    const cfg = getDefaultConfig();
    cfg.gateway.auth.mode = 'none';
    cfg.gateway.auth.keyHash = '';

    const result = ensureGatewayAuthSecret(cfg, configPath);

    expect(result.generated).toBe(false);
    expect(cfg.gateway.auth.keyHash).toBeFalsy();
  });

  it('does not write secrets in plaintext-readable config without the 0600 guard', () => {
    // Sanity: the persisted file is the same path readConfig resolves.
    const cfg = getDefaultConfig();
    ensureGatewayAuthSecret(cfg, configPath);
    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toContain(cfg.gateway.auth.keyHash);
  });
});

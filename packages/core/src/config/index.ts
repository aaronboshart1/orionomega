/**
 * @module config
 * Configuration system for OrionOmega.
 */

export type { OrionOmegaConfig } from './types.js';
export {
  readConfig,
  writeConfig,
  getConfigPath,
  getDefaultConfig,
  normalizeBindAddresses,
  assertSecureBind,
  ensureGatewayAuthSecret,
  InsecureBindError,
  INSECURE_BIND_OVERRIDE_ENV,
} from './loader.js';

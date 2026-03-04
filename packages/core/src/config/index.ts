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
} from './loader.js';

/**
 * @module utils/port-restrictions
 * Generates port-avoidance instructions for agents, based on the actual
 * configured ports used by the OrionOmega system at runtime.
 */

import { readConfig } from '../config/loader.js';
import type { OrionOmegaConfig } from '../config/types.js';

const FALLBACK_PORTS = [8000, 8888, 5000];
const SUGGESTED_ALTERNATIVES = [3000, 3001, 4000, 8080, 9000, 9001];

/**
 * Extracts the port number from a URL string.
 * Returns the explicit port if set, otherwise infers from protocol (http→80, https→443).
 */
function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns the list of ports currently reserved by OrionOmega services.
 * Reads from the live config so user overrides are respected.
 *
 * @param config - Optional pre-loaded config (avoids a redundant disk read).
 */
export function getReservedPorts(config?: OrionOmegaConfig): number[] {
  let cfg: OrionOmegaConfig;
  try {
    cfg = config ?? readConfig();
  } catch {
    return [...FALLBACK_PORTS];
  }

  const ports: number[] = [];

  // Gateway REST API
  const gatewayPort = Number(cfg.gateway?.port);
  if (gatewayPort > 0) ports.push(gatewayPort);

  // Hindsight (memory) — port lives inside a URL string
  const hindsightPort = portFromUrl(cfg.hindsight?.url ?? '');
  if (hindsightPort !== null && hindsightPort > 0) ports.push(hindsightPort);

  // Web UI
  const webuiPort = Number(cfg.webui?.port);
  if (webuiPort > 0) ports.push(webuiPort);

  const unique = [...new Set(ports)].filter((p) => p > 0 && p <= 65535);
  return unique.length > 0 ? unique : [...FALLBACK_PORTS];
}

/**
 * Builds a prominent instruction block warning agents not to start services
 * on the ports reserved by the OrionOmega system.
 *
 * @param config - Optional pre-loaded config.
 */
export function getPortAvoidanceInstructions(config?: OrionOmegaConfig): string {
  const reserved = getReservedPorts(config);
  const portList = reserved.join(', ');
  const alts = SUGGESTED_ALTERNATIVES.filter((p) => !reserved.includes(p)).join(', ');

  return `## System Port Restrictions
NEVER start any test server, development server, or service on the following ports — they are reserved by the OrionOmega system and are already in use:

  Reserved ports: ${portList}

Before starting any service, verify the port is NOT in the reserved list above.
If a task requires running a server, use a port not in [${portList}].
Suggested alternatives: ${alts}.`;
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { auditAuthEvent } from '@orionomega/core';
import { validateToken } from '../auth.js';
import type { GatewayConfig } from '../types.js';
import { rateLimitAuth, recordAuthFailure, resetAuthFailures } from '../rate-limit.js';

/**
 * Validates the Bearer token on a request when the gateway is in api-key auth mode.
 * Returns true if the request is authorized; writes a 401 and returns false otherwise.
 */
export function checkAuth(req: IncomingMessage, res: ServerResponse, gatewayConfig: GatewayConfig): boolean {
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

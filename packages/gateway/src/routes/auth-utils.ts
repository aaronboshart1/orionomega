import type { IncomingMessage, ServerResponse } from 'node:http';
import { auditAuthEvent } from '@orionomega/core';
import { validateToken } from '../auth.js';
import type { GatewayConfig } from '../types.js';
import { rateLimitAuth, recordAuthFailure, resetAuthFailures } from '../rate-limit.js';

/**
 * Decides whether a token payload is authorized to act on a given session.
 *
 * Tokens may be *master* tokens (no `sessionId` in their `data` payload — used
 * by the trusted web proxy / TUI, which proxy for any session) or *scoped*
 * tokens (carrying a `sessionId`, which may only touch that one session). A
 * scoped token presented for a different session is rejected — this is the
 * per-session authorization boundary (Task #231) that stops one session's
 * credential from reading or mutating another session's data.
 *
 * @param payload - The validated token's `data` payload (or undefined).
 * @param requiredSessionId - The session the request is targeting, if any.
 * @returns true when the token may act on `requiredSessionId`.
 */
export function isSessionAuthorized(
  payload: Record<string, unknown> | undefined,
  requiredSessionId?: string,
): boolean {
  const scoped = payload?.sessionId;
  // Master token (no session scope) — authorized for any session.
  if (scoped === undefined || scoped === null || scoped === '') return true;
  // Scoped token — only authorized for its own session.
  if (!requiredSessionId) return false;
  return scoped === requiredSessionId;
}

/**
 * Validates the Bearer token on a request when the gateway is in api-key auth mode.
 * Returns true if the request is authorized; writes a 401/403 and returns false otherwise.
 *
 * When `requiredSessionId` is provided, a successfully-validated *scoped* token
 * (one carrying a `sessionId`) must match it or the request is rejected with 403
 * — enforcing per-session authorization (Task #231). Master tokens (no
 * `sessionId`) are accepted for any session.
 *
 * @param req - The incoming request.
 * @param res - The response to write a rejection to on failure.
 * @param gatewayConfig - Gateway config (auth mode + key).
 * @param requiredSessionId - The session this request targets, for scope enforcement.
 */
export function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
  requiredSessionId?: string,
): boolean {
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
  if (!isSessionAuthorized(result.payload, requiredSessionId)) {
    // Token is valid but scoped to a different session — authentication
    // succeeded, authorization did not. Do NOT count this against the auth
    // rate-limiter (the credential is genuine); surface it as a 403.
    auditAuthEvent(
      'rest_authz_denied',
      `Token scoped to session "${String(result.payload?.sessionId)}" may not access "${requiredSessionId ?? '(unscoped)'}"`,
      actor,
    );
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden: token not authorized for this session' }));
    return false;
  }
  resetAuthFailures(req);
  auditAuthEvent('rest_auth_success', undefined, actor);
  return true;
}

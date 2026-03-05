/**
 * @module auth
 * Lightweight authentication helpers — HMAC-SHA256 signed JSON tokens and SHA-256 password hashing.
 * Zero native dependencies — uses Node's built-in crypto only.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 1;
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

interface TokenPayload {
  v: number;
  exp: number;
  jti: string;
  data: Record<string, unknown>;
}

/**
 * Generate an HMAC-SHA256 signed token containing the given payload.
 */
export function generateToken(
  payload: Record<string, unknown>,
  secret: string,
  expiryMs: number = DEFAULT_EXPIRY_MS,
): string {
  const tokenPayload: TokenPayload = {
    v: TOKEN_VERSION,
    exp: Date.now() + expiryMs,
    jti: randomBytes(16).toString('hex'),
    data: payload,
  };

  const payloadB64 = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url');

  return `${payloadB64}.${signature}`;
}

/**
 * Validate an HMAC-SHA256 signed token and return its embedded data.
 */
export function validateToken(
  token: string,
  secret: string,
): { valid: boolean; payload?: Record<string, unknown> } {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return { valid: false };
    }

    const [payloadB64, signature] = parts;
    const expectedSig = createHmac('sha256', secret).update(payloadB64!).digest('base64url');

    if (signature !== expectedSig) {
      return { valid: false };
    }

    const decoded = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf-8'),
    ) as TokenPayload;

    if (decoded.v !== TOKEN_VERSION) {
      return { valid: false };
    }

    if (Date.now() > decoded.exp) {
      return { valid: false };
    }

    return { valid: true, payload: decoded.data };
  } catch {
    return { valid: false };
  }
}

/**
 * Hash a password using SHA-256 (hex output).
 * For gateway API key authentication — not for user passwords.
 */
export function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

/**
 * Verify a password against a SHA-256 hash using timing-safe comparison.
 */
export function verifyPassword(password: string, hash: string): boolean {
  const computed = createHash('sha256').update(password).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
  } catch {
    return false;
  }
}

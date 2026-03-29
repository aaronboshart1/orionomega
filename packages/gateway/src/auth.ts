/**
 * @module auth
 * Lightweight authentication helpers — HMAC-SHA256 signed JSON tokens and scrypt password hashing.
 * Zero native dependencies — uses Node's built-in crypto only.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';

const TOKEN_VERSION = 1;
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 32;

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
 * Uses timing-safe comparison for signature verification.
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

    const sigBuf = Buffer.from(signature!, 'utf-8');
    const expectedBuf = Buffer.from(expectedSig, 'utf-8');

    if (sigBuf.length !== expectedBuf.length) {
      return { valid: false };
    }

    if (!timingSafeEqual(sigBuf, expectedBuf)) {
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
 * Hash a password using scrypt with a random salt.
 * Returns a string in the format `salt:hash` (both hex-encoded).
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_LEN).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Verify a password against a scrypt hash using timing-safe comparison.
 * Accepts both new `salt:hash` format and legacy plain hex hashes (64-char SHA-256).
 */
export function verifyPassword(password: string, hash: string): boolean {
  try {
    if (hash.includes(':')) {
      const [salt, stored] = hash.split(':');
      if (!salt || !stored) return false;
      const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
      const derivedBuf = Buffer.from(derived, 'utf-8');
      const storedBuf = Buffer.from(stored, 'utf-8');
      if (derivedBuf.length !== storedBuf.length) return false;
      return timingSafeEqual(derivedBuf, storedBuf);
    }

    const computed = createHash('sha256').update(password).digest('hex');
    const computedBuf = Buffer.from(computed, 'utf-8');
    const storedBuf = Buffer.from(hash, 'utf-8');
    if (computedBuf.length !== storedBuf.length) return false;
    return timingSafeEqual(computedBuf, storedBuf);
  } catch {
    return false;
  }
}

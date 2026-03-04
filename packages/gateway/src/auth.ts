/**
 * @module auth
 * Lightweight authentication helpers — HMAC-SHA256 signed JSON tokens and bcrypt password hashing.
 */

import { createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';

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
 * @param payload - Arbitrary data to embed in the token.
 * @param secret - Signing secret (typically the hashed API key).
 * @param expiryMs - Token lifetime in milliseconds. Defaults to 24 hours.
 * @returns A base64url-encoded `payload.signature` token string.
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
 * @param token - The token string to validate.
 * @param secret - The signing secret used at generation time.
 * @returns An object with `valid` flag and optional decoded `payload`.
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
 * Hash a password using bcrypt.
 * @param password - The plaintext password.
 * @returns The bcrypt hash string.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Verify a password against a bcrypt hash.
 * @param password - The plaintext password.
 * @param hash - The bcrypt hash to compare against.
 * @returns `true` if the password matches.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

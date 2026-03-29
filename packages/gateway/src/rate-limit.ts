import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@orionomega/core';

const log = createLogger('rate-limit');

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface AuthTracker {
  failures: number;
  cooldownUntil: number;
}

const REST_RATE = { maxTokens: 100, refillRate: 10, windowMs: 1000 };
const AUTH_RATE = { maxTokens: 20, refillRate: 2, windowMs: 1000 };
const AUTH_FAILURE_THRESHOLD = 5;
const AUTH_COOLDOWN_MS = 60_000;
const WS_CONNECT_RATE = { maxTokens: 10, refillRate: 1, windowMs: 1000 };

const restBuckets = new Map<string, TokenBucket>();
const authBuckets = new Map<string, TokenBucket>();
const wsBuckets = new Map<string, TokenBucket>();
const authTrackers = new Map<string, AuthTracker>();

const CLEANUP_INTERVAL_MS = 60_000;
const BUCKET_TTL_MS = 300_000;

function cleanupBuckets(): void {
  const now = Date.now();
  for (const [buckets] of [[restBuckets], [authBuckets], [wsBuckets]] as const) {
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.lastRefill > BUCKET_TTL_MS) {
        buckets.delete(key);
      }
    }
  }
  for (const [key, tracker] of authTrackers.entries()) {
    if (now > tracker.cooldownUntil && tracker.failures === 0) {
      authTrackers.delete(key);
    }
  }
}

setInterval(cleanupBuckets, CLEANUP_INTERVAL_MS).unref();

function getClientIp(req: IncomingMessage): string {
  const socketAddr = req.socket.remoteAddress ?? 'unknown';
  const isLoopback = socketAddr === '127.0.0.1' || socketAddr === '::1' || socketAddr === '::ffff:127.0.0.1';
  if (isLoopback) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return socketAddr;
}

function tryConsume(
  buckets: Map<string, TokenBucket>,
  key: string,
  config: { maxTokens: number; refillRate: number; windowMs: number },
): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: config.maxTokens - 1, lastRefill: now };
    buckets.set(key, bucket);
    return true;
  }

  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor(elapsed / config.windowMs) * config.refillRate;
  if (refill > 0) {
    bucket.tokens = Math.min(config.maxTokens, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true;
  }

  return false;
}

export function rateLimitRest(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = getClientIp(req);

  if (!tryConsume(restBuckets, ip, REST_RATE)) {
    log.warn('REST rate limit exceeded', { ip });
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return false;
  }

  return true;
}

export function rateLimitAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = getClientIp(req);

  const tracker = authTrackers.get(ip);
  if (tracker && Date.now() < tracker.cooldownUntil) {
    const retryAfter = Math.ceil((tracker.cooldownUntil - Date.now()) / 1000);
    log.warn('Auth cooldown active', { ip, retryAfter });
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(JSON.stringify({ error: 'Too many authentication failures. Try again later.' }));
    return false;
  }

  if (!tryConsume(authBuckets, ip, AUTH_RATE)) {
    log.warn('Auth rate limit exceeded', { ip });
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return false;
  }

  return true;
}

export function recordAuthFailure(req: IncomingMessage): void {
  const ip = getClientIp(req);
  let tracker = authTrackers.get(ip);
  if (!tracker) {
    tracker = { failures: 0, cooldownUntil: 0 };
    authTrackers.set(ip, tracker);
  }
  tracker.failures++;
  if (tracker.failures >= AUTH_FAILURE_THRESHOLD) {
    tracker.cooldownUntil = Date.now() + AUTH_COOLDOWN_MS;
    tracker.failures = 0;
    log.warn('Auth cooldown triggered', { ip, cooldownMs: AUTH_COOLDOWN_MS });
  }
}

export function resetAuthFailures(req: IncomingMessage): void {
  const ip = getClientIp(req);
  authTrackers.delete(ip);
}

export function rateLimitWsConnection(req: IncomingMessage): boolean {
  const ip = getClientIp(req);
  if (!tryConsume(wsBuckets, ip, WS_CONNECT_RATE)) {
    log.warn('WebSocket connection rate limit exceeded', { ip });
    return false;
  }
  return true;
}

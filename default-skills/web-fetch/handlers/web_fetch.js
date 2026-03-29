#!/usr/bin/env node
/**
 * web_fetch handler
 * Receives JSON params on stdin: { url: string, maxChars?: number, extractMode?: string }
 * Outputs JSON result on stdout.
 */

const { lookup } = require('node:dns/promises');
const net = require('node:net');

const MAX_OUTPUT_CHARS = 10_000;

function extractIPv4FromMapped(ip) {
  const lower = ip.toLowerCase();
  const mappedPrefix = '::ffff:';
  if (lower.startsWith(mappedPrefix)) {
    const v4Part = ip.slice(mappedPrefix.length);
    if (net.isIPv4(v4Part)) return v4Part;
  }
  return null;
}

function isBlockedIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const [a, b] = parts.map(Number);

  if (a === 10) return 'RFC 1918 private';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC 1918 private';
  if (a === 192 && b === 168) return 'RFC 1918 private';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local / cloud metadata';
  if (a === 0) return 'reserved';
  return null;
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return 'IPv6 loopback';
  if (lower === '::') return 'IPv6 unspecified';
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'IPv6 ULA';
  if (lower.startsWith('fe80:') || lower.startsWith('fe80%')) return 'IPv6 link-local';
  return null;
}

function isBlockedIP(ip) {
  const v4Mapped = extractIPv4FromMapped(ip);
  if (v4Mapped) {
    return isBlockedIPv4(v4Mapped) || null;
  }

  if (net.isIPv4(ip)) {
    return isBlockedIPv4(ip);
  }

  if (net.isIPv6(ip)) {
    return isBlockedIPv6(ip);
  }

  return isBlockedIPv4(ip);
}

async function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked protocol: ${parsed.protocol} — only http: and https: are allowed`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  const ipDirect = isBlockedIP(hostname);
  if (ipDirect) {
    throw new Error(`Blocked address (${ipDirect}): ${hostname}`);
  }

  let resolvedAddresses;
  try {
    resolvedAddresses = await lookup(hostname, { all: true });
    for (const entry of resolvedAddresses) {
      const reason = isBlockedIP(entry.address);
      if (reason) {
        throw new Error(`DNS resolved to blocked address (${reason}): ${hostname} → ${entry.address}`);
      }
    }
  } catch (err) {
    if (err.message && (err.message.startsWith('Blocked') || err.message.startsWith('DNS resolved'))) {
      throw err;
    }
    throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
  }

  return { parsed, resolvedAddresses };
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated, ${text.length - max} chars omitted]`;
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_REDIRECTS = 5;

async function safeFetch(url, maxRedirects = MAX_REDIRECTS) {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await validateUrl(currentUrl);

    const response = await fetch(currentUrl, {
      headers: {
        'User-Agent': 'OrionOmega/0.1',
        Accept: 'text/html,application/json,text/plain,*/*',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { response, finalUrl: currentUrl };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  throw new Error(`Too many redirects (>${maxRedirects})`);
}

async function webFetch(url, maxChars, extractMode) {
  const { response } = await safeFetch(url);

  if (!response.ok) {
    return { result: `HTTP ${response.status}: ${response.statusText}` };
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (extractMode === 'raw') {
    return { result: truncate(text, maxChars) };
  }

  if (contentType.includes('html')) {
    return { result: truncate(stripHtml(text), maxChars) };
  }

  return { result: truncate(text, maxChars) };
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let params;
  try {
    params = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ error: 'Invalid JSON input' }));
    process.exit(1);
  }

  const url = String(params.url ?? '');
  const maxChars = Number(params.maxChars ?? MAX_OUTPUT_CHARS);
  const extractMode = String(params.extractMode ?? 'text');

  if (!url) {
    process.stdout.write(JSON.stringify({ error: 'url is required' }));
    process.exit(1);
  }

  try {
    const output = await webFetch(url, maxChars, extractMode);
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }));
    process.exit(1);
  }
}

main();

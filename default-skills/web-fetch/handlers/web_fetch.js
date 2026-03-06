#!/usr/bin/env node
/**
 * web_fetch handler
 * Receives JSON params on stdin: { url: string, maxChars?: number, extractMode?: string }
 * Outputs JSON result on stdout.
 */

const MAX_OUTPUT_CHARS = 10_000;

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

async function webFetch(url, maxChars, extractMode) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'OrionOmega/0.1',
      Accept: 'text/html,application/json,text/plain,*/*',
    },
    signal: AbortSignal.timeout(30_000),
  });

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

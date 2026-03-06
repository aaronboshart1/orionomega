#!/usr/bin/env node
/**
 * web_search handler
 * Receives JSON params on stdin: { query: string, count?: number }
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

async function webSearch(query, count) {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OrionOmega/0.1)',
      Accept: 'text/html,*/*',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    return { result: `HTTP ${response.status}: ${response.statusText}` };
  }

  const html = await response.text();

  const results = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = resultRegex.exec(html)) !== null && results.length < count) {
    const href = match[1] ?? '';
    const title = stripHtml(match[2] ?? '').trim();
    const snippet = stripHtml(match[3] ?? '').trim();

    let finalUrl = href;
    try {
      const uddg = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg');
      if (uddg) finalUrl = decodeURIComponent(uddg);
    } catch {
      // keep original href
    }

    if (title && finalUrl) {
      results.push(`${results.length + 1}. **${title}**\n   URL: ${finalUrl}\n   ${snippet}`);
    }
  }

  if (results.length === 0) {
    return { result: `No results found for: ${query}` };
  }

  return { result: truncate(`Search results for "${query}":\n\n` + results.join('\n\n')) };
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

  const query = String(params.query ?? '');
  const count = Math.min(Number(params.count ?? 5), 20);

  if (!query) {
    process.stdout.write(JSON.stringify({ error: 'query is required' }));
    process.exit(1);
  }

  try {
    const output = await webSearch(query, count);
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `Search failed: ${err instanceof Error ? err.message : String(err)}` }));
    process.exit(1);
  }
}

main();

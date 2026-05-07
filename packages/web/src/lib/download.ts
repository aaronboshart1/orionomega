const MIME_MAP: Record<string, string> = {
  json: 'application/json',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  js: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  sh: 'text/x-sh',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  txt: 'text/plain',
  css: 'text/css',
  sql: 'text/x-sql',
};

export function downloadFile(filename: string, content: string | Blob): void {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const type = MIME_MAP[ext] ?? 'text/plain';
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Sanitize an arbitrary string into a filename-safe slug. Strips path
 * separators and characters that misbehave on common filesystems, collapses
 * whitespace to dashes, and trims to a reasonable length.
 */
export function sanitizeFilename(raw: string, fallback = 'session'): string {
  const cleaned = (raw ?? '')
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Fetch a session's full snapshot from the gateway and trigger a JSON
 * download in the browser. Throws on network or non-2xx responses so callers
 * can surface user-visible errors.
 */
export async function exportSessionAsJson(
  sessionId: string,
  sessionName?: string | null,
): Promise<string> {
  if (!sessionId) throw new Error('Missing session id');
  const resp = await fetch(
    `/api/gateway/api/sessions/${encodeURIComponent(sessionId)}/export`,
  );
  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json() as { error?: string };
      detail = body?.error ? `: ${body.error}` : '';
    } catch { /* ignore */ }
    throw new Error(`Export failed (HTTP ${resp.status})${detail}`);
  }
  const text = await resp.text();
  const slug = sanitizeFilename(sessionName?.trim() || sessionId, 'session');
  const filename = `orionomega-${slug}-${todayStamp()}.json`;
  downloadFile(filename, new Blob([text], { type: 'application/json' }));
  return filename;
}

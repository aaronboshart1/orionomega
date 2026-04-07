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

export function downloadFile(filename: string, content: string): void {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const type = MIME_MAP[ext] ?? 'text/plain';
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

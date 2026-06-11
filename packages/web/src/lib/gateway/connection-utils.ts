'use client';

/**
 * @module gateway/connection-utils
 * Small, dependency-free helpers shared by the WebSocket client
 * (`@/lib/gateway`) and the server-message handler
 * (`@/lib/gateway/event-handlers`). Kept here to avoid a circular import
 * between those two modules.
 */

/** localStorage key under which the active session id is persisted. */
export const SESSION_KEY = 'orionomega_session_id';

/**
 * Build the gateway WebSocket URL. In the browser this honours a `?session=`
 * URL param (bookmarkable session links) and falls back to the persisted
 * session id; on the server it returns the loopback default.
 */
export function getGatewayUrl(): string {
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let savedSession: string | null = null;
    try {
      // URL params take priority — enables bookmarkable session links
      const urlParams = new URLSearchParams(window.location.search);
      savedSession = urlParams.get('session') ?? localStorage.getItem(SESSION_KEY);
    } catch { /* ignore */ }
    const sessionParam = savedSession ? `&session=${savedSession}` : '';
    return `${proto}//${window.location.host}/api/gateway/ws?client=web${sessionParam}`;
  }
  return 'ws://127.0.0.1:8000/ws?client=web';
}

/** Map a tool name to a human-friendly streaming status label. */
export function statusFromToolCall(toolName?: string): string {
  if (!toolName) return 'Thinking…';
  const lower = toolName.toLowerCase();
  if (lower.includes('search') || lower.includes('web')) return 'Searching web…';
  if (lower.includes('read') || lower.includes('file')) return 'Reading file…';
  if (lower.includes('code') || lower.includes('exec') || lower.includes('run')) return 'Running code…';
  if (lower.includes('write') || lower.includes('edit')) return 'Writing…';
  if (lower.includes('shell') || lower.includes('bash') || lower.includes('terminal')) return 'Running command…';
  if (lower.includes('image') || lower.includes('generate')) return 'Generating…';
  if (lower.includes('database') || lower.includes('sql') || lower.includes('query')) return 'Querying database…';
  return `Running ${toolName}…`;
}

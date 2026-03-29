import { createLogger } from './logger.js';

const log = createLogger('audit');

export type AuditCategory = 'tool_invocation' | 'api_request' | 'auth_event' | 'config_change';

export interface AuditEntry {
  category: AuditCategory;
  action: string;
  actor?: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

export function emitAuditEvent(entry: AuditEntry): void {
  const record = {
    ts: new Date().toISOString(),
    category: entry.category,
    action: entry.action,
    ...(entry.actor && { actor: entry.actor }),
    ...(entry.detail && { detail: entry.detail }),
    ...(entry.meta && { meta: entry.meta }),
  };

  log.info(`[AUDIT] ${entry.category}:${entry.action}`, record);
}

export function auditToolInvocation(toolName: string, args?: Record<string, unknown>, actor?: string): void {
  emitAuditEvent({
    category: 'tool_invocation',
    action: toolName,
    actor,
    meta: args,
  });
}

export function auditApiRequest(method: string, path: string, statusCode?: number, actor?: string): void {
  emitAuditEvent({
    category: 'api_request',
    action: `${method} ${path}`,
    actor,
    meta: statusCode !== undefined ? { statusCode } : undefined,
  });
}

export function auditAuthEvent(action: string, detail?: string, actor?: string): void {
  emitAuditEvent({
    category: 'auth_event',
    action,
    actor,
    detail,
  });
}

export function auditConfigChange(setting: string, detail?: string, actor?: string): void {
  emitAuditEvent({
    category: 'config_change',
    action: setting,
    actor,
    detail,
  });
}

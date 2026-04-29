/**
 * @module db/health
 * Lightweight, read-only helpers for surfacing database state in the
 * gateway's `/api/health` response. Kept separate from the migration
 * runner so that exposing health data does not pull migration code
 * into routing-layer call paths.
 */

import type Database from 'better-sqlite3';
import { getDb, type CodingDb } from './client.js';

/** Snapshot of database health for the structured /api/health response. */
export interface DatabaseStatus {
  /** 'ok' when the DB is reachable; 'down' when the query throws. */
  status: 'ok' | 'down';
  /** Filename / version of the most recently applied migration, or null. */
  lastMigration: string | null;
  /** ISO timestamp the migration was applied, if known. */
  lastMigrationAt: string | null;
  /** Total number of applied migrations recorded in the schema_migrations table. */
  appliedMigrations: number;
  /** Most recent error message encountered while computing this snapshot. */
  lastError: string | null;
}

/**
 * Return a snapshot of database health suitable for a JSON response.
 *
 * The query against `schema_migrations` is a single bounded read and is
 * cheap enough to run on every health check. Any error reading the
 * tracking table — including the table being missing on a brand-new DB
 * before migrations have been applied — is reported as
 * `status: 'down'` with the underlying message in `lastError`, since an
 * un-migrated database is operationally indistinguishable from a broken
 * one and operators want to see the discrepancy immediately.
 */
export function getDatabaseStatus(db?: CodingDb): DatabaseStatus {
  try {
    // Resolve the DB lazily inside the try so that filesystem errors from
    // `getDb()` (mkdir/open failures) surface as `status: 'down'` with the
    // underlying message in `lastError`, rather than escaping to the caller
    // and 500-ing the health probe.
    const resolved = db ?? getDb();
    // Drizzle's better-sqlite3 driver hangs the underlying connection off
    // the `session.client` slot. Reach for it directly rather than going
    // through Drizzle's query builder, which doesn't model the
    // schema_migrations bookkeeping table.
    const client = (resolved as unknown as {
      session: { client: Database.Database };
    }).session.client;

    const lastRow = client
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get() as { version: string; applied_at: string } | undefined;

    const countRow = client
      .prepare('SELECT COUNT(*) as count FROM schema_migrations')
      .get() as { count: number } | undefined;

    return {
      status: 'ok',
      lastMigration: lastRow?.version ?? null,
      lastMigrationAt: lastRow?.applied_at ?? null,
      appliedMigrations: Number(countRow?.count ?? 0),
      lastError: null,
    };
  } catch (err) {
    return {
      status: 'down',
      lastMigration: null,
      lastMigrationAt: null,
      appliedMigrations: 0,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

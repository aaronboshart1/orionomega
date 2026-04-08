/**
 * @module db/client
 * Lazy-initialised Drizzle + better-sqlite3 database client.
 *
 * The database file lives at `~/.orionomega/coding.db`, alongside the
 * existing JSON session store, so all persistent state stays co-located.
 *
 * Call `getDb()` to obtain the singleton. The first call runs all pending
 * migrations automatically so callers never need to manage schema setup.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** The Drizzle database type, parameterised with the full schema. */
export type CodingDb = ReturnType<typeof drizzle<typeof schema>>;

// ── Singleton ─────────────────────────────────────────────────────────────────

let _db: CodingDb | undefined;
let _dbPath: string | undefined;

/**
 * Returns the singleton Drizzle database client.
 *
 * On first call:
 *   1. Creates `~/.orionomega/` if it does not exist.
 *   2. If `omega.db` does not exist but `coding.db` does, copies `coding.db`
 *      to `omega.db` for backward compatibility.
 *   3. Opens (or creates) `~/.orionomega/omega.db`.
 *   4. Enables WAL mode for better read concurrency.
 *   5. Runs all pending SQL migrations.
 *
 * Subsequent calls return the cached instance.
 *
 * @param dbPath Override the database file path (useful in tests).
 */
export function getDb(dbPath?: string): CodingDb {
  const dir = resolve(homedir(), '.orionomega');
  const targetPath = dbPath ?? resolve(dir, 'omega.db');

  // Backward compatibility: migrate coding.db → omega.db on first run.
  if (!dbPath) {
    const legacyPath = resolve(dir, 'coding.db');
    if (!existsSync(targetPath) && existsSync(legacyPath)) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(legacyPath, targetPath);
    }
  }

  // Return cached instance if path hasn't changed.
  if (_db && _dbPath === targetPath) {
    return _db;
  }

  mkdirSync(resolve(targetPath, '..'), { recursive: true });

  const sqlite = new Database(targetPath);

  // WAL mode: readers don't block writers; writers don't block readers.
  sqlite.pragma('journal_mode = WAL');
  // Enforce foreign key constraints (SQLite disables them by default).
  sqlite.pragma('foreign_keys = ON');

  runMigrations(sqlite);

  _db = drizzle(sqlite, { schema });
  _dbPath = targetPath;
  return _db;
}

/**
 * Closes the current database connection and clears the singleton.
 * Useful in tests and for graceful shutdown.
 */
export function closeDb(): void {
  if (_db) {
    // Access the underlying better-sqlite3 instance via the Drizzle session.
    const session = (_db as unknown as { session: { client: Database.Database } }).session;
    session?.client?.close();
    _db = undefined;
    _dbPath = undefined;
  }
}

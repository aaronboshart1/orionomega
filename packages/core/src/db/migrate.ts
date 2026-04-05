/**
 * @module db/migrate
 * SQL migration runner for the Coding Mode database.
 *
 * Migrations are plain `.sql` files in `./migrations/`, named with a numeric
 * prefix so they sort lexicographically in application order:
 *
 *   0000_coding_mode_schema.sql
 *   0001_some_future_change.sql
 *   ...
 *
 * Applied versions are tracked in the `schema_migrations` table that the first
 * migration creates. Re-running `runMigrations()` is safe — already-applied
 * migrations are skipped.
 */

import type Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');

/**
 * Runs all pending SQL migrations against the provided better-sqlite3
 * database instance.
 *
 * This function is intentionally synchronous — better-sqlite3 is a
 * synchronous driver, and migrations must complete before the app starts.
 *
 * @param db - An open better-sqlite3 Database instance.
 */
export function runMigrations(db: Database.Database): void {
  // Bootstrap the tracking table. This must run before we query it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  // Collect already-applied versions.
  const applied = new Set<string>(
    (
      db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: string }>
    ).map((r) => r.version),
  );

  // Discover migration files sorted by name (lexicographic = numeric order).
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    // Migrations directory missing at runtime (e.g. running from dist without
    // copying SQL files). Warn and skip — schema must already be present.
    console.warn(
      '[db/migrate] migrations directory not found, skipping: ' + MIGRATIONS_DIR,
    );
    return;
  }

  const insertStmt = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
  );

  for (const file of files) {
    // Version key is the filename without extension.
    const version = file.replace(/\.sql$/, '');

    if (applied.has(version)) {
      continue; // Already applied.
    }

    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');

    // Run the entire file in a transaction so a partial failure rolls back.
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      insertStmt.run(version);
    });

    try {
      applyMigration();
      console.info(`[db/migrate] applied ${version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[db/migrate] failed to apply migration ${version}: ${msg}`);
    }
  }
}

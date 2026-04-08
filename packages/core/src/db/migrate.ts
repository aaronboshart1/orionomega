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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the migrations directory. When running from dist/ the SQL files
 * should have been copied there by the build script. As a fallback (e.g.
 * dev mode via tsx, or build script not yet updated) look in the original
 * src/ tree relative to the compiled output location.
 */
function resolveMigrationsDir(): string | null {
  // Primary: co-located with compiled JS (dist/db/migrations)
  const primary = resolve(__dirname, 'migrations');
  if (existsSync(primary)) return primary;

  // Fallback: source tree — __dirname is dist/db, so ../../src/db/migrations
  const fallback = resolve(__dirname, '..', '..', 'src', 'db', 'migrations');
  if (existsSync(fallback)) return fallback;

  return null;
}

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
  const migrationsDir = resolveMigrationsDir();
  if (!migrationsDir) {
    console.error(
      '[db/migrate] migrations directory not found in dist/ or src/ — ' +
      'database tables may be missing. Searched: ' + resolve(__dirname, 'migrations'),
    );
    return;
  }

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    console.error(
      '[db/migrate] failed to read migrations directory: ' + migrationsDir,
      err instanceof Error ? err.message : String(err),
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

    const sql = readFileSync(resolve(migrationsDir, file), 'utf8');

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

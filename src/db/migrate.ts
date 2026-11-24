import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

/**
 * Applies, in name order, every `migrations/*.sql` file not yet recorded in
 * schema_migrations. Each file runs in its own transaction with its record, so a file
 * is applied completely or not at all. Returns the versions applied by this call.
 */
export function migrate(db: DatabaseSync): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  const done = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: string }).version),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const version = file.slice(0, -".sql".length);
    if (done.has(version)) continue;
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(
        version,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applied.push(version);
  }
  return applied;
}

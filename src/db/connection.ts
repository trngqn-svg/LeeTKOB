import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Where the database lives when DB_PATH is not set: a git-ignored folder. */
export const DEFAULT_DB_PATH = "data/leetkob.db";

/**
 * Opens (and creates if needed) the SQLite file, then runs the three pragmas every
 * connection needs (docs/ARCHITECTURE.md, section 3). ":memory:" gives a private
 * in-memory database, which the tests use.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // foreign_keys is off by default in SQLite; WAL lets the API read while the worker
  // writes; busy_timeout waits for the other process's write lock instead of failing.
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

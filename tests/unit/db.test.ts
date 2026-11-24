// The database layer: the connection's pragmas, the migration runner, and the rules the
// schema itself enforces (docs/ARCHITECTURE.md, section 3).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";

const TABLES = [
  "class_members",
  "classes",
  "idempotency_keys",
  "lab_constraints",
  "lab_tests",
  "labs",
  "model_calls",
  "publications",
  "review_items",
  "schema_migrations",
  "sessions",
  "submissions",
  "users",
  "verdicts",
];

// The column is not always named after the pragma (busy_timeout answers "timeout").
function pragma(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
}

describe("openDatabase", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leetkob-db-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("turns on foreign keys, WAL and a busy timeout on a file", () => {
    const db = openDatabase(join(dir, "nested", "test.db"));
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "busy_timeout")).toBe(5000);
    db.close();
  });

  it("opens an in-memory database for tests", () => {
    const db = openDatabase(":memory:");
    expect(pragma(db, "foreign_keys")).toBe(1);
    db.close();
  });
});

describe("migrate", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates every table and records the version", () => {
    expect(migrate(db)).toEqual(["001_initial"]);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(TABLES);
    const versions = db.prepare("SELECT version FROM schema_migrations").all();
    expect(versions).toEqual([{ version: "001_initial" }]);
  });

  it("applies nothing the second time", () => {
    migrate(db);
    expect(migrate(db)).toEqual([]);
  });
});

describe("rules the schema enforces", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    db.exec(`
      INSERT INTO users (id, email, display_name, role, password_hash)
        VALUES ('u-ta', 'ta@x.test', 'TA', 'ta', 'h'), ('u-st', 'st@x.test', 'St', 'student', 'h');
      INSERT INTO classes (id, name) VALUES ('c1', 'Class 1');
      INSERT INTO labs (id, class_id, title, statement_md, created_by)
        VALUES ('lab1', 'c1', 'Lab', 'Statement', 'u-ta');
      INSERT INTO lab_constraints (id, lab_id, code, text, kind, deduction)
        VALUES (1, 'lab1', 'C1', 'Use merge sort.', 'semantic', 3);
      INSERT INTO submissions (id, lab_id, student_id, source_code)
        VALUES ('s1', 'lab1', 'u-st', 'int main() {}');
    `);
  });

  afterEach(() => {
    db.close();
  });

  function verdict(values: string): () => void {
    return () =>
      db.exec(
        `INSERT INTO verdicts (submission_id, constraint_id, verdict, decided_by, reason_code, evidence)
         VALUES ('s1', 1, ${values})`,
      );
  }

  it("refuses a violation without evidence", () => {
    expect(verdict("'violation', 'model', NULL, '[]'")).toThrow(/CHECK/);
  });

  it("refuses a fallback without a reason, and a reason without a fallback", () => {
    expect(verdict("'unsure', 'fallback', NULL, '[]'")).toThrow(/CHECK/);
    expect(verdict("'unsure', 'model', 'timeout', '[]'")).toThrow(/CHECK/);
  });

  it("accepts a fallback with its reason", () => {
    expect(verdict("'unsure', 'fallback', 'model_off', '[]'")).not.toThrow();
  });

  it("refuses a second verdict for the same submission and constraint", () => {
    verdict("'pass', 'model', NULL, '[]'")();
    expect(verdict("'pass', 'model', NULL, '[]'")).toThrow(/UNIQUE/);
  });

  it("refuses a submission to a lab that does not exist", () => {
    expect(() =>
      db.exec(
        "INSERT INTO submissions (id, lab_id, student_id, source_code) VALUES ('s2', 'nope', 'u-st', 'x')",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("refuses limits outside the FAQ-05 ranges", () => {
    expect(() =>
      db.exec(
        "INSERT INTO labs (id, class_id, title, statement_md, created_by, time_limit_ms) VALUES ('l2', 'c1', 'L', 'S', 'u-ta', 6000)",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        "INSERT INTO labs (id, class_id, title, statement_md, created_by, memory_limit_mb) VALUES ('l3', 'c1', 'L', 'S', 'u-ta', 1024)",
      ),
    ).toThrow(/CHECK/);
  });

  it("refuses a running submission without a lock", () => {
    expect(() =>
      db.exec("UPDATE submissions SET status = 'running' WHERE id = 's1'"),
    ).toThrow(/CHECK/);
  });
});

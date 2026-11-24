// The test accounts of PA3.md (PA#3 rubric, "What you hand in"): one admin, two TAs
// in two different classes, and two students in the first TA's class. The seed
// creates accounts and classes only; a lab is created through the API.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import { hashPassword, verifyPassword } from "../../src/password.ts";

describe("hashPassword and verifyPassword", () => {
  it("accepts the right password and refuses a wrong one", () => {
    const stored = hashPassword("correct horse");
    expect(verifyPassword("correct horse", stored)).toBe(true);
    expect(verifyPassword("Correct horse", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("never stores the password, and salts every hash", () => {
    const a = hashPassword("same");
    const b = hashPassword("same");
    expect(a).not.toContain("same");
    expect(a).not.toBe(b);
  });

  it("refuses a stored value it cannot read", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "plain-text")).toBe(false);
    expect(verifyPassword("x", "scrypt$c2FsdA$")).toBe(false);
  });
});

describe("seedAccounts", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  function rows(sql: string): unknown[] {
    return db.prepare(sql).all();
  }

  it("creates one admin, two TAs and two students", () => {
    seedAccounts(db, "pw-1");
    expect(
      rows("SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY role"),
    ).toEqual([
      { role: "admin", n: 1 },
      { role: "student", n: 2 },
      { role: "ta", n: 2 },
    ]);
  });

  it("puts the two TAs in two different classes, and both students in the first TA's class", () => {
    seedAccounts(db, "pw-1");
    const members = rows(`
      SELECT u.role, m.class_id FROM class_members m JOIN users u ON u.id = m.user_id
      ORDER BY u.role, u.id`) as { role: string; class_id: string }[];
    const taClasses = members
      .filter((m) => m.role === "ta")
      .map((m) => m.class_id);
    const studentClasses = members
      .filter((m) => m.role === "student")
      .map((m) => m.class_id);
    expect(taClasses).toHaveLength(2);
    expect(new Set(taClasses).size).toBe(2);
    expect(studentClasses).toEqual([taClasses[0], taClasses[0]]);
    expect(members.some((m) => m.role === "admin")).toBe(false);
  });

  it("stores a hash that the seed password verifies", () => {
    seedAccounts(db, "pw-1");
    const hashes = rows("SELECT password_hash FROM users") as {
      password_hash: string;
    }[];
    for (const { password_hash } of hashes) {
      expect(password_hash).not.toContain("pw-1");
      expect(verifyPassword("pw-1", password_hash)).toBe(true);
    }
  });

  it("creates no lab", () => {
    seedAccounts(db, "pw-1");
    expect(rows("SELECT id FROM labs")).toEqual([]);
  });

  it("can run again: no duplicate, and the new password replaces the old one", () => {
    seedAccounts(db, "pw-1");
    seedAccounts(db, "pw-2");
    expect(rows("SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 5 }]);
    expect(rows("SELECT COUNT(*) AS n FROM class_members")).toEqual([{ n: 4 }]);
    const hashes = rows("SELECT password_hash FROM users") as {
      password_hash: string;
    }[];
    for (const { password_hash } of hashes) {
      expect(verifyPassword("pw-2", password_hash)).toBe(true);
      expect(verifyPassword("pw-1", password_hash)).toBe(false);
    }
  });
});

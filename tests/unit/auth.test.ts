// Reading the bearer token (docs/contract/auth-login.md, section "Using the token") and
// the class rule every lab endpoint uses: only members of a class reach its labs.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate, isMember } from "../../src/auth.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedAccounts } from "../../src/db/seed.ts";

const TOKEN = "a".repeat(43);
const EXPIRES_AT = "2026-11-26T09:00:00.000Z";

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  seedAccounts(db, "pw");
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  ).run(createHash("sha256").update(TOKEN).digest("hex"), "u-ta-1", EXPIRES_AT);
});

afterEach(() => {
  db.close();
});

const at = (iso: string) => new Date(iso);
const BEFORE = at("2026-11-25T12:00:00.000Z");

describe("authenticate", () => {
  it("returns the user of a valid token", () => {
    expect(authenticate(db, `Bearer ${TOKEN}`, BEFORE)).toEqual({
      id: "u-ta-1",
      email: "ta1@leetkob.example",
      displayName: "TA One",
      role: "ta",
    });
  });

  it("returns null without a header", () => {
    expect(authenticate(db, undefined, BEFORE)).toBeNull();
    expect(authenticate(db, "", BEFORE)).toBeNull();
  });

  it("returns null for a header that is not Bearer <token>", () => {
    for (const header of [
      TOKEN,
      `Basic ${TOKEN}`,
      `Bearer`,
      `Bearer `,
      `Bearer ${TOKEN} extra`,
      `Bearer  ${TOKEN}`,
    ]) {
      expect(authenticate(db, header, BEFORE)).toBeNull();
    }
  });

  it("returns null for an unknown token", () => {
    expect(authenticate(db, `Bearer ${"b".repeat(43)}`, BEFORE)).toBeNull();
  });

  it("does not accept the stored hash in place of the token", () => {
    const hash = createHash("sha256").update(TOKEN).digest("hex");
    expect(authenticate(db, `Bearer ${hash}`, BEFORE)).toBeNull();
  });

  it("accepts the token up to its expiry and refuses it after", () => {
    expect(authenticate(db, `Bearer ${TOKEN}`, at(EXPIRES_AT))).not.toBeNull();
    expect(
      authenticate(db, `Bearer ${TOKEN}`, at("2026-11-26T09:00:00.001Z")),
    ).toBeNull();
  });
});

describe("isMember", () => {
  it("is true for a TA and a student of the class", () => {
    expect(isMember(db, "u-ta-1", "class-a")).toBe(true);
    expect(isMember(db, "u-st-1", "class-a")).toBe(true);
  });

  it("is false for a TA of another class", () => {
    expect(isMember(db, "u-ta-2", "class-a")).toBe(false);
  });

  it("is false for the admin, who belongs to no class", () => {
    expect(isMember(db, "u-admin", "class-a")).toBe(false);
  });

  it("is false for a class or a user that does not exist", () => {
    expect(isMember(db, "u-ta-1", "class-z")).toBe(false);
    expect(isMember(db, "u-nobody", "class-a")).toBe(false);
  });
});

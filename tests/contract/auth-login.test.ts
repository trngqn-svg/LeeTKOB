// Contract tests for docs/contract/auth-login.md.
// Expected values are copied from the contract on purpose: never import them from src/.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import { createStore } from "../../src/store.ts";

const CONTRACT = {
  "unsupported-media-type": [415, "Unsupported media type"],
  "validation-failed": [422, "Request body is invalid"],
  "invalid-credentials": [401, "Email or password is wrong"],
} as const;

const PASSWORD = "pw-contract-test";
const T0 = new Date("2026-11-25T09:00:00.000Z");
const T0_PLUS_24H = "2026-11-26T09:00:00.000Z";

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  seedAccounts(db, PASSWORD);
  app = buildApp(createStore({ users: [], labs: [], now: () => T0 }), db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

interface Call {
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

function login({
  body = { email: "ta1@leetkob.example", password: PASSWORD },
  rawBody,
  contentType = "application/json",
}: Call = {}) {
  // null means "send no body"; undefined would silently fall back to the default above.
  const payload = rawBody ?? (body === null ? undefined : JSON.stringify(body));
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers["content-type"] = contentType;
  return app.inject({ method: "POST", url: "/auth/login", headers, payload });
}

type Res = Awaited<ReturnType<typeof login>>;

function expectProblem(res: Res, slug: keyof typeof CONTRACT) {
  const [status, title] = CONTRACT[slug];
  expect(res.statusCode).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({
    type: `https://leetkob.example/problems/${slug}`,
    title,
    status,
    instance: "/auth/login",
  });
  expect(typeof body.detail).toBe("string");
  return body;
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const sessionCount = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

describe("200 — the credentials are right", () => {
  it("returns the token, its expiry and the user, with every field the contract names", async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toEqual({
      token: expect.any(String),
      tokenType: "Bearer",
      expiresAt: T0_PLUS_24H,
      user: {
        id: "u-ta-1",
        email: "ta1@leetkob.example",
        displayName: "TA One",
        role: "ta",
      },
    });
  });

  it("issues 32 random bytes as base64url without padding (43 characters)", async () => {
    const { token } = (await login()).json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stores only the SHA-256 of the token, never the token", async () => {
    const { token } = (await login()).json();
    const rows = db
      .prepare("SELECT token_hash, user_id, expires_at FROM sessions")
      .all();
    expect(rows).toEqual([
      { token_hash: sha256(token), user_id: "u-ta-1", expires_at: T0_PLUS_24H },
    ]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("compares the email without regard to case and answers the stored email", async () => {
    const res = await login({
      body: { email: "TA1@LeeTKOB.Example", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("ta1@leetkob.example");
  });

  it("issues a new token on each login and keeps the earlier one", async () => {
    const first = (await login()).json().token;
    const second = (await login()).json().token;
    expect(second).not.toBe(first);
    expect(sessionCount()).toBe(2);
  });

  it("works for every role", async () => {
    for (const [email, role] of [
      ["admin@leetkob.example", "admin"],
      ["student1@leetkob.example", "student"],
    ]) {
      const res = await login({ body: { email, password: PASSWORD } });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.role).toBe(role);
    }
  });

  it("never contains the password or its hash", async () => {
    const text = (await login()).body;
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("scrypt");
  });
});

describe("401 — invalid-credentials", () => {
  it("answers a wrong password", async () => {
    const res = await login({
      body: { email: "ta1@leetkob.example", password: "wrong" },
    });
    expectProblem(res, "invalid-credentials");
  });

  it("answers an unknown email with the same detail as a wrong password", async () => {
    const wrongPassword = expectProblem(
      await login({
        body: { email: "ta1@leetkob.example", password: "wrong" },
      }),
      "invalid-credentials",
    );
    const unknownEmail = expectProblem(
      await login({
        body: { email: "nobody@leetkob.example", password: PASSWORD },
      }),
      "invalid-credentials",
    );
    expect(unknownEmail.detail).toBe(wrongPassword.detail);
  });

  it("compares the password as given: no trimming, no change of case", async () => {
    for (const password of [
      ` ${PASSWORD}`,
      `${PASSWORD} `,
      PASSWORD.toUpperCase(),
    ]) {
      expectProblem(
        await login({ body: { email: "ta1@leetkob.example", password } }),
        "invalid-credentials",
      );
    }
  });

  it("creates no session", async () => {
    await login({ body: { email: "ta1@leetkob.example", password: "wrong" } });
    expect(sessionCount()).toBe(0);
  });
});

describe("415 — unsupported-media-type", () => {
  it("answers a body that is not application/json", async () => {
    const res = await login({ rawBody: "email=a", contentType: "text/plain" });
    expectProblem(res, "unsupported-media-type");
  });
});

describe("422 — validation-failed", () => {
  const cases: [string, Call, string][] = [
    ["no body", { body: null }, ""],
    ["invalid JSON", { rawBody: "{not json" }, ""],
    ["a body that is not an object", { body: ["ta1@leetkob.example"] }, ""],
    ["a missing email", { body: { password: PASSWORD } }, "/email"],
    [
      "a missing password",
      { body: { email: "ta1@leetkob.example" } },
      "/password",
    ],
    [
      "an email that is not a string",
      { body: { email: 7, password: PASSWORD } },
      "/email",
    ],
    [
      "an email without @",
      { body: { email: "ta1.leetkob.example", password: PASSWORD } },
      "/email",
    ],
    [
      "an email shorter than 3 characters",
      { body: { email: "a@", password: PASSWORD } },
      "/email",
    ],
    [
      "an email longer than 254 characters",
      { body: { email: `${"a".repeat(250)}@x.yz`, password: PASSWORD } },
      "/email",
    ],
    [
      "an empty password",
      { body: { email: "ta1@leetkob.example", password: "" } },
      "/password",
    ],
    [
      "a password longer than 128 characters",
      { body: { email: "ta1@leetkob.example", password: "p".repeat(129) } },
      "/password",
    ],
    [
      "an unknown field",
      {
        body: {
          email: "ta1@leetkob.example",
          password: PASSWORD,
          remember: true,
        },
      },
      "/remember",
    ],
  ];

  for (const [name, call, pointer] of cases) {
    it(`answers ${name}, with a pointer to it`, async () => {
      const body = expectProblem(await login(call), "validation-failed");
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors.length).toBeGreaterThan(0);
      for (const error of body.errors) {
        expect(typeof error.pointer).toBe("string");
        expect(typeof error.message).toBe("string");
      }
      expect(body.errors.map((e: { pointer: string }) => e.pointer)).toContain(
        pointer,
      );
    });
  }

  it("accepts an email of exactly 254 characters and a password of exactly 128", async () => {
    const res = await login({
      body: { email: `${"a".repeat(248)}@x.yzw`, password: "p".repeat(128) },
    });
    // Valid shape, unknown account: the body rules pass, the credentials do not.
    expectProblem(res, "invalid-credentials");
  });
});

describe("order of checks", () => {
  it("1. media type before the body rules", async () => {
    const res = await login({ rawBody: "{}", contentType: "text/plain" });
    expectProblem(res, "unsupported-media-type");
  });

  it("2. body rules before the credentials", async () => {
    const res = await login({
      body: { email: "ta1@leetkob.example", password: PASSWORD, extra: 1 },
    });
    expectProblem(res, "validation-failed");
    expect(sessionCount()).toBe(0);
  });
});

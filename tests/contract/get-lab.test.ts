// Contract tests for docs/contract/get-lab.md.
// Expected values are copied from the contract on purpose: never import them from src/.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import { createStore } from "../../src/store.ts";

const CONTRACT = {
  unauthenticated: [401, "Authentication required"],
  "role-not-allowed": [403, "Your role may not do this"],
  "invalid-query": [400, "Query parameter is invalid"],
  "lab-not-found": [404, "Lab not found"],
} as const;

const PASSWORD = "pw-contract-test";
const T0 = new Date("2026-11-25T09:00:00.000Z");

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;
const tokens: Record<string, string> = {};
let labA = ""; // class-a, created by TA One
let labB = ""; // class-b, created by TA Two

const LAB_BODY = {
  title: "Merge sort",
  statementMd: "# Sort\n\nRead n, then n integers.",
  deadline: "2026-12-01T15:00:00Z",
  timeLimitMs: 2000,
  memoryLimitMb: 128,
  tests: [
    { input: "2\n2 1\n", expectedOutput: "1 2\n" },
    { input: "1\n7\n", expectedOutput: "7\n" },
  ],
  constraints: [
    { text: "Do not call `std::sort`.", deduction: 3 },
    { text: "Write a merge sort yourself.", deduction: 4 },
  ],
};

beforeAll(async () => {
  db = openDatabase(":memory:");
  migrate(db);
  seedAccounts(db, PASSWORD);
  app = buildApp(createStore({ users: [], labs: [], now: () => T0 }), db);
  for (const [who, email] of [
    ["ta1", "ta1@leetkob.example"],
    ["ta2", "ta2@leetkob.example"],
    ["student", "student1@leetkob.example"],
    ["admin", "admin@leetkob.example"],
  ] as const) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: PASSWORD },
    });
    tokens[who] = res.json().token;
  }
  const create = async (classId: string, token: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/classes/${classId}/labs`,
        headers: { authorization: `Bearer ${token}` },
        payload: LAB_BODY,
      })
    ).json().id as string;
  labA = await create("class-a", tokens.ta1 ?? "");
  labB = await create("class-b", tokens.ta2 ?? "");
});

afterAll(async () => {
  await app.close();
  db.close();
});

function getLab({
  labId = labA,
  token = tokens.ta1 ?? "",
  query = "",
}: { labId?: string; token?: string | null; query?: string } = {}) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.inject({ method: "GET", url: `/labs/${labId}${query}`, headers });
}

type Res = Awaited<ReturnType<typeof getLab>>;

function expectProblem(res: Res, slug: keyof typeof CONTRACT, labId = labA) {
  const [status, title] = CONTRACT[slug];
  expect(res.statusCode).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({
    type: `https://leetkob.example/problems/${slug}`,
    title,
    status,
    instance: `/labs/${labId}`,
  });
  expect(typeof body.detail).toBe("string");
  return body;
}

const expectedLab = () => ({
  id: labA,
  classId: "class-a",
  title: "Merge sort",
  statementMd: "# Sort\n\nRead n, then n integers.",
  status: "open",
  deadline: "2026-12-01T15:00:00.000Z",
  publishedAt: null,
  timeLimitMs: 2000,
  memoryLimitMb: 128,
  constraints: [
    {
      code: "C1",
      text: "Do not call `std::sort`.",
      kind: "ban_list",
      bannedNames: ["std::sort"],
      deduction: 3,
    },
    {
      code: "C2",
      text: "Write a merge sort yourself.",
      kind: "semantic",
      bannedNames: [],
      deduction: 4,
    },
  ],
  createdBy: "u-ta-1",
  createdAt: "2026-11-25T09:00:00.000Z",
  testCount: 2,
});

describe("200 — without include (a TA or a student)", () => {
  it("gives a TA the lab without its tests, with every field the contract names", async () => {
    const res = await getLab();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.json()).toEqual(expectedLab());
  });

  it("gives a student of the class the same answer: constraints and deductions, no tests (FAQ-02, FAQ-06)", async () => {
    const res = await getLab({ token: tokens.student ?? "" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expectedLab());
  });

  it("never contains a verdict, a review item or a mark", async () => {
    const text = (await getLab({ token: tokens.student ?? "" })).body;
    for (const word of ["verdict", "evidence", "reviewItem", "mark"]) {
      expect(text).not.toContain(`"${word}`);
    }
  });

  it("shows a published lab with its first Publish time", async () => {
    db.prepare(
      "INSERT INTO publications (lab_id, published_at, published_by, marks_published) VALUES (?, ?, ?, 0)",
    ).run(labB, "2026-11-25T10:00:00.000Z", "u-ta-2");
    db.prepare("UPDATE labs SET status = 'published' WHERE id = ?").run(labB);
    const res = await getLab({ labId: labB, token: tokens.ta2 ?? "" });
    expect(res.json()).toMatchObject({
      status: "published",
      publishedAt: "2026-11-25T10:00:00.000Z",
    });
  });
});

describe("200 — a TA with ?include=tests", () => {
  it("adds the tests in judging order", async () => {
    const res = await getLab({ query: "?include=tests" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ...expectedLab(),
      tests: [
        { position: 1, input: "2\n2 1\n", expectedOutput: "1 2\n" },
        { position: 2, input: "1\n7\n", expectedOutput: "7\n" },
      ],
    });
  });
});

describe("401 — unauthenticated", () => {
  it("answers no token and an unknown token", async () => {
    expectProblem(await getLab({ token: null }), "unauthenticated");
    expectProblem(await getLab({ token: "x".repeat(43) }), "unauthenticated");
  });
});

describe("403 — role-not-allowed", () => {
  it("answers an admin, naming both roles that may read a lab", async () => {
    const body = expectProblem(
      await getLab({ token: tokens.admin ?? "" }),
      "role-not-allowed",
    );
    expect(body.requiredRole).toEqual(["ta", "student"]);
  });

  it("answers a student who asks for the tests, naming the TA role", async () => {
    const body = expectProblem(
      await getLab({ token: tokens.student ?? "", query: "?include=tests" }),
      "role-not-allowed",
    );
    expect(body.requiredRole).toBe("ta");
  });
});

describe("400 — invalid-query", () => {
  const cases: [string, string, string][] = [
    ["an unknown value of include", "?include=statement", "include"],
    ["include given twice", "?include=tests&include=tests", "include"],
    ["an empty include", "?include=", "include"],
    ["an unknown parameter", "?verbose=1", "verbose"],
  ];
  for (const [name, query, parameter] of cases) {
    it(`answers ${name}, naming the parameter`, async () => {
      const body = expectProblem(await getLab({ query }), "invalid-query");
      expect(body.parameter).toBe(parameter);
    });
  }
});

describe("404 — lab-not-found", () => {
  it("answers a TA of another class like a lab that does not exist", async () => {
    const other = expectProblem(
      await getLab({ token: tokens.ta2 ?? "" }),
      "lab-not-found",
    );
    const missing = expectProblem(
      await getLab({ labId: "lab-missing" }),
      "lab-not-found",
      "lab-missing",
    );
    expect(other.detail).toBe(missing.detail);
  });

  it("answers a student of another class", async () => {
    expectProblem(
      await getLab({ labId: labB, token: tokens.student ?? "" }),
      "lab-not-found",
      labB,
    );
  });
});

describe("order of checks", () => {
  it("1. authentication before the role", async () => {
    expectProblem(
      await getLab({ token: null, query: "?verbose=1" }),
      "unauthenticated",
    );
  });

  it("2. the admin's role before the query", async () => {
    expectProblem(
      await getLab({ token: tokens.admin ?? "", query: "?verbose=1" }),
      "role-not-allowed",
    );
  });

  it("3. the query before the lab", async () => {
    expectProblem(
      await getLab({ labId: "lab-missing", query: "?verbose=1" }),
      "invalid-query",
      "lab-missing",
    );
  });

  it("4. the lab before a student's include=tests: another class learns nothing", async () => {
    expectProblem(
      await getLab({
        labId: labB,
        token: tokens.student ?? "",
        query: "?include=tests",
      }),
      "lab-not-found",
      labB,
    );
  });
});

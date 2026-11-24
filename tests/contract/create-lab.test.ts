// Contract tests for docs/contract/create-lab.md.
// Expected values are copied from the contract on purpose: never import them from src/.
// One database for the file (seeding hashes passwords, which is slow); a test that
// counts rows compares before and after its own call.
import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import { createStore } from "../../src/store.ts";

const CONTRACT = {
  "payload-too-large": [413, "Request body is too large"],
  "unsupported-media-type": [415, "Unsupported media type"],
  "validation-failed": [422, "Request body is invalid"],
  unauthenticated: [401, "Authentication required"],
  "role-not-allowed": [403, "Your role may not do this"],
  "class-not-found": [404, "Class not found"],
} as const;

const BODY_LIMIT = 8 * 1024 * 1024;
const PASSWORD = "pw-contract-test";
const T0 = new Date("2026-11-25T09:00:00.000Z");

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;
const tokens: Record<string, string> = {};

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
});

afterAll(async () => {
  await app.close();
  db.close();
});

const validBody = () => ({
  title: "  Merge sort  ",
  statementMd: "# Sort the numbers\n\nRead n, then n integers.",
  tests: [
    { input: "5\n3 1 4 1 5\n", expectedOutput: "1 1 3 4 5\n" },
    { input: "1\n7\n", expectedOutput: "7\n" },
  ],
  constraints: [
    {
      text: "Do not call a library sort function: `std::sort`, `std::stable_sort`, `qsort`.",
      deduction: 3,
    },
    {
      text: "Sort with a merge sort you wrote yourself: split the range, sort both halves, merge them.",
      deduction: 4,
    },
  ],
});

interface Call {
  classId?: string;
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

function createLab({
  classId = "class-a",
  token = tokens.ta1 ?? "",
  body = validBody(),
  rawBody,
  contentType = "application/json",
}: Call = {}) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  // null means "send no body"; undefined would silently fall back to the default above.
  const payload = rawBody ?? (body === null ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers["content-type"] = contentType;
  return app.inject({
    method: "POST",
    url: `/classes/${classId}/labs`,
    headers,
    payload,
  });
}

type Res = Awaited<ReturnType<typeof createLab>>;

function expectProblem(
  res: Res,
  slug: keyof typeof CONTRACT,
  classId = "class-a",
) {
  const [status, title] = CONTRACT[slug];
  expect(res.statusCode).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({
    type: `https://leetkob.example/problems/${slug}`,
    title,
    status,
    instance: `/classes/${classId}/labs`,
  });
  expect(typeof body.detail).toBe("string");
  return body;
}

function expectInvalid(res: Res, pointer: string) {
  const body = expectProblem(res, "validation-failed");
  expect(Array.isArray(body.errors)).toBe(true);
  for (const error of body.errors) {
    expect(typeof error.pointer).toBe("string");
    expect(typeof error.message).toBe("string");
  }
  expect(body.errors.map((e: { pointer: string }) => e.pointer)).toContain(
    pointer,
  );
}

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("201 — the lab was created", () => {
  it("answers the lab with every field the contract names", async () => {
    const res = await createLab();
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const body = res.json();
    expect(body).toEqual({
      id: expect.any(String),
      classId: "class-a",
      title: "Merge sort",
      status: "open",
      deadline: null,
      timeLimitMs: 1000,
      memoryLimitMb: 256,
      testCount: 2,
      constraints: [
        {
          code: "C1",
          text: "Do not call a library sort function: `std::sort`, `std::stable_sort`, `qsort`.",
          kind: "ban_list",
          bannedNames: ["std::sort", "std::stable_sort", "qsort"],
          deduction: 3,
        },
        {
          code: "C2",
          text: "Sort with a merge sort you wrote yourself: split the range, sort both halves, merge them.",
          kind: "semantic",
          bannedNames: [],
          deduction: 4,
        },
      ],
      createdBy: "u-ta-1",
      createdAt: "2026-11-25T09:00:00.000Z",
    });
    expect(res.headers.location).toBe(`/labs/${body.id}`);
  });

  it("stores the lab, its tests in order and its constraints as read", async () => {
    const before = count("labs");
    const { id } = (await createLab()).json();
    expect(count("labs")).toBe(before + 1);
    expect(
      db
        .prepare(
          "SELECT position, input, expected_output FROM lab_tests WHERE lab_id = ? ORDER BY position",
        )
        .all(id),
    ).toEqual([
      { position: 1, input: "5\n3 1 4 1 5\n", expected_output: "1 1 3 4 5\n" },
      { position: 2, input: "1\n7\n", expected_output: "7\n" },
    ]);
    expect(
      db
        .prepare(
          "SELECT code, kind, banned_names, deduction FROM lab_constraints WHERE lab_id = ? ORDER BY code",
        )
        .all(id),
    ).toEqual([
      {
        code: "C1",
        kind: "ban_list",
        banned_names: '["std::sort","std::stable_sort","qsort"]',
        deduction: 3,
      },
      { code: "C2", kind: "semantic", banned_names: "[]", deduction: 4 },
    ]);
  });

  it("repeats neither the statement nor the tests", async () => {
    const body = (await createLab()).json();
    expect(body).not.toHaveProperty("statementMd");
    expect(body).not.toHaveProperty("tests");
  });

  it("takes the optional limits and a future deadline, stored in UTC", async () => {
    const res = await createLab({
      body: {
        ...validBody(),
        deadline: "2026-12-01T22:00:00+07:00",
        timeLimitMs: 5000,
        memoryLimitMb: 64,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      deadline: "2026-12-01T15:00:00.000Z",
      timeLimitMs: 5000,
      memoryLimitMb: 64,
    });
  });

  it("accepts an empty list of constraints", async () => {
    const res = await createLab({ body: { ...validBody(), constraints: [] } });
    expect(res.statusCode).toBe(201);
    expect(res.json().constraints).toEqual([]);
  });

  it("creates two labs when the same body is sent twice", async () => {
    const first = (await createLab()).json().id;
    const second = (await createLab()).json().id;
    expect(second).not.toBe(first);
  });

  it("creates the dev set's sort-merge lab from its own files (the rubric's walk-through)", async () => {
    const dir = new URL(
      "../../leetkob-eval/problems/sort-merge/",
      import.meta.url,
    );
    const names = readdirSync(new URL("tests/", dir))
      .filter((name) => name.endsWith(".in"))
      .sort();
    const constraints = JSON.parse(
      readFileSync(new URL("constraints.json", dir), "utf8"),
    ) as { text: string; deduction: number }[];
    const res = await createLab({
      body: {
        title: "sort-merge",
        statementMd: readFileSync(new URL("statement.md", dir), "utf8"),
        tests: names.map((name) => ({
          input: readFileSync(new URL(`tests/${name}`, dir), "utf8"),
          expectedOutput: readFileSync(
            new URL(`tests/${name.replace(/\.in$/, ".out")}`, dir),
            "utf8",
          ),
        })),
        constraints: constraints.map(({ text, deduction }) => ({
          text,
          deduction,
        })),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.testCount).toBe(names.length);
    expect(body.constraints.map((c: { kind: string }) => c.kind)).toEqual([
      "ban_list",
      "semantic",
    ]);
  });
});

describe("401 — unauthenticated", () => {
  it("answers no token", async () => {
    expectProblem(await createLab({ token: null }), "unauthenticated");
  });

  it("answers an unknown token", async () => {
    expectProblem(
      await createLab({ token: "x".repeat(43) }),
      "unauthenticated",
    );
  });
});

describe("403 — role-not-allowed", () => {
  it("answers a student and an admin, naming the role the endpoint needs", async () => {
    for (const who of ["student", "admin"]) {
      const body = expectProblem(
        await createLab({ token: tokens[who] ?? "" }),
        "role-not-allowed",
      );
      expect(body.requiredRole).toBe("ta");
    }
  });
});

describe("404 — class-not-found", () => {
  it("answers a TA of another class like a class that does not exist", async () => {
    const other = expectProblem(
      await createLab({ token: tokens.ta2 ?? "" }),
      "class-not-found",
    );
    const missing = expectProblem(
      await createLab({ classId: "class-z" }),
      "class-not-found",
      "class-z",
    );
    expect(other.detail).toBe(missing.detail);
  });

  it("stores nothing", async () => {
    const before = count("labs");
    await createLab({ token: tokens.ta2 ?? "" });
    expect(count("labs")).toBe(before);
  });
});

describe("413 — payload-too-large", () => {
  it("answers a body over 8 MiB, with the limit", async () => {
    const body = expectProblem(
      await createLab({ rawBody: `"${"x".repeat(BODY_LIMIT)}"` }),
      "payload-too-large",
    );
    expect(body.limitBytes).toBe(BODY_LIMIT);
  });
});

describe("415 — unsupported-media-type", () => {
  it("answers a body that is not application/json", async () => {
    expectProblem(
      await createLab({ rawBody: "title=x", contentType: "text/plain" }),
      "unsupported-media-type",
    );
  });
});

describe("422 — validation-failed", () => {
  const body = validBody;
  const test0 = (patch: object) => ({
    ...body(),
    tests: [{ ...body().tests[0], ...patch }],
  });
  const constraint0 = (patch: object) => ({
    ...body(),
    constraints: [{ ...body().constraints[0], ...patch }],
  });
  const mib = 1024 * 1024;

  const cases: [string, unknown, string][] = [
    ["a body that is not an object", [body()], ""],
    ["an unknown field", { ...body(), extra: 1 }, "/extra"],
    ["a missing title", { ...body(), title: undefined }, "/title"],
    [
      "a title that is blank after trimming",
      { ...body(), title: "   " },
      "/title",
    ],
    [
      "a title over 200 characters",
      { ...body(), title: "t".repeat(201) },
      "/title",
    ],
    [
      "a missing statement",
      { ...body(), statementMd: undefined },
      "/statementMd",
    ],
    ["an empty statement", { ...body(), statementMd: "" }, "/statementMd"],
    [
      "a statement over 100 000 characters",
      { ...body(), statementMd: "s".repeat(100_001) },
      "/statementMd",
    ],
    [
      "a deadline that is not a string",
      { ...body(), deadline: 1 },
      "/deadline",
    ],
    [
      "a deadline without a time zone",
      { ...body(), deadline: "2026-12-01T10:00:00" },
      "/deadline",
    ],
    [
      "a deadline that is not a date",
      { ...body(), deadline: "next Friday" },
      "/deadline",
    ],
    [
      "a deadline in the past",
      { ...body(), deadline: "2026-11-25T08:59:59Z" },
      "/deadline",
    ],
    [
      "a time limit under 1000",
      { ...body(), timeLimitMs: 999 },
      "/timeLimitMs",
    ],
    [
      "a time limit over 5000",
      { ...body(), timeLimitMs: 5001 },
      "/timeLimitMs",
    ],
    [
      "a time limit that is not an integer",
      { ...body(), timeLimitMs: 1500.5 },
      "/timeLimitMs",
    ],
    [
      "a time limit as a string",
      { ...body(), timeLimitMs: "1000" },
      "/timeLimitMs",
    ],
    [
      "a memory limit under 64",
      { ...body(), memoryLimitMb: 63 },
      "/memoryLimitMb",
    ],
    [
      "a memory limit over 512",
      { ...body(), memoryLimitMb: 513 },
      "/memoryLimitMb",
    ],
    ["missing tests", { ...body(), tests: undefined }, "/tests"],
    ["no test", { ...body(), tests: [] }, "/tests"],
    [
      "more than 50 tests",
      { ...body(), tests: Array(51).fill(body().tests[0]) },
      "/tests",
    ],
    ["a test that is not an object", { ...body(), tests: ["5"] }, "/tests/0"],
    ["a test without input", test0({ input: undefined }), "/tests/0/input"],
    [
      "a test without expected output",
      test0({ expectedOutput: undefined }),
      "/tests/0/expectedOutput",
    ],
    ["an unknown field in a test", test0({ extra: 1 }), "/tests/0/extra"],
    [
      "an input over 2 MiB in UTF-8",
      test0({ input: "x".repeat(2 * mib + 1) }),
      "/tests/0/input",
    ],
    [
      "an expected output over 1 MiB in UTF-8, counted in bytes",
      test0({ expectedOutput: "é".repeat(mib / 2 + 1) }),
      "/tests/0/expectedOutput",
    ],
    [
      "missing constraints",
      { ...body(), constraints: undefined },
      "/constraints",
    ],
    [
      "more than 20 constraints",
      { ...body(), constraints: Array(21).fill(body().constraints[1]) },
      "/constraints",
    ],
    [
      "a constraint that is not an object",
      { ...body(), constraints: ["x"] },
      "/constraints/0",
    ],
    [
      "a constraint text that is blank",
      constraint0({ text: "  " }),
      "/constraints/0/text",
    ],
    [
      "a constraint text over 2000 characters",
      constraint0({ text: "c".repeat(2001) }),
      "/constraints/0/text",
    ],
    [
      "a deduction over 10",
      constraint0({ deduction: 11 }),
      "/constraints/0/deduction",
    ],
    [
      "a negative deduction",
      constraint0({ deduction: -1 }),
      "/constraints/0/deduction",
    ],
    [
      "a deduction that is not an integer",
      constraint0({ deduction: 2.5 }),
      "/constraints/0/deduction",
    ],
    [
      "a missing deduction",
      constraint0({ deduction: undefined }),
      "/constraints/0/deduction",
    ],
    [
      "an unknown field in a constraint",
      constraint0({ extra: 1 }),
      "/constraints/0/extra",
    ],
    [
      "a ban list with no name in backticks",
      constraint0({ text: "Do not use any library sort." }),
      "/constraints/0/text",
    ],
  ];

  for (const [name, payload, pointer] of cases) {
    it(`answers ${name}, with a pointer to it`, async () => {
      expectInvalid(await createLab({ body: payload }), pointer);
    });
  }

  it("answers no body", async () => {
    expectInvalid(await createLab({ body: null }), "");
  });

  it("answers invalid JSON", async () => {
    expectProblem(
      await createLab({ rawBody: "{not json" }),
      "validation-failed",
    );
  });

  it("accepts the limits at their edges", async () => {
    const res = await createLab({
      body: {
        ...body(),
        title: "t".repeat(200),
        timeLimitMs: 1000,
        memoryLimitMb: 512,
        tests: Array(50).fill({
          input: "",
          expectedOutput: "x".repeat(1024),
        }),
        constraints: Array(20).fill(
          constraint0({ deduction: 10 }).constraints[0],
        ),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().constraints.map((c: { code: string }) => c.code)).toEqual(
      Array.from({ length: 20 }, (_, i) => `C${i + 1}`),
    );
  });

  it("stores nothing", async () => {
    const before = count("labs");
    await createLab({ body: { ...body(), tests: [] } });
    expect(count("labs")).toBe(before);
  });
});

describe("order of checks", () => {
  it("1. the size before everything, even without a token", async () => {
    expectProblem(
      await createLab({ token: null, rawBody: `"${"x".repeat(BODY_LIMIT)}"` }),
      "payload-too-large",
    );
  });

  it("2. the media type and the JSON syntax before authentication", async () => {
    expectProblem(
      await createLab({ token: null, rawBody: "x", contentType: "text/plain" }),
      "unsupported-media-type",
    );
    expectProblem(
      await createLab({ token: null, rawBody: "{not json" }),
      "validation-failed",
    );
  });

  it("3. authentication before the role", async () => {
    expectProblem(await createLab({ token: null }), "unauthenticated");
  });

  it("4. the role before the class", async () => {
    expectProblem(
      await createLab({ token: tokens.student ?? "", classId: "class-z" }),
      "role-not-allowed",
      "class-z",
    );
  });

  it("5. the class before the body rules", async () => {
    expectProblem(
      await createLab({ token: tokens.ta2 ?? "", body: { title: "" } }),
      "class-not-found",
    );
  });
});

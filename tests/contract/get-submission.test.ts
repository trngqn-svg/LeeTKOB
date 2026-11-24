// Contract tests for docs/contract/get-submission.md.
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
  "submission-not-found": [404, "Submission not found"],
} as const;

const PASSWORD = "pw-contract-test";
const T0 = new Date("2026-11-25T09:00:00.000Z");
const SOURCE = "#include <iostream>\nint main() { std::cout << 1; }\n";

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;
const tokens: Record<string, string> = {};
let labA = ""; // class-a
let subQueued = ""; // student1, sent through the API
const WRONG = "sub-judged-wrong"; // student1, wrong_answer at test 2
const COMPILE = "sub-judged-compile"; // student1, compile_error
const RUNNING = "sub-running"; // student1
const FAILED = "sub-failed"; // student1
const OTHERS = "sub-student2"; // student2, same class

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
  constraints: [{ text: "Do not call `std::sort`.", deduction: 3 }],
};

const WRONG_DETAIL = {
  tests: [
    { position: 1, result: "passed", timeMs: 4 },
    { position: 2, result: "wrong_answer", timeMs: 6 },
  ],
};
const COMPILE_DETAIL = {
  compilerMessage: "main.cpp:3:1: error: expected ';' before '}' token\n",
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
    ["student2", "student2@leetkob.example"],
    ["admin", "admin@leetkob.example"],
  ] as const) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: PASSWORD },
    });
    tokens[who] = res.json().token;
  }
  labA = (
    await app.inject({
      method: "POST",
      url: "/classes/class-a/labs",
      headers: { authorization: `Bearer ${tokens.ta1}` },
      payload: LAB_BODY,
    })
  ).json().id;
  subQueued = (
    await app.inject({
      method: "POST",
      url: `/labs/${labA}/submissions`,
      headers: { authorization: `Bearer ${tokens.student}` },
      payload: { sourceCode: SOURCE },
    })
  ).json().submissionId;

  // The worker's states, written as the worker would (T7 writes them for real).
  const insert = db.prepare(`
    INSERT INTO submissions (id, lab_id, student_id, source_code, status, judge_result,
                             judge_detail, attempts, locked_by, lease_until, created_at,
                             started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(
    WRONG,
    labA,
    "u-st-1",
    SOURCE,
    "judged",
    "wrong_answer",
    JSON.stringify(WRONG_DETAIL),
    1,
    null,
    null,
    "2026-11-25T08:00:00.000Z",
    "2026-11-25T08:00:01.000Z",
    "2026-11-25T08:00:03.000Z",
  );
  insert.run(
    COMPILE,
    labA,
    "u-st-1",
    "int main( {",
    "judged",
    "compile_error",
    JSON.stringify(COMPILE_DETAIL),
    1,
    null,
    null,
    "2026-11-25T08:01:00.000Z",
    "2026-11-25T08:01:01.000Z",
    "2026-11-25T08:01:02.000Z",
  );
  insert.run(
    RUNNING,
    labA,
    "u-st-1",
    SOURCE,
    "running",
    null,
    null,
    1,
    "worker-1",
    "2026-11-25T09:05:00.000Z",
    "2026-11-25T08:02:00.000Z",
    "2026-11-25T08:02:01.000Z",
    null,
  );
  insert.run(
    FAILED,
    labA,
    "u-st-1",
    SOURCE,
    "failed",
    null,
    null,
    3,
    null,
    null,
    "2026-11-25T08:03:00.000Z",
    "2026-11-25T08:03:01.000Z",
    "2026-11-25T08:03:30.000Z",
  );
  insert.run(
    OTHERS,
    labA,
    "u-st-2",
    SOURCE,
    "queued",
    null,
    null,
    0,
    null,
    null,
    "2026-11-25T08:04:00.000Z",
    null,
    null,
  );
});

afterAll(async () => {
  await app.close();
  db.close();
});

function getSubmission(
  id: string,
  { token = tokens.student ?? "" }: { token?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.inject({ method: "GET", url: `/submissions/${id}`, headers });
}

type Res = Awaited<ReturnType<typeof getSubmission>>;

function expectProblem(res: Res, slug: keyof typeof CONTRACT, id: string) {
  const [status, title] = CONTRACT[slug];
  expect(res.statusCode).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({
    type: `https://leetkob.example/problems/${slug}`,
    title,
    status,
    instance: `/submissions/${id}`,
  });
  expect(typeof body.detail).toBe("string");
  return body;
}

function expect200(res: Res) {
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toMatch(/^application\/json/);
  expect(res.headers["cache-control"]).toBe("private, no-store");
  return res.json();
}

describe("200 — the student who sent it", () => {
  it("reads a queued submission with every field the contract names", async () => {
    expect(expect200(await getSubmission(subQueued))).toEqual({
      id: subQueued,
      labId: labA,
      studentId: "u-st-1",
      status: "queued",
      judgeResult: null,
      judgeDetail: null,
      sourceCode: SOURCE,
      createdAt: "2026-11-25T09:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });
  });

  it("reads a judged submission with the result of each test up to the first that failed", async () => {
    expect(expect200(await getSubmission(WRONG))).toEqual({
      id: WRONG,
      labId: labA,
      studentId: "u-st-1",
      status: "judged",
      judgeResult: "wrong_answer",
      judgeDetail: WRONG_DETAIL,
      sourceCode: SOURCE,
      createdAt: "2026-11-25T08:00:00.000Z",
      startedAt: "2026-11-25T08:00:01.000Z",
      finishedAt: "2026-11-25T08:00:03.000Z",
    });
  });

  it("reads a compile error with the compiler's message", async () => {
    expect(expect200(await getSubmission(COMPILE))).toMatchObject({
      status: "judged",
      judgeResult: "compile_error",
      judgeDetail: COMPILE_DETAIL,
      sourceCode: "int main( {",
    });
  });

  it("reads a running submission: started, not finished, no result", async () => {
    expect(expect200(await getSubmission(RUNNING))).toMatchObject({
      status: "running",
      judgeResult: null,
      judgeDetail: null,
      startedAt: "2026-11-25T08:02:01.000Z",
      finishedAt: null,
    });
  });

  it("reads a failed submission: finished, no result", async () => {
    expect(expect200(await getSubmission(FAILED))).toMatchObject({
      status: "failed",
      judgeResult: null,
      judgeDetail: null,
      finishedAt: "2026-11-25T08:03:30.000Z",
    });
  });

  it("never contains a verdict, a review item, a deduction, a mark or a test's data", async () => {
    for (const id of [subQueued, WRONG, COMPILE]) {
      const text = (await getSubmission(id)).body;
      for (const word of [
        "verdict",
        "evidence",
        "reviewItem",
        "deduction",
        "mark",
        "input",
        "expectedOutput",
        "lockedBy",
        "attempts",
      ]) {
        expect(text).not.toContain(`"${word}`);
      }
    }
  });
});

describe("200 — a TA of the class", () => {
  it("reads any student's submission, with the same answer the student gets", async () => {
    const asStudent = expect200(await getSubmission(WRONG));
    const asTa = expect200(
      await getSubmission(WRONG, { token: tokens.ta1 ?? "" }),
    );
    expect(asTa).toEqual(asStudent);
    expect(
      expect200(await getSubmission(OTHERS, { token: tokens.ta1 ?? "" })),
    ).toMatchObject({ id: OTHERS, studentId: "u-st-2" });
  });
});

describe("401 — unauthenticated", () => {
  it("answers no token and an unknown token", async () => {
    expectProblem(
      await getSubmission(WRONG, { token: null }),
      "unauthenticated",
      WRONG,
    );
    expectProblem(
      await getSubmission(WRONG, { token: "x".repeat(43) }),
      "unauthenticated",
      WRONG,
    );
  });
});

describe("403 — role-not-allowed", () => {
  it("answers an admin, naming both roles that may read a submission", async () => {
    const body = expectProblem(
      await getSubmission(WRONG, { token: tokens.admin ?? "" }),
      "role-not-allowed",
      WRONG,
    );
    expect(body.requiredRole).toEqual(["student", "ta"]);
  });
});

describe("404 — submission-not-found", () => {
  it("answers another student of the same class, a TA of another class and a missing id alike", async () => {
    const missing = expectProblem(
      await getSubmission("sub-missing"),
      "submission-not-found",
      "sub-missing",
    );
    const otherStudent = expectProblem(
      await getSubmission(WRONG, { token: tokens.student2 ?? "" }),
      "submission-not-found",
      WRONG,
    );
    const notMine = expectProblem(
      await getSubmission(OTHERS),
      "submission-not-found",
      OTHERS,
    );
    const otherClass = expectProblem(
      await getSubmission(WRONG, { token: tokens.ta2 ?? "" }),
      "submission-not-found",
      WRONG,
    );
    for (const body of [otherStudent, notMine, otherClass]) {
      expect(body.detail).toBe(missing.detail);
    }
  });
});

describe("order of checks", () => {
  it("1. authentication before the role and the submission", async () => {
    expectProblem(
      await getSubmission("sub-missing", { token: null }),
      "unauthenticated",
      "sub-missing",
    );
  });

  it("2. the role before the submission", async () => {
    expectProblem(
      await getSubmission("sub-missing", { token: tokens.admin ?? "" }),
      "role-not-allowed",
      "sub-missing",
    );
  });
});

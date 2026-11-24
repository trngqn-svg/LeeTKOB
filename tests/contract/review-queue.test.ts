// Contract tests for docs/contract/review-queue.md.
// Expected values are copied from the contract on purpose: never import them from src/.
// The verdicts are written by the worker queue's own finishJob, as a real run would.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { finishJob } from "../../src/db/queue.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import type {
  ConstraintResult,
  SandboxOutcome,
} from "../../src/judge/types.ts";
import { createStore } from "../../src/store.ts";

const CONTRACT = {
  unauthenticated: [401, "Authentication required"],
  "role-not-allowed": [403, "Your role may not do this"],
  "invalid-query": [400, "Query parameter is invalid"],
  "lab-not-found": [404, "Lab not found"],
} as const;

const PASSWORD = "pw-contract-test";
const T0 = new Date("2026-11-26T09:00:00.000Z");
const iso = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();
const QUEUE = { workerId: "w-test", leaseSeconds: 60, maxAttempts: 3 };

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;
const tokens: Record<string, string> = {};
let labA = ""; // class-a
let labB = ""; // class-b, published

const LAB_BODY = {
  title: "Merge sort",
  statementMd: "# Sort",
  deadline: "2026-12-01T15:00:00Z",
  tests: [{ input: "1\n7\n", expectedOutput: "7\n" }],
  constraints: [
    { text: "Do not call `std::sort`.", deduction: 3 },
    { text: "Write a merge sort yourself.", deduction: 4 },
  ],
};

const PASSED: SandboxOutcome = {
  result: "accepted",
  tests: [{ position: 1, result: "passed", timeMs: 3 }],
};
const EVIDENCE = [{ line: 2, text: "  std::sort(a, a + n);" }];
const pass = (code: string, by: "hard_rule" | "model"): ConstraintResult => ({
  constraintCode: code,
  verdict: "pass",
  decidedBy: by,
  evidence: [],
  modelCall: null,
});

function addSubmission(
  id: string,
  labId: string,
  student: string,
  createdAt: string,
) {
  db.prepare(
    "INSERT INTO submissions (id, lab_id, student_id, source_code, created_at) VALUES (?, ?, ?, 'int main() {}', ?)",
  ).run(id, labId, student, createdAt);
}

/** Puts a queued row in a worker's hands and finishes it, as the worker would. */
function judge(
  id: string,
  outcome: SandboxOutcome,
  results: ConstraintResult[],
) {
  db.prepare(
    "UPDATE submissions SET status = 'running', locked_by = ?, lease_until = ?, attempts = 1, started_at = ? WHERE id = ?",
  ).run(QUEUE.workerId, iso(600), iso(10), id);
  const done = finishJob(db, QUEUE, {
    id,
    now: new Date(iso(20)),
    outcome,
    results,
    samplePass: () => false,
  });
  expect(done).toBe(true);
}

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

  // Lab A: one submission in each state the queue must show, oldest first.
  addSubmission("s1-violation", labA, "u-st-1", iso(1));
  addSubmission("s2-compliant", labA, "u-st-2", iso(2));
  addSubmission("s3-wrong", labA, "u-st-1", iso(3));
  addSubmission("s4-queued", labA, "u-st-2", iso(4));
  addSubmission("s5-failed", labA, "u-st-1", iso(5));
  addSubmission("s6-running", labA, "u-st-2", iso(6));
  addSubmission("s7-reviewed", labA, "u-st-1", iso(7));

  judge("s1-violation", PASSED, [
    {
      constraintCode: "C1",
      verdict: "violation",
      decidedBy: "hard_rule",
      evidence: [EVIDENCE[0]!],
      modelCall: null,
    },
    pass("C2", "model"),
  ]);
  judge("s2-compliant", PASSED, [pass("C1", "hard_rule"), pass("C2", "model")]);
  judge(
    "s3-wrong",
    {
      result: "wrong_answer",
      tests: [{ position: 1, result: "wrong_answer", timeMs: 2 }],
    },
    [],
  );
  db.prepare(
    "UPDATE submissions SET status = 'failed', attempts = 3, started_at = ?, finished_at = ? WHERE id = 's5-failed'",
  ).run(iso(10), iso(30));
  db.prepare(
    "UPDATE submissions SET status = 'running', locked_by = 'w2', lease_until = ?, attempts = 1, started_at = ? WHERE id = 's6-running'",
  ).run(iso(600), iso(10));
  judge("s7-reviewed", PASSED, [
    pass("C1", "hard_rule"),
    {
      constraintCode: "C2",
      verdict: "unsure",
      decidedBy: "fallback",
      reason: "model_off",
      evidence: [],
      modelCall: null,
    },
  ]);
  // A TA already decided the unsure item of s7.
  db.prepare(
    `UPDATE review_items SET status = 'reviewed', final_verdict = 'pass', note = 'Merge sort, fine.',
            reviewed_by = 'u-ta-1', reviewed_at = ?
      WHERE verdict_id = (SELECT v.id FROM verdicts v JOIN lab_constraints c ON c.id = v.constraint_id
                           WHERE v.submission_id = 's7-reviewed' AND c.code = 'C2')`,
  ).run(iso(40));

  // Lab B, another class, published.
  addSubmission("sb-1", labB, "u-st-1", iso(1));
  db.prepare(
    "INSERT INTO publications (lab_id, published_at, published_by, marks_published) VALUES (?, ?, 'u-ta-2', 0)",
  ).run(labB, iso(50));
  db.prepare("UPDATE labs SET status = 'published' WHERE id = ?").run(labB);
});

afterAll(async () => {
  await app.close();
  db.close();
});

function getQueue({
  labId = labA,
  token = tokens.ta1 ?? "",
  query = "",
}: { labId?: string; token?: string | null; query?: string } = {}) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.inject({
    method: "GET",
    url: `/labs/${labId}/review-queue${query}`,
    headers,
  });
}

type Res = Awaited<ReturnType<typeof getQueue>>;

function expectProblem(res: Res, slug: keyof typeof CONTRACT, labId = labA) {
  const [status, title] = CONTRACT[slug];
  expect(res.statusCode).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({
    type: `https://leetkob.example/problems/${slug}`,
    title,
    status,
    instance: `/labs/${labId}/review-queue`,
  });
  expect(typeof body.detail).toBe("string");
  return body;
}

const itemId = (submissionId: string, code: string) =>
  (
    db
      .prepare(
        `SELECT r.id FROM review_items r JOIN verdicts v ON v.id = r.verdict_id
           JOIN lab_constraints c ON c.id = v.constraint_id
          WHERE v.submission_id = ? AND c.code = ?`,
      )
      .get(submissionId, code) as { id: number }
  ).id;

const S1 = () => ({
  submissionId: "s1-violation",
  studentId: "u-st-1",
  studentName: "Student One",
  status: "judged",
  judgeResult: "accepted",
  createdAt: iso(1),
  verdicts: [
    {
      constraintCode: "C1",
      deduction: 3,
      verdict: "violation",
      decidedBy: "hard_rule",
      reasonCode: null,
      evidence: EVIDENCE,
      reviewItem: {
        id: itemId("s1-violation", "C1"),
        reason: "violation",
        status: "pending",
        finalVerdict: null,
        finalEvidence: null,
        note: null,
        reviewedBy: null,
        reviewedAt: null,
      },
    },
    {
      constraintCode: "C2",
      deduction: 4,
      verdict: "pass",
      decidedBy: "model",
      reasonCode: null,
      evidence: [],
      reviewItem: null,
    },
  ],
});

const plain = (
  submissionId: string,
  studentId: string,
  status: string,
  judgeResult: string | null,
  createdAt: string,
) => ({
  submissionId,
  studentId,
  studentName: studentId === "u-st-1" ? "Student One" : "Student Two",
  status,
  judgeResult,
  createdAt,
  verdicts: [],
});

const SUMMARY_COUNTS = {
  pendingReviews: 1,
  unjudgedSubmissions: 2,
  failedSubmissions: 1,
};

describe("200 — the TA of the class", () => {
  it("lists every submission oldest first, with every verdict of each accepted one", async () => {
    const res = await getQueue();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.json()).toEqual({
      labId: labA,
      labStatus: "open",
      summary: { submissions: 7, ...SUMMARY_COUNTS },
      constraints: [
        {
          code: "C1",
          text: "Do not call `std::sort`.",
          kind: "ban_list",
          deduction: 3,
        },
        {
          code: "C2",
          text: "Write a merge sort yourself.",
          kind: "semantic",
          deduction: 4,
        },
      ],
      submissions: [
        S1(),
        {
          // A compliant submission appears with all its verdicts (rubric criterion 1).
          ...plain("s2-compliant", "u-st-2", "judged", "accepted", iso(2)),
          verdicts: [
            {
              constraintCode: "C1",
              deduction: 3,
              verdict: "pass",
              decidedBy: "hard_rule",
              reasonCode: null,
              evidence: [],
              reviewItem: null,
            },
            {
              constraintCode: "C2",
              deduction: 4,
              verdict: "pass",
              decidedBy: "model",
              reasonCode: null,
              evidence: [],
              reviewItem: null,
            },
          ],
        },
        plain("s3-wrong", "u-st-1", "judged", "wrong_answer", iso(3)),
        plain("s4-queued", "u-st-2", "queued", null, iso(4)),
        plain("s5-failed", "u-st-1", "failed", null, iso(5)),
        plain("s6-running", "u-st-2", "running", null, iso(6)),
        {
          ...plain("s7-reviewed", "u-st-1", "judged", "accepted", iso(7)),
          verdicts: [
            {
              constraintCode: "C1",
              deduction: 3,
              verdict: "pass",
              decidedBy: "hard_rule",
              reasonCode: null,
              evidence: [],
              reviewItem: null,
            },
            {
              constraintCode: "C2",
              deduction: 4,
              verdict: "unsure",
              decidedBy: "fallback",
              reasonCode: "model_off",
              evidence: [],
              reviewItem: {
                id: itemId("s7-reviewed", "C2"),
                reason: "unsure",
                status: "reviewed",
                finalVerdict: "pass",
                finalEvidence: null,
                note: "Merge sort, fine.",
                reviewedBy: "u-ta-1",
                reviewedAt: iso(40),
              },
            },
          ],
        },
      ],
    });
  });

  it("keeps only the submissions with a pending item for pending=true; the summary stays whole-lab", async () => {
    const body = (await getQueue({ query: "?pending=true" })).json();
    expect(body.summary).toEqual({ submissions: 1, ...SUMMARY_COUNTS });
    expect(body.submissions).toEqual([S1()]);
  });

  it("answers pending=false like no filter", async () => {
    const all = (await getQueue()).json();
    expect((await getQueue({ query: "?pending=false" })).json()).toEqual(all);
  });

  it("shows a published lab as published", async () => {
    const body = (
      await getQueue({ labId: labB, token: tokens.ta2 ?? "" })
    ).json();
    expect(body).toMatchObject({
      labId: labB,
      labStatus: "published",
      summary: {
        submissions: 1,
        pendingReviews: 0,
        unjudgedSubmissions: 1,
        failedSubmissions: 0,
      },
    });
  });

  it("never sends the model's prompt or the source code", async () => {
    const text = (await getQueue()).body;
    for (const word of ["prompt", "sourceCode", "requestId", "modelCall"]) {
      expect(text).not.toContain(`"${word}`);
    }
  });
});

describe("401 — unauthenticated", () => {
  it("answers no token and an unknown token", async () => {
    expectProblem(await getQueue({ token: null }), "unauthenticated");
    expectProblem(await getQueue({ token: "x".repeat(43) }), "unauthenticated");
  });
});

describe("403 — role-not-allowed", () => {
  it("answers a student (no verdict before Publish, FAQ-08) and an admin", async () => {
    for (const who of ["student", "admin"]) {
      const body = expectProblem(
        await getQueue({ token: tokens[who] ?? "" }),
        "role-not-allowed",
      );
      expect(body.requiredRole).toBe("ta");
    }
  });
});

describe("400 — invalid-query", () => {
  const cases: [string, string, string][] = [
    ["a value of pending other than true or false", "?pending=yes", "pending"],
    ["an empty pending", "?pending=", "pending"],
    ["pending given twice", "?pending=true&pending=true", "pending"],
    ["an unknown parameter", "?status=pending", "status"],
  ];
  for (const [name, query, parameter] of cases) {
    it(`answers ${name}, naming the parameter`, async () => {
      const body = expectProblem(await getQueue({ query }), "invalid-query");
      expect(body.parameter).toBe(parameter);
    });
  }
});

describe("404 — lab-not-found (rubric criterion 1)", () => {
  it("answers a TA of another class like a lab that does not exist", async () => {
    const other = expectProblem(
      await getQueue({ labId: labB }),
      "lab-not-found",
      labB,
    );
    const missing = expectProblem(
      await getQueue({ labId: "lab-missing" }),
      "lab-not-found",
      "lab-missing",
    );
    expect(other.detail).toBe(missing.detail);
    expectProblem(await getQueue({ token: tokens.ta2 ?? "" }), "lab-not-found");
  });
});

describe("order of checks", () => {
  it("1. authentication before the role", async () => {
    expectProblem(
      await getQueue({ token: null, query: "?x=1" }),
      "unauthenticated",
    );
  });

  it("2. the role before the query", async () => {
    expectProblem(
      await getQueue({ token: tokens.student ?? "", query: "?x=1" }),
      "role-not-allowed",
    );
  });

  it("3. the query before the lab", async () => {
    expectProblem(
      await getQueue({ labId: "lab-missing", query: "?x=1" }),
      "invalid-query",
      "lab-missing",
    );
  });
});

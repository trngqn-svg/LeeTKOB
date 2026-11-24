// Contract tests for docs/contract/review-decision.md.
// Expected values are copied from the contract on purpose: never import them from src/.
// The review items are written by the worker queue's own finishJob, as a real run would.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { finishJob } from "../../src/db/queue.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import { createStore } from "../../src/store.ts";

const CONTRACT = {
  "payload-too-large": [413, "Request body is too large"],
  "unsupported-media-type": [415, "Unsupported media type"],
  "validation-failed": [422, "Request body is invalid"],
  unauthenticated: [401, "Authentication required"],
  "role-not-allowed": [403, "Your role may not do this"],
  "review-item-not-found": [404, "Review item not found"],
  "lab-published": [409, "The lab is already published"],
  "review-already-decided": [409, "The review item is already decided"],
} as const;

const BODY_LIMIT = 65536;
const PASSWORD = "pw-contract-test";
const T0 = new Date("2026-11-26T10:02:00.000Z");
const PUBLISHED_AT = "2026-11-26T11:00:00.000Z";
const QUEUE = { workerId: "w-test", leaseSeconds: 60, maxAttempts: 3 };
const SOURCE = [
  "#include <algorithm>",
  "int main() {",
  "  std::sort(a, a + n);",
  "  return 0;",
  "}",
].join("\n");
const LINE3 = { line: 3, text: "  std::sort(a, a + n);" };

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;
const tokens: Record<string, string> = {};
let labA = ""; // class-a, open
let labB = ""; // class-b, open
let labC = ""; // class-a, published
let decidedInC = 0; // decided before lab C was published
let pendingInC = 0;

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

let nextSubmission = 0;
/** A new accepted submission with two pending items: C1 violation and C2 unsure. */
function freshItems(labId = labA): { violation: number; unsure: number } {
  const id = `sub-${++nextSubmission}`;
  db.prepare(
    `INSERT INTO submissions (id, lab_id, student_id, source_code, status, locked_by,
                              lease_until, attempts, started_at)
     VALUES (?, ?, 'u-st-1', ?, 'running', ?, '2026-11-26T11:00:00.000Z', 1, '2026-11-26T09:00:00.000Z')`,
  ).run(id, labId, SOURCE, QUEUE.workerId);
  const done = finishJob(db, QUEUE, {
    id,
    now: new Date("2026-11-26T09:00:05.000Z"),
    outcome: {
      result: "accepted",
      tests: [{ position: 1, result: "passed", timeMs: 3 }],
    },
    results: [
      {
        constraintCode: "C1",
        verdict: "violation",
        decidedBy: "hard_rule",
        evidence: [LINE3],
        modelCall: null,
      },
      {
        constraintCode: "C2",
        verdict: "unsure",
        decidedBy: "fallback",
        reason: "model_off",
        evidence: [],
        modelCall: null,
      },
    ],
    samplePass: () => false,
  });
  expect(done).toBe(true);
  const item = (code: string) =>
    (
      db
        .prepare(
          `SELECT r.id FROM review_items r JOIN verdicts v ON v.id = r.verdict_id
             JOIN lab_constraints c ON c.id = v.constraint_id
            WHERE v.submission_id = ? AND c.code = ?`,
        )
        .get(id, code) as { id: number }
    ).id;
  return { violation: item("C1"), unsure: item("C2") };
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
  labC = await create("class-a", tokens.ta1 ?? "");

  // Lab C: one item decided as pass, one left pending, then the lab is published.
  const c = freshItems(labC);
  decidedInC = c.unsure;
  pendingInC = c.violation;
  db.prepare(
    `UPDATE review_items SET status = 'reviewed', final_verdict = 'pass',
            reviewed_by = 'u-ta-1', reviewed_at = '2026-11-26T10:30:00.000Z' WHERE id = ?`,
  ).run(decidedInC);
  db.prepare(
    "INSERT INTO publications (lab_id, published_at, published_by, marks_published) VALUES (?, ?, 'u-ta-1', 0)",
  ).run(labC, PUBLISHED_AT);
  db.prepare("UPDATE labs SET status = 'published' WHERE id = ?").run(labC);
});

afterAll(async () => {
  await app.close();
  db.close();
});

interface Call {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

function decide(
  itemId: number | string,
  {
    token = tokens.ta1 ?? "",
    body = { finalVerdict: "violation", evidence: [LINE3] },
    rawBody,
    contentType = "application/json",
  }: Call = {},
) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  // null means "send no body"; undefined would silently fall back to the default above.
  const payload = rawBody ?? (body === null ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers["content-type"] = contentType;
  return app.inject({
    method: "POST",
    url: `/review-items/${itemId}/decision`,
    headers,
    payload,
  });
}

type Res = Awaited<ReturnType<typeof decide>>;

function expectProblem(
  res: Res,
  slug: keyof typeof CONTRACT,
  itemId: number | string,
) {
  const [status, title] = CONTRACT[slug];
  expect(res.statusCode).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({
    type: `https://leetkob.example/problems/${slug}`,
    title,
    status,
    instance: `/review-items/${itemId}/decision`,
  });
  expect(typeof body.detail).toBe("string");
  return body;
}

function stored(itemId: number) {
  return {
    ...(db
      .prepare(
        `SELECT r.status, r.final_verdict, r.final_evidence, r.note, r.reviewed_by, r.reviewed_at,
                v.verdict AS pipeline_verdict
           FROM review_items r JOIN verdicts v ON v.id = r.verdict_id WHERE r.id = ?`,
      )
      .get(itemId) as Record<string, unknown>),
  };
}

const pendingIn = (labId: string) =>
  (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_items WHERE lab_id = ? AND status = 'pending'",
      )
      .get(labId) as { n: number }
  ).n;

describe("200 — the item is decided", () => {
  it("stores a violation with its evidence and note, and answers the item", async () => {
    const { violation } = freshItems();
    const before = pendingIn(labA);
    const res = await decide(violation, {
      body: {
        finalVerdict: "violation",
        evidence: [LINE3],
        note: "Calls std::sort.",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({
      reviewItem: {
        id: violation,
        submissionId: `sub-${nextSubmission}`,
        constraintCode: "C1",
        reason: "violation",
        status: "reviewed",
        finalVerdict: "violation",
        finalEvidence: [LINE3],
        note: "Calls std::sort.",
        reviewedBy: "u-ta-1",
        reviewedAt: "2026-11-26T10:02:00.000Z",
      },
      pendingReviews: before - 1,
    });
    expect(stored(violation)).toMatchObject({
      status: "reviewed",
      final_verdict: "violation",
      final_evidence: JSON.stringify([LINE3]),
      reviewed_by: "u-ta-1",
    });
  });

  it("stores a pass without evidence; the pipeline's own verdict stays as it was", async () => {
    const { violation } = freshItems();
    const res = await decide(violation, { body: { finalVerdict: "pass" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().reviewItem).toMatchObject({
      finalVerdict: "pass",
      finalEvidence: null,
      note: null,
    });
    expect(stored(violation)).toMatchObject({
      final_verdict: "pass",
      pipeline_verdict: "violation",
    });
  });

  it("accepts an empty evidence list and a null note with a pass", async () => {
    const { unsure } = freshItems();
    const res = await decide(unsure, {
      body: { finalVerdict: "pass", evidence: [], note: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reviewItem).toMatchObject({
      reason: "unsure",
      constraintCode: "C2",
      finalEvidence: null,
    });
  });

  it("accepts an evidence line whose text differs only by leading and trailing whitespace", async () => {
    const { unsure } = freshItems();
    const res = await decide(unsure, {
      body: {
        finalVerdict: "violation",
        evidence: [{ line: 3, text: "std::sort(a, a + n);   " }],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("never carries a deduction or a mark", async () => {
    const { violation } = freshItems();
    const text = (await decide(violation)).body;
    for (const word of ["deduction", "mark", "score"]) {
      expect(text).not.toContain(`"${word}`);
    }
  });
});

describe("deciding again (decided once)", () => {
  it("answers the same decision again with 200 and the stored item, and changes nothing", async () => {
    const { violation } = freshItems();
    const body = {
      finalVerdict: "violation",
      evidence: [LINE3],
      note: "Calls std::sort.",
    };
    const first = await decide(violation, { body });
    const before = stored(violation);
    const second = await decide(violation, { body });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(stored(violation)).toEqual(before);
  });

  it("refuses a different verdict with review-already-decided and the stored item", async () => {
    const { violation } = freshItems();
    await decide(violation, { body: { finalVerdict: "pass" } });
    const res = await decide(violation);
    const body = expectProblem(res, "review-already-decided", violation);
    expect(body.reviewItem).toMatchObject({
      id: violation,
      status: "reviewed",
      finalVerdict: "pass",
      finalEvidence: null,
    });
    expect(stored(violation).final_verdict).toBe("pass");
  });

  it("refuses the same verdict with a different note", async () => {
    const { unsure } = freshItems();
    await decide(unsure, { body: { finalVerdict: "pass", note: "ok" } });
    expectProblem(
      await decide(unsure, { body: { finalVerdict: "pass", note: "fine" } }),
      "review-already-decided",
      unsure,
    );
    expect(stored(unsure).note).toBe("ok");
  });
});

describe("401 — unauthenticated", () => {
  it("answers no token and an unknown token, and changes nothing", async () => {
    const { violation } = freshItems();
    expectProblem(
      await decide(violation, { token: null }),
      "unauthenticated",
      violation,
    );
    expectProblem(
      await decide(violation, { token: "x".repeat(43) }),
      "unauthenticated",
      violation,
    );
    expect(stored(violation).status).toBe("pending");
  });
});

describe("403 — role-not-allowed", () => {
  it("answers a student and an admin, naming the TA role", async () => {
    const { violation } = freshItems();
    for (const who of ["student", "admin"]) {
      const body = expectProblem(
        await decide(violation, { token: tokens[who] ?? "" }),
        "role-not-allowed",
        violation,
      );
      expect(body.requiredRole).toBe("ta");
    }
    expect(stored(violation).status).toBe("pending");
  });
});

describe("404 — review-item-not-found", () => {
  it("answers a TA of another class like an item that does not exist", async () => {
    const { violation } = freshItems();
    const other = expectProblem(
      await decide(violation, { token: tokens.ta2 ?? "" }),
      "review-item-not-found",
      violation,
    );
    const missing = expectProblem(
      await decide(999999),
      "review-item-not-found",
      999999,
    );
    expect(other.detail).toBe(missing.detail);
    expect(stored(violation).status).toBe("pending");
  });

  it("answers the TA of lab B for lab B's item, and TA One gets 404 for it", async () => {
    const { violation } = freshItems(labB);
    expectProblem(await decide(violation), "review-item-not-found", violation);
    expect(
      (await decide(violation, { token: tokens.ta2 ?? "" })).statusCode,
    ).toBe(200);
  });

  for (const id of ["abc", "0", "-1", "1.5", "1e2"]) {
    it(`answers an id that is not a positive integer: ${id}`, async () => {
      expectProblem(await decide(id), "review-item-not-found", id);
    });
  }
});

describe("413 — payload-too-large", () => {
  it("answers a body over 64 KiB, with the limit", async () => {
    const { violation } = freshItems();
    const body = expectProblem(
      await decide(violation, { rawBody: `"${"x".repeat(BODY_LIMIT)}"` }),
      "payload-too-large",
      violation,
    );
    expect(body.limitBytes).toBe(BODY_LIMIT);
  });
});

describe("415 — unsupported-media-type", () => {
  it("answers a body that is not application/json", async () => {
    const { violation } = freshItems();
    expectProblem(
      await decide(violation, {
        rawBody: "finalVerdict=pass",
        contentType: "text/plain",
      }),
      "unsupported-media-type",
      violation,
    );
  });
});

describe("422 — validation-failed", () => {
  const cases: [string, Call, string][] = [
    ["no body", { body: null }, ""],
    ["a body that is not JSON", { rawBody: "{not json" }, ""],
    ["a body that is not an object", { body: ["pass"] }, ""],
    ["a missing finalVerdict", { body: {} }, "/finalVerdict"],
    [
      "unsure as the final verdict (FAQ-09)",
      { body: { finalVerdict: "unsure" } },
      "/finalVerdict",
    ],
    [
      "a deduction field: the TA does not set it here (FAQ-11)",
      { body: { finalVerdict: "pass", deduction: 0 } },
      "/deduction",
    ],
    [
      "a violation without evidence",
      { body: { finalVerdict: "violation" } },
      "/evidence",
    ],
    [
      "a violation with an empty evidence list",
      { body: { finalVerdict: "violation", evidence: [] } },
      "/evidence",
    ],
    [
      "a pass with evidence",
      { body: { finalVerdict: "pass", evidence: [LINE3] } },
      "/evidence",
    ],
    [
      "more than 20 evidence lines",
      {
        body: {
          finalVerdict: "violation",
          evidence: Array.from({ length: 21 }, () => LINE3),
        },
      },
      "/evidence",
    ],
    [
      "a line number below 1",
      {
        body: {
          finalVerdict: "violation",
          evidence: [{ line: 0, text: "x" }],
        },
      },
      "/evidence/0/line",
    ],
    [
      "a line number that is not an integer",
      {
        body: {
          finalVerdict: "violation",
          evidence: [{ line: 2.5, text: "int main() {" }],
        },
      },
      "/evidence/0/line",
    ],
    [
      "a line text that is not a string",
      {
        body: { finalVerdict: "violation", evidence: [{ line: 3, text: 3 }] },
      },
      "/evidence/0/text",
    ],
    [
      "an unknown field in an evidence line",
      {
        body: {
          finalVerdict: "violation",
          evidence: [{ ...LINE3, column: 2 }],
        },
      },
      "/evidence/0/column",
    ],
    [
      "a line that is not in the source",
      {
        body: {
          finalVerdict: "violation",
          evidence: [{ line: 99, text: "std::sort(a, a + n);" }],
        },
      },
      "/evidence/0/line",
    ],
    [
      "a line whose text differs from the source",
      {
        body: {
          finalVerdict: "violation",
          evidence: [{ line: 3, text: "std::stable_sort(a, a + n);" }],
        },
      },
      "/evidence/0/text",
    ],
    [
      "a note longer than 1000 characters",
      { body: { finalVerdict: "pass", note: "n".repeat(1001) } },
      "/note",
    ],
    [
      "a note that is not a string",
      { body: { finalVerdict: "pass", note: 5 } },
      "/note",
    ],
  ];
  for (const [name, call, pointer] of cases) {
    it(`answers ${name}, pointing at the field`, async () => {
      const { violation } = freshItems();
      const body = expectProblem(
        await decide(violation, call),
        "validation-failed",
        violation,
      );
      expect(body.errors).toEqual(
        expect.arrayContaining([{ pointer, message: expect.any(String) }]),
      );
      expect(stored(violation).status).toBe("pending");
    });
  }

  it("accepts a note of exactly 1000 characters", async () => {
    const { unsure } = freshItems();
    const res = await decide(unsure, {
      body: { finalVerdict: "pass", note: "n".repeat(1000) },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("409 — lab-published", () => {
  it("answers an item of a published lab, with the time it was published", async () => {
    const body = expectProblem(
      await decide(pendingInC),
      "lab-published",
      pendingInC,
    );
    expect(body.publishedAt).toBe(PUBLISHED_AT);
    expect(stored(pendingInC).status).toBe("pending");
  });
});

describe("order of checks", () => {
  it("1. the body size before everything, even without a token", async () => {
    expectProblem(
      await decide(999999, {
        token: null,
        rawBody: `"${"x".repeat(BODY_LIMIT)}"`,
      }),
      "payload-too-large",
      999999,
    );
  });

  it("2. the media type and the JSON syntax before authentication", async () => {
    expectProblem(
      await decide(999999, {
        token: null,
        rawBody: "x",
        contentType: "text/plain",
      }),
      "unsupported-media-type",
      999999,
    );
    expectProblem(
      await decide(999999, { token: null, rawBody: "{not json" }),
      "validation-failed",
      999999,
    );
  });

  it("3. authentication before the role", async () => {
    expectProblem(
      await decide(999999, { token: null }),
      "unauthenticated",
      999999,
    );
  });

  it("4. the role before the item", async () => {
    expectProblem(
      await decide(999999, { token: tokens.student ?? "" }),
      "role-not-allowed",
      999999,
    );
  });

  it("5. the item before the body rules", async () => {
    const { violation } = freshItems();
    expectProblem(
      await decide(violation, {
        token: tokens.ta2 ?? "",
        body: { finalVerdict: "unsure" },
      }),
      "review-item-not-found",
      violation,
    );
  });

  it("6. the body rules before the published lab", async () => {
    expectProblem(
      await decide(pendingInC, { body: { finalVerdict: "unsure" } }),
      "validation-failed",
      pendingInC,
    );
  });

  it("7. the published lab before an earlier decision", async () => {
    expectProblem(
      await decide(decidedInC, {
        body: { finalVerdict: "violation", evidence: [LINE3] },
      }),
      "lab-published",
      decidedInC,
    );
    expectProblem(
      await decide(decidedInC, { body: { finalVerdict: "pass" } }),
      "lab-published",
      decidedInC,
    );
  });
});

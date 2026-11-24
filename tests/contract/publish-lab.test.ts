// Contract tests for docs/contract/publish-lab.md.
// Expected values are copied from the contract on purpose: never import them from src/.
// PA#3 (T8): the lab, the review items and the submissions come from the database, and the
// callers log in. Every case of the PA#2 file is kept; the rules added to the contract on
// 2026-11-24 (submissions still being judged, failed ones, the deadline) are new cases.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { finishJob } from "../../src/db/queue.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import { hashPassword } from "../../src/password.ts";
import { createStore } from "../../src/store.ts";

const CONTRACT = {
  "unsupported-media-type": [415, "Unsupported media type"],
  "validation-failed": [422, "Request body is invalid"],
  unauthenticated: [401, "Authentication required"],
  "forbidden-role": [403, "Only TAs may publish marks"],
  "lab-not-found": [404, "Lab not found"],
  "invalid-idempotency-key": [400, "Idempotency-Key is missing or invalid"],
  "idempotency-key-reused": [
    422,
    "Idempotency-Key reused with a different body",
  ],
  "deadline-not-passed": [409, "The deadline has not passed yet"],
  "reviews-pending": [409, "Reviews are still pending"],
  internal: [500, "Internal server error"],
} as const;

const PASSWORD = "pw-contract-test";
const T0 = new Date("2026-11-10T14:03:00.000Z");
const QUEUE = { workerId: "w-test", leaseSeconds: 60, maxAttempts: 3 };

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;
let clock: Date;
let clockBroken = false;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  db = openDatabase(":memory:");
  migrate(db);
  seedAccounts(db, PASSWORD);
  // A second TA of class-a: any TA of the class may publish, not only its creator.
  db.prepare(
    "INSERT INTO users (id, email, display_name, role, password_hash) VALUES ('u-ta-3', 'ta3@leetkob.example', 'TA Three', 'ta', ?)",
  ).run(hashPassword(PASSWORD));
  db.prepare(
    "INSERT INTO class_members (class_id, user_id) VALUES ('class-a', 'u-ta-3')",
  ).run();
  clock = T0;
  app = buildApp(
    createStore({
      users: [],
      labs: [],
      now: () => {
        if (clockBroken) throw new Error("clock down");
        return clock;
      },
    }),
    db,
  );
  for (const [who, email] of [
    ["ta1", "ta1@leetkob.example"],
    ["ta3", "ta3@leetkob.example"],
    ["taOther", "ta2@leetkob.example"],
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

beforeEach(() => {
  clock = T0;
  clockBroken = false;
});

afterAll(async () => {
  await app.close();
  db.close();
});

/** A new lab of class-a (or another class), so every test starts from its own lab. */
async function newLab({
  classId = "class-a",
  token = tokens.ta1 ?? "",
  deadline = null as string | null,
} = {}): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/classes/${classId}/labs`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: "Merge sort",
      statementMd: "# Sort",
      deadline,
      tests: [{ input: "1\n7\n", expectedOutput: "7\n" }],
      constraints: [{ text: "Write a merge sort yourself.", deduction: 4 }],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

let nextSubmission = 0;
function addSubmission(
  labId: string,
  status: "queued" | "running" | "failed",
): string {
  const id = `sub-${++nextSubmission}`;
  db.prepare(
    `INSERT INTO submissions (id, lab_id, student_id, source_code, status, locked_by, lease_until, attempts)
     VALUES (?, ?, 'u-st-1', 'int main() {}', ?, ?, ?, ?)`,
  ).run(
    id,
    labId,
    status,
    status === "running" ? "w-other" : null,
    status === "running" ? "2026-11-10T15:00:00.000Z" : null,
    status === "failed" ? 3 : status === "running" ? 1 : 0,
  );
  return id;
}

/**
 * A judged submission, finished by the worker queue's own finishJob. "pending" leaves one
 * pending review item (an unsure verdict); "clean" leaves none.
 */
function addJudged(labId: string, kind: "pending" | "clean"): number | null {
  const id = addSubmission(labId, "queued");
  db.prepare(
    "UPDATE submissions SET status = 'running', locked_by = ?, lease_until = '2026-11-10T15:00:00.000Z', attempts = 1 WHERE id = ?",
  ).run(QUEUE.workerId, id);
  const done = finishJob(db, QUEUE, {
    id,
    now: T0,
    outcome: {
      result: "accepted",
      tests: [{ position: 1, result: "passed", timeMs: 3 }],
    },
    results: [
      kind === "pending"
        ? {
            constraintCode: "C1",
            verdict: "unsure",
            decidedBy: "fallback",
            reason: "model_off",
            evidence: [],
            modelCall: null,
          }
        : {
            constraintCode: "C1",
            verdict: "pass",
            decidedBy: "model",
            evidence: [],
            modelCall: null,
          },
    ],
    samplePass: () => false,
  });
  expect(done).toBe(true);
  if (kind === "clean") return null;
  return (
    db
      .prepare(
        "SELECT r.id FROM review_items r JOIN verdicts v ON v.id = r.verdict_id WHERE v.submission_id = ?",
      )
      .get(id) as { id: number }
  ).id;
}

/** A TA decides the item, as POST /review-items/{id}/decision would. */
function decideItem(itemId: number) {
  db.prepare(
    "UPDATE review_items SET status = 'reviewed', final_verdict = 'pass', reviewed_by = 'u-ta-1', reviewed_at = ? WHERE id = ?",
  ).run(T0.toISOString(), itemId);
}

interface Call {
  token?: string | null;
  key?: string | null;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

function publish(
  labId: string,
  {
    token = tokens.ta1 ?? "",
    key = "key-1",
    body = { confirm: true },
    rawBody,
    contentType = "application/json",
  }: Call = {},
) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (key !== null) headers["idempotency-key"] = key;
  // null means "send no body"; undefined would silently fall back to the default above.
  const payload = rawBody ?? (body === null ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers["content-type"] = contentType;
  return app.inject({
    method: "POST",
    url: `/labs/${labId}/publish`,
    headers,
    payload,
  });
}

type Res = Awaited<ReturnType<typeof publish>>;

function expectProblem(res: Res, slug: keyof typeof CONTRACT, labId: string) {
  const [status, title] = CONTRACT[slug];
  expect(res.statusCode).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({
    type: `https://leetkob.example/problems/${slug}`,
    title,
    status,
    instance: `/labs/${labId}/publish`,
  });
  expect(typeof body.detail).toBe("string");
  return body;
}

function published(labId: string) {
  const row = db
    .prepare(
      "SELECT published_at, published_by, marks_published, note FROM publications WHERE lab_id = ?",
    )
    .get(labId);
  return row ? { ...row } : null;
}

const labStatus = (labId: string) =>
  (
    db.prepare("SELECT status FROM labs WHERE id = ?").get(labId) as {
      status: string;
    }
  ).status;

describe("201 — first publish", () => {
  it("returns the publication with every field the contract names", async () => {
    const lab = await newLab();
    addJudged(lab, "clean");
    addJudged(lab, "clean");
    const res = await publish(lab, {
      body: { confirm: true, note: "Sorting lab" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(res.json()).toEqual({
      labId: lab,
      status: "published",
      publishedAt: "2026-11-10T14:03:00.000Z",
      publishedBy: "u-ta-1",
      marksPublished: 2,
      note: "Sorting lab",
    });
  });

  it("makes the lab published (side effect) and note defaults to null", async () => {
    const lab = await newLab();
    const res = await publish(lab);
    expect(res.json().note).toBeNull();
    expect(published(lab)).not.toBeNull();
    expect(labStatus(lab)).toBe("published");
  });

  it("lets any TA of the class publish, not only its creator", async () => {
    const lab = await newLab();
    const res = await publish(lab, { token: tokens.ta3 ?? "" });
    expect(res.statusCode).toBe(201);
    expect(res.json().publishedBy).toBe("u-ta-3");
  });

  it("closes the lab: a submission afterwards is refused", async () => {
    const lab = await newLab();
    await publish(lab);
    const res = await app.inject({
      method: "POST",
      url: `/labs/${lab}/submissions`,
      headers: { authorization: `Bearer ${tokens.student}` },
      payload: { sourceCode: "int main() {}" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("idempotency", () => {
  it("same key + same body replays the stored response, no second side effect", async () => {
    const lab = await newLab();
    const first = await publish(lab, { body: { confirm: true, note: "n" } });
    clock = new Date("2026-11-10T15:00:00.000Z");
    const again = await publish(lab, { body: { confirm: true, note: "n" } });
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(published(lab)?.published_at).toBe(T0.toISOString());
  });

  it("same key + different body → idempotency-key-reused, nothing changes", async () => {
    const lab = await newLab();
    await publish(lab, { body: { confirm: true, note: "first" } });
    const res = await publish(lab, { body: { confirm: true, note: "second" } });
    expectProblem(res, "idempotency-key-reused", lab);
    expect(published(lab)?.note).toBe("first");
  });

  it("new key on a published lab → 200 with the existing publication", async () => {
    const lab = await newLab();
    const first = await publish(lab, {
      body: { confirm: true, note: "first" },
    });
    clock = new Date("2026-11-11T09:00:00.000Z");
    const res = await publish(lab, {
      token: tokens.ta3 ?? "",
      key: "key-2",
      body: { confirm: true, note: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(res.json()).toEqual(first.json());
  });

  it("errors are not stored: the same key works once the cause is fixed", async () => {
    const lab = await newLab();
    const item = addJudged(lab, "pending");
    expectProblem(await publish(lab), "reviews-pending", lab);
    decideItem(item!);
    const res = await publish(lab);
    expect(res.statusCode).toBe(201);
  });

  it("keys are scoped per caller: another TA's identical key is not a replay", async () => {
    const lab = await newLab();
    await publish(lab, { key: "shared" });
    const res = await publish(lab, { token: tokens.ta3 ?? "", key: "shared" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("two concurrent publishes create exactly one publication", async () => {
    const lab = await newLab();
    const [a, b] = await Promise.all([
      publish(lab, { key: "k-a" }),
      publish(lab, { token: tokens.ta3 ?? "", key: "k-b" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json()).toEqual(b.json());
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM publications WHERE lab_id = ?")
          .get(lab) as { n: number }
      ).n,
    ).toBe(1);
  });
});

describe("who may call it", () => {
  it("no Authorization header → unauthenticated", async () => {
    const lab = await newLab();
    expectProblem(await publish(lab, { token: null }), "unauthenticated", lab);
  });

  it("unknown token → unauthenticated", async () => {
    const lab = await newLab();
    expectProblem(
      await publish(lab, { token: "x".repeat(43) }),
      "unauthenticated",
      lab,
    );
  });

  it("student → forbidden-role, lab not published", async () => {
    const lab = await newLab();
    expectProblem(
      await publish(lab, { token: tokens.student ?? "" }),
      "forbidden-role",
      lab,
    );
    expect(published(lab)).toBeNull();
  });

  it("admin → forbidden-role", async () => {
    const lab = await newLab();
    expectProblem(
      await publish(lab, { token: tokens.admin ?? "" }),
      "forbidden-role",
      lab,
    );
  });

  it("unknown lab → lab-not-found", async () => {
    expectProblem(await publish("lab-missing"), "lab-not-found", "lab-missing");
  });

  it("ownership: TA of another class → lab-not-found, same body as a missing lab", async () => {
    const lab = await newLab();
    const foreign = expectProblem(
      await publish(lab, { token: tokens.taOther ?? "" }),
      "lab-not-found",
      lab,
    );
    const missing = expectProblem(
      await publish("lab-missing", { token: tokens.taOther ?? "" }),
      "lab-not-found",
      "lab-missing",
    );
    expect({ ...foreign, instance: null }).toEqual({
      ...missing,
      instance: null,
    });
    expect(published(lab)).toBeNull();
  });
});

describe("Idempotency-Key header", () => {
  it.each([
    ["missing", null],
    ["empty", ""],
    ["bad characters", "key with spaces"],
    ["too long", "k".repeat(65)],
  ])("%s → invalid-idempotency-key", async (_name, key) => {
    const lab = await newLab();
    expectProblem(await publish(lab, { key }), "invalid-idempotency-key", lab);
    expect(published(lab)).toBeNull();
  });

  it("64 characters is accepted", async () => {
    const lab = await newLab();
    expect((await publish(lab, { key: "k".repeat(64) })).statusCode).toBe(201);
  });
});

describe("body rules → validation-failed", () => {
  it.each([
    ["confirm missing", {}, "/confirm"],
    ["confirm false", { confirm: false }, "/confirm"],
    ["confirm not boolean", { confirm: "true" }, "/confirm"],
    ["note too long", { confirm: true, note: "x".repeat(501) }, "/note"],
    ["note not a string", { confirm: true, note: 5 }, "/note"],
    ["unknown field", { confirm: true, marks: 10 }, "/marks"],
    ["array body", [true], ""],
  ])("%s", async (_name, body, pointer) => {
    const lab = await newLab();
    const problem = expectProblem(
      await publish(lab, { body }),
      "validation-failed",
      lab,
    );
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer, message: expect.any(String) }),
      ]),
    );
    expect(published(lab)).toBeNull();
  });

  it("note of exactly 500 characters is accepted", async () => {
    const lab = await newLab();
    expect(
      (await publish(lab, { body: { confirm: true, note: "x".repeat(500) } }))
        .statusCode,
    ).toBe(201);
  });

  it("no body → validation-failed", async () => {
    const lab = await newLab();
    expectProblem(await publish(lab, { body: null }), "validation-failed", lab);
  });

  it("invalid JSON → validation-failed", async () => {
    const lab = await newLab();
    const problem = expectProblem(
      await publish(lab, { rawBody: "{confirm:" }),
      "validation-failed",
      lab,
    );
    expect(problem.errors).toHaveLength(1);
  });

  it("non-JSON content type → unsupported-media-type", async () => {
    const lab = await newLab();
    expectProblem(
      await publish(lab, { rawBody: "confirm", contentType: "text/plain" }),
      "unsupported-media-type",
      lab,
    );
  });
});

describe("reviews-pending", () => {
  it("refuses a pending review item, with the three numbers and their sum", async () => {
    const lab = await newLab();
    addJudged(lab, "pending");
    addJudged(lab, "pending");
    addJudged(lab, "clean");
    const problem = expectProblem(await publish(lab), "reviews-pending", lab);
    expect(problem).toMatchObject({
      pendingCount: 2,
      pendingReviews: 2,
      unjudgedSubmissions: 0,
      failedSubmissions: 0,
    });
    expect(published(lab)).toBeNull();
    expect(labStatus(lab)).toBe("open");
  });

  it("refuses a submission still queued or running, which has no review item yet", async () => {
    const lab = await newLab();
    addSubmission(lab, "queued");
    addSubmission(lab, "running");
    const problem = expectProblem(await publish(lab), "reviews-pending", lab);
    expect(problem).toMatchObject({
      pendingCount: 2,
      pendingReviews: 0,
      unjudgedSubmissions: 2,
      failedSubmissions: 0,
    });
    expect(published(lab)).toBeNull();
  });

  it("refuses a submission whose judging failed", async () => {
    const lab = await newLab();
    addSubmission(lab, "failed");
    const problem = expectProblem(await publish(lab), "reviews-pending", lab);
    expect(problem).toMatchObject({
      pendingCount: 1,
      pendingReviews: 0,
      unjudgedSubmissions: 0,
      failedSubmissions: 1,
    });
  });

  it("counts every cause together", async () => {
    const lab = await newLab();
    addJudged(lab, "pending");
    addSubmission(lab, "queued");
    addSubmission(lab, "failed");
    const problem = expectProblem(await publish(lab), "reviews-pending", lab);
    expect(problem).toMatchObject({
      pendingCount: 3,
      pendingReviews: 1,
      unjudgedSubmissions: 1,
      failedSubmissions: 1,
    });
  });

  it("does not count other labs", async () => {
    const lab = await newLab();
    const other = await newLab();
    addJudged(other, "pending");
    addSubmission(other, "queued");
    expect((await publish(lab)).statusCode).toBe(201);
  });
});

describe("deadline-not-passed (FAQ-12)", () => {
  it("refuses before the deadline, with the deadline, and publishes nothing", async () => {
    const lab = await newLab({ deadline: "2026-11-10T16:00:00.000Z" });
    const problem = expectProblem(
      await publish(lab),
      "deadline-not-passed",
      lab,
    );
    expect(problem.deadline).toBe("2026-11-10T16:00:00.000Z");
    expect(published(lab)).toBeNull();
  });

  it("publishes once the deadline has passed, with the same key", async () => {
    const lab = await newLab({ deadline: "2026-11-10T16:00:00.000Z" });
    await publish(lab);
    clock = new Date("2026-11-10T16:00:01.000Z");
    expect((await publish(lab)).statusCode).toBe(201);
  });
});

describe("internal", () => {
  it("unexpected failure → internal problem, nothing published", async () => {
    const lab = await newLab();
    clockBroken = true;
    expectProblem(await publish(lab), "internal", lab);
    clockBroken = false;
    expect(published(lab)).toBeNull();
  });
});

describe("order of checks", () => {
  it("unauthenticated beats every later check", async () => {
    const lab = await newLab();
    expectProblem(
      await publish(lab, { token: null, key: null, body: {} }),
      "unauthenticated",
      lab,
    );
  });

  it("forbidden-role beats lab-not-found", async () => {
    const foreign = await newLab({
      classId: "class-b",
      token: tokens.taOther ?? "",
    });
    expectProblem(
      await publish(foreign, { token: tokens.student ?? "" }),
      "forbidden-role",
      foreign,
    );
  });

  it("lab-not-found beats invalid-idempotency-key", async () => {
    const lab = await newLab();
    expectProblem(
      await publish(lab, { token: tokens.taOther ?? "", key: null }),
      "lab-not-found",
      lab,
    );
  });

  it("invalid-idempotency-key beats validation-failed", async () => {
    const lab = await newLab();
    expectProblem(
      await publish(lab, { key: null, body: {} }),
      "invalid-idempotency-key",
      lab,
    );
  });

  it("validation-failed beats reviews-pending", async () => {
    const lab = await newLab();
    addJudged(lab, "pending");
    expectProblem(await publish(lab, { body: {} }), "validation-failed", lab);
  });

  it("already published beats reviews-pending", async () => {
    const lab = await newLab();
    await publish(lab);
    addSubmission(lab, "queued");
    expect((await publish(lab, { key: "key-2" })).statusCode).toBe(200);
  });

  it("already published beats deadline-not-passed", async () => {
    const lab = await newLab({ deadline: "2026-11-10T16:00:00.000Z" });
    clock = new Date("2026-11-10T16:00:01.000Z");
    await publish(lab);
    clock = T0; // a clock behind the deadline again
    expect((await publish(lab, { key: "key-2" })).statusCode).toBe(200);
  });

  it("deadline-not-passed beats reviews-pending", async () => {
    const lab = await newLab({ deadline: "2026-11-10T16:00:00.000Z" });
    addJudged(lab, "pending");
    expectProblem(await publish(lab), "deadline-not-passed", lab);
  });
});

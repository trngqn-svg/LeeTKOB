// The worker queue: the statements of docs/ARCHITECTURE.md, section 4.1, and the crash
// cases of section 4.2. Times are passed in, so every lease is exact.
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
  claimNext,
  finishJob,
  heartbeat,
  putBack,
  release,
  type QueueOptions,
} from "../../src/db/queue.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import type {
  ConstraintResult,
  ModelCallRecord,
  SandboxOutcome,
} from "../../src/judge/types.ts";

const W1: QueueOptions = { workerId: "w1", leaseSeconds: 60, maxAttempts: 3 };
const W2: QueueOptions = { ...W1, workerId: "w2" };
const T0 = new Date("2026-11-26T09:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const iso = (seconds: number) => at(seconds).toISOString();
const LAB = "lab-q";

const PASSED_TESTS = [
  { position: 1, result: "passed" as const, timeMs: 4 },
  { position: 2, result: "passed" as const, timeMs: 5 },
];
const ACCEPTED: SandboxOutcome = { result: "accepted", tests: PASSED_TESTS };
const EVIDENCE = [{ line: 3, text: "  std::sort(a.begin(), a.end());" }];
const CALL: ModelCallRecord = {
  provider: "fake",
  model: "fake-1",
  requestId: "req-1",
  prompt: "the prompt",
  promptTokens: 100,
  completionTokens: 20,
  latencyMs: 300,
  costUsd: 0.0001,
  outcome: "ok",
};

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  seedAccounts(db, "pw-queue-test");
  db.prepare(
    "INSERT INTO labs (id, class_id, title, statement_md, created_by) VALUES (?, 'class-a', 'Sort', '# Sort', 'u-ta-1')",
  ).run(LAB);
  const constraint = db.prepare(
    "INSERT INTO lab_constraints (lab_id, code, text, kind, banned_names, deduction) VALUES (?, ?, ?, ?, ?, ?)",
  );
  constraint.run(
    LAB,
    "C1",
    "Do not call `std::sort`.",
    "ban_list",
    '["std::sort"]',
    3,
  );
  constraint.run(LAB, "C2", "Write a merge sort.", "semantic", "[]", 4);
  constraint.run(LAB, "C3", "Use recursion.", "semantic", "[]", 2);
});

function submit(id: string, createdAt: string) {
  db.prepare(
    "INSERT INTO submissions (id, lab_id, student_id, source_code, created_at) VALUES (?, ?, 'u-st-1', ?, ?)",
  ).run(id, LAB, `// ${id}\nint main() {}\n`, createdAt);
}

function row(id: string) {
  return {
    ...(db
      .prepare(
        "SELECT status, judge_result, judge_detail, attempts, locked_by, lease_until, started_at, finished_at FROM submissions WHERE id = ?",
      )
      .get(id) as Record<string, unknown>),
  };
}

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function verdictsOf(id: string) {
  return db
    .prepare(
      `SELECT c.code, v.verdict, v.decided_by, v.reason_code, v.evidence, v.model_call_id, r.reason AS item
         FROM verdicts v JOIN lab_constraints c ON c.id = v.constraint_id
         LEFT JOIN review_items r ON r.verdict_id = v.id
        WHERE v.submission_id = ? ORDER BY c.code`,
    )
    .all(id)
    .map((r) => ({ ...r }));
}

const RESULTS: ConstraintResult[] = [
  {
    constraintCode: "C1",
    verdict: "violation",
    decidedBy: "hard_rule",
    evidence: [EVIDENCE[0]!],
    modelCall: null,
  },
  {
    constraintCode: "C2",
    verdict: "pass",
    decidedBy: "model",
    evidence: [],
    modelCall: CALL,
  },
  {
    constraintCode: "C3",
    verdict: "unsure",
    decidedBy: "fallback",
    reason: "model_off",
    evidence: [],
    modelCall: null,
  },
];

const never = () => false;

describe("claimNext", () => {
  it("takes the oldest queued submission and starts a lease", () => {
    submit("s-new", iso(-10));
    submit("s-old", iso(-20));
    expect(claimNext(db, W1, T0)).toEqual({
      id: "s-old",
      labId: LAB,
      sourceCode: "// s-old\nint main() {}\n",
    });
    expect(row("s-old")).toMatchObject({
      status: "running",
      attempts: 1,
      locked_by: "w1",
      lease_until: iso(60),
      started_at: iso(0),
      finished_at: null,
    });
    expect(row("s-new").status).toBe("queued");
  });

  it("answers null when nothing is queued", () => {
    expect(claimNext(db, W1, T0)).toBeNull();
  });

  it("never gives the same submission to two workers", () => {
    submit("s1", iso(-20));
    submit("s2", iso(-10));
    expect(claimNext(db, W1, T0)?.id).toBe("s1");
    expect(claimNext(db, W2, T0)?.id).toBe("s2");
    expect(claimNext(db, W1, T0)).toBeNull();
  });

  it("leaves a lease that has not run out alone", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0);
    expect(claimNext(db, W2, at(59))).toBeNull();
    expect(row("s1").locked_by).toBe("w1");
  });

  it("takes back a job whose lease ran out in the same step, keeping its first start", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0); // w1 dies here
    expect(claimNext(db, W2, at(61))?.id).toBe("s1");
    expect(row("s1")).toMatchObject({
      status: "running",
      attempts: 2,
      locked_by: "w2",
      lease_until: iso(121),
      started_at: iso(0),
    });
  });

  it("fails a job whose lease ran out MAX_ATTEMPTS times, and does not claim it", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, at(0));
    claimNext(db, W1, at(61));
    claimNext(db, W1, at(122)); // attempt 3
    expect(claimNext(db, W2, at(183))).toBeNull();
    expect(row("s1")).toMatchObject({
      status: "failed",
      attempts: 3,
      locked_by: null,
      lease_until: null,
      finished_at: iso(183),
      judge_result: null,
    });
  });
});

describe("heartbeat", () => {
  it("moves the lease forward for the worker that holds it", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0);
    expect(heartbeat(db, W1, "s1", at(30))).toBe(true);
    expect(row("s1").lease_until).toBe(iso(90));
  });

  it("answers false to another worker and changes nothing", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0);
    expect(heartbeat(db, W2, "s1", at(30))).toBe(false);
    expect(row("s1").lease_until).toBe(iso(60));
  });

  it("answers false to a worker that lost the job", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0);
    claimNext(db, W2, at(61));
    expect(heartbeat(db, W1, "s1", at(62))).toBe(false);
    expect(row("s1").locked_by).toBe("w2");
  });
});

describe("release", () => {
  it("puts the job back at once while attempts are left", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0);
    expect(release(db, W1, "s1", at(5))).toBe(true);
    expect(row("s1")).toMatchObject({
      status: "queued",
      attempts: 1,
      locked_by: null,
      lease_until: null,
      finished_at: null,
    });
    expect(claimNext(db, W2, at(6))?.id).toBe("s1");
  });

  it("fails the job on the last attempt", () => {
    submit("s1", iso(-20));
    for (let i = 0; i < 3; i++) {
      claimNext(db, W1, at(i));
      if (i < 2) release(db, W1, "s1", at(i));
    }
    expect(release(db, W1, "s1", at(10))).toBe(true);
    expect(row("s1")).toMatchObject({
      status: "failed",
      attempts: 3,
      locked_by: null,
      finished_at: iso(10),
    });
  });

  it("answers false to a worker that does not hold the job", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0);
    expect(release(db, W2, "s1", at(5))).toBe(false);
    expect(row("s1")).toMatchObject({ status: "running", locked_by: "w1" });
  });
});

describe("putBack (the sandbox was unavailable)", () => {
  it("puts the job back at once without counting the attempt", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0);
    expect(putBack(db, W1, "s1")).toBe(true);
    expect(row("s1")).toMatchObject({
      status: "queued",
      attempts: 0,
      locked_by: null,
      lease_until: null,
      started_at: iso(0),
      finished_at: null,
    });
    expect(claimNext(db, W2, at(6))?.id).toBe("s1");
  });

  it("never fails the job, however many times the sandbox is unavailable", () => {
    submit("s1", iso(-20));
    for (let i = 0; i < 10; i++) {
      expect(claimNext(db, W1, at(i))?.id).toBe("s1");
      expect(putBack(db, W1, "s1")).toBe(true);
    }
    expect(row("s1")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("answers false to a worker that does not hold the job", () => {
    submit("s1", iso(-20));
    claimNext(db, W1, T0);
    expect(putBack(db, W2, "s1")).toBe(false);
    expect(row("s1")).toMatchObject({
      status: "running",
      locked_by: "w1",
      attempts: 1,
    });
  });
});

describe("finishJob", () => {
  function claimed(id = "s1") {
    submit(id, iso(-20));
    claimNext(db, W1, T0);
  }

  it("stores an accepted result, one verdict per constraint and the review items", () => {
    claimed();
    const done = finishJob(db, W1, {
      id: "s1",
      now: at(5),
      outcome: ACCEPTED,
      results: RESULTS,
      samplePass: never,
    });
    expect(done).toBe(true);
    expect(row("s1")).toMatchObject({
      status: "judged",
      judge_result: "accepted",
      locked_by: null,
      lease_until: null,
      finished_at: iso(5),
    });
    expect(JSON.parse(row("s1").judge_detail as string)).toEqual({
      tests: PASSED_TESTS,
    });
    const callId = (
      db.prepare("SELECT id FROM model_calls").get() as { id: number }
    ).id;
    expect(verdictsOf("s1")).toEqual([
      {
        code: "C1",
        verdict: "violation",
        decided_by: "hard_rule",
        reason_code: null,
        evidence: JSON.stringify(EVIDENCE),
        model_call_id: null,
        item: "violation",
      },
      {
        code: "C2",
        verdict: "pass",
        decided_by: "model",
        reason_code: null,
        evidence: "[]",
        model_call_id: callId,
        item: null,
      },
      {
        code: "C3",
        verdict: "unsure",
        decided_by: "fallback",
        reason_code: "model_off",
        evidence: "[]",
        model_call_id: null,
        item: "unsure",
      },
    ]);
  });

  it("stores the model call of a verdict, with what it cost", () => {
    claimed();
    finishJob(db, W1, {
      id: "s1",
      now: at(5),
      outcome: ACCEPTED,
      results: RESULTS,
      samplePass: never,
    });
    const call = db
      .prepare(
        `SELECT m.submission_id, c.code, m.provider, m.model, m.request_id, m.prompt,
                m.prompt_tokens, m.completion_tokens, m.latency_ms, m.cost_usd, m.outcome
           FROM model_calls m JOIN lab_constraints c ON c.id = m.constraint_id`,
      )
      .get();
    expect({ ...call }).toEqual({
      submission_id: "s1",
      code: "C2",
      provider: "fake",
      model: "fake-1",
      request_id: "req-1",
      prompt: "the prompt",
      prompt_tokens: 100,
      completion_tokens: 20,
      latency_ms: 300,
      cost_usd: 0.0001,
      outcome: "ok",
    });
  });

  it("gives a drawn pass a review item with the reason sample", () => {
    claimed();
    finishJob(db, W1, {
      id: "s1",
      now: at(5),
      outcome: ACCEPTED,
      results: RESULTS,
      samplePass: () => true,
    });
    expect(verdictsOf("s1").find((v) => v.code === "C2")?.item).toBe("sample");
    expect(count("review_items")).toBe(3);
  });

  it("stores a compile error with the compiler's message and no verdict", () => {
    claimed();
    finishJob(db, W1, {
      id: "s1",
      now: at(5),
      outcome: {
        result: "compile_error",
        compilerMessage: "main.cpp:1: error",
      },
      results: [],
      samplePass: never,
    });
    expect(row("s1")).toMatchObject({
      status: "judged",
      judge_result: "compile_error",
    });
    expect(JSON.parse(row("s1").judge_detail as string)).toEqual({
      compilerMessage: "main.cpp:1: error",
    });
    expect(count("verdicts")).toBe(0);
  });

  it("stores a wrong answer with the tests up to the one that failed and no verdict", () => {
    claimed();
    const tests = [
      { position: 1, result: "passed" as const, timeMs: 4 },
      { position: 2, result: "wrong_answer" as const, timeMs: 6 },
    ];
    finishJob(db, W1, {
      id: "s1",
      now: at(5),
      outcome: { result: "wrong_answer", tests },
      results: [],
      samplePass: never,
    });
    expect(row("s1").judge_result).toBe("wrong_answer");
    expect(JSON.parse(row("s1").judge_detail as string)).toEqual({ tests });
    expect(count("verdicts") + count("review_items")).toBe(0);
  });

  it("writes nothing for a worker that does not hold the job", () => {
    claimed();
    const done = finishJob(db, W2, {
      id: "s1",
      now: at(5),
      outcome: ACCEPTED,
      results: RESULTS,
      samplePass: never,
    });
    expect(done).toBe(false);
    expect(row("s1")).toMatchObject({ status: "running", locked_by: "w1" });
    expect(
      count("verdicts") + count("review_items") + count("model_calls"),
    ).toBe(0);
  });

  it("writes nothing for a stale worker whose lease ran out and was taken back", () => {
    claimed();
    claimNext(db, W2, at(61)); // w1 was too slow
    const done = finishJob(db, W1, {
      id: "s1",
      now: at(62),
      outcome: ACCEPTED,
      results: RESULTS,
      samplePass: never,
    });
    expect(done).toBe(false);
    expect(row("s1")).toMatchObject({ status: "running", locked_by: "w2" });
    expect(count("verdicts")).toBe(0);
  });

  it("writes nothing when the lab was published meanwhile", () => {
    claimed();
    db.prepare("UPDATE labs SET status = 'published' WHERE id = ?").run(LAB);
    const done = finishJob(db, W1, {
      id: "s1",
      now: at(5),
      outcome: ACCEPTED,
      results: RESULTS,
      samplePass: never,
    });
    expect(done).toBe(false);
    expect(row("s1").status).toBe("running");
    expect(
      count("verdicts") + count("review_items") + count("model_calls"),
    ).toBe(0);
  });

  it("stores one set of verdicts when the same job is finished twice", () => {
    claimed();
    const args = {
      id: "s1",
      now: at(5),
      outcome: ACCEPTED,
      results: RESULTS,
      samplePass: never,
    };
    expect(finishJob(db, W1, args)).toBe(true);
    expect(finishJob(db, W1, args)).toBe(false);
    expect(count("verdicts")).toBe(3);
    expect(count("review_items")).toBe(2);
    expect(count("model_calls")).toBe(1);
  });
});

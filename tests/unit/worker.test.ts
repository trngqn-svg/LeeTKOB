// The judge worker: one claimed job through the sandbox and the pipeline into the guarded
// finish (docs/ARCHITECTURE.md, sections 4.2 and 5). The sandbox and the pipeline are fakes:
// the real ones are tasks Q6 and L7, and no test runs student code or calls a model.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import type {
  ConstraintResult,
  RunInSandbox,
  SandboxOutcome,
} from "../../src/judge/types.ts";
import { createStore } from "../../src/store.ts";
import {
  startWorker,
  workOnce,
  type JudgeConstraints,
  type WorkerDeps,
} from "../../src/worker.ts";

const PASSWORD = "pw-worker-test";
const T0 = new Date("2026-11-26T09:00:00.000Z");
const SOURCE = "#include <algorithm>\nint main() { return 0; }\n";
const QUEUE = { workerId: "w1", leaseSeconds: 60, maxAttempts: 3 };

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

const ACCEPTED: SandboxOutcome = {
  result: "accepted",
  tests: [
    { position: 1, result: "passed", timeMs: 4 },
    { position: 2, result: "passed", timeMs: 5 },
  ],
};

const RESULTS: ConstraintResult[] = [
  {
    constraintCode: "C1",
    verdict: "pass",
    decidedBy: "hard_rule",
    evidence: [],
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
];

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;
let student = "";
let labId = "";

beforeEach(async () => {
  db = openDatabase(":memory:");
  migrate(db);
  seedAccounts(db, PASSWORD);
  app = buildApp(createStore({ users: [], labs: [], now: () => T0 }), db);
  const login = async (email: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password: PASSWORD },
      })
    ).json().token as string;
  student = await login("student1@leetkob.example");
  const ta = await login("ta1@leetkob.example");
  labId = (
    await app.inject({
      method: "POST",
      url: "/classes/class-a/labs",
      headers: { authorization: `Bearer ${ta}` },
      payload: LAB_BODY,
    })
  ).json().id;
});

afterEach(async () => {
  await app.close();
  db.close();
});

/** Submits through the API, as a student does. */
async function submit(sourceCode = SOURCE): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/labs/${labId}/submissions`,
    headers: { authorization: `Bearer ${student}` },
    payload: { sourceCode },
  });
  expect(res.statusCode).toBe(202);
  return res.json().submissionId;
}

interface Calls {
  sandbox: Parameters<RunInSandbox>[];
  pipeline: Parameters<JudgeConstraints>[];
}

function deps(
  overrides: Partial<WorkerDeps> = {},
): WorkerDeps & { calls: Calls } {
  const calls: Calls = { sandbox: [], pipeline: [] };
  return {
    db,
    queue: QUEUE,
    now: () => T0,
    runInSandbox: async (...args: Parameters<RunInSandbox>) => {
      calls.sandbox.push(args);
      return ACCEPTED;
    },
    judgeConstraints: async (...args: Parameters<JudgeConstraints>) => {
      calls.pipeline.push(args);
      return RESULTS;
    },
    samplePass: () => false,
    ...overrides,
    calls,
  };
}

function status(id: string) {
  return {
    ...(db
      .prepare(
        "SELECT status, judge_result, attempts, locked_by FROM submissions WHERE id = ?",
      )
      .get(id) as Record<string, unknown>),
  };
}

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("stop the worker, submit, start the worker (ARCHITECTURE 4.2)", () => {
  it("keeps the submission queued, then judges it once, with one set of verdicts", async () => {
    const id = await submit(); // no worker is running
    expect(status(id)).toMatchObject({ status: "queued", attempts: 0 });

    const d = deps();
    const worker = startWorker(d, { pollMs: 5 });
    await until(() => status(id).status === "judged");
    await worker.stop();

    expect(status(id)).toMatchObject({
      status: "judged",
      judge_result: "accepted",
      attempts: 1,
      locked_by: null,
    });
    expect(count("verdicts")).toBe(2);
    expect(count("review_items")).toBe(1); // the unsure one
    expect(d.calls.sandbox).toHaveLength(1);

    // Started again, it finds nothing to do and stores nothing more.
    expect(await workOnce(d)).toBe("idle");
    expect(count("verdicts")).toBe(2);
  });

  it("judges several queued submissions in the order they came", async () => {
    const first = await submit("int main() { return 1; }\n");
    const second = await submit("int main() { return 2; }\n");
    const d = deps();
    expect(await workOnce(d)).toBe("judged");
    expect(status(first).status).toBe("judged");
    expect(status(second).status).toBe("queued");
    expect(await workOnce(d)).toBe("judged");
    expect(await workOnce(d)).toBe("idle");
  });

  it("stops: no job is claimed after stop() has resolved", async () => {
    const d = deps();
    const worker = startWorker(d, { pollMs: 5 });
    await worker.stop();
    const id = await submit();
    await new Promise((r) => setTimeout(r, 30));
    expect(status(id).status).toBe("queued");
  });
});

describe("workOnce", () => {
  it("answers idle and runs nothing when the queue is empty", async () => {
    const d = deps();
    expect(await workOnce(d)).toBe("idle");
    expect(d.calls.sandbox).toHaveLength(0);
  });

  it("gives the sandbox the source, the lab's tests in order and the lab's limits", async () => {
    await submit();
    const d = deps();
    await workOnce(d);
    expect(d.calls.sandbox).toEqual([
      [
        SOURCE,
        [
          { position: 1, input: "2\n2 1\n", expectedOutput: "1 2\n" },
          { position: 2, input: "1\n7\n", expectedOutput: "7\n" },
        ],
        { timeLimitMs: 2000, memoryLimitMb: 128 },
      ],
    ]);
  });

  it("gives the pipeline the statement, the constraints and the source, never an identity", async () => {
    await submit();
    const d = deps();
    await workOnce(d);
    expect(d.calls.pipeline).toEqual([
      [
        {
          statement: "# Sort\n\nRead n, then n integers.",
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
          sourceCode: SOURCE,
        },
      ],
    ]);
    const sent = JSON.stringify(d.calls.pipeline);
    for (const who of ["u-st-1", "student1", "Student"]) {
      expect(sent).not.toContain(who);
    }
  });

  it("does not run the pipeline for a submission that is not accepted (FAQ-04)", async () => {
    const id = await submit();
    const d = deps({
      runInSandbox: async () => ({
        result: "wrong_answer",
        tests: [{ position: 1, result: "wrong_answer", timeMs: 3 }],
      }),
    });
    expect(await workOnce(d)).toBe("judged");
    expect(d.calls.pipeline).toHaveLength(0);
    expect(status(id)).toMatchObject({
      status: "judged",
      judge_result: "wrong_answer",
    });
    expect(count("verdicts")).toBe(0);
  });

  it("releases the job at once when the sandbox fails (a failure of the system)", async () => {
    const id = await submit();
    const d = deps({
      runInSandbox: async () => {
        throw new Error("Cannot connect to the Docker daemon");
      },
    });
    expect(await workOnce(d)).toBe("released");
    expect(d.calls.pipeline).toHaveLength(0);
    expect(status(id)).toMatchObject({
      status: "queued",
      attempts: 1,
      locked_by: null,
    });
  });

  it("releases the job when the pipeline throws, and stores no verdict", async () => {
    const id = await submit();
    const d = deps({
      judgeConstraints: async () => {
        throw new Error("bug in the pipeline");
      },
    });
    expect(await workOnce(d)).toBe("released");
    expect(status(id).status).toBe("queued");
    expect(count("verdicts")).toBe(0);
  });

  it("marks the job failed after MAX_ATTEMPTS failures of the system", async () => {
    const id = await submit();
    const d = deps({
      runInSandbox: async () => {
        throw new Error("image missing");
      },
    });
    for (let i = 0; i < QUEUE.maxAttempts; i++) {
      expect(await workOnce(d)).toBe("released");
    }
    expect(status(id)).toMatchObject({ status: "failed", attempts: 3 });
    expect(await workOnce(d)).toBe("idle");
  });

  it("drops its work when it lost the lease during the sandbox run, without calling the model", async () => {
    const id = await submit();
    const d = deps({
      runInSandbox: async () => {
        // Another worker took the job while this one was slow.
        db.prepare("UPDATE submissions SET locked_by = 'w2' WHERE id = ?").run(
          id,
        );
        return ACCEPTED;
      },
    });
    expect(await workOnce(d)).toBe("lost");
    expect(d.calls.pipeline).toHaveLength(0);
    expect(status(id)).toMatchObject({ status: "running", locked_by: "w2" });
    expect(count("verdicts")).toBe(0);
  });

  it("writes nothing when the lab is published while it judges", async () => {
    const id = await submit();
    const d = deps({
      judgeConstraints: async () => {
        db.prepare("UPDATE labs SET status = 'published' WHERE id = ?").run(
          labId,
        );
        return RESULTS;
      },
    });
    expect(await workOnce(d)).toBe("lost");
    expect(status(id).status).toBe("running");
    expect(count("verdicts") + count("review_items")).toBe(0);
  });

  it("extends the lease while a long step runs", async () => {
    const id = await submit();
    const leases: string[] = [];
    const d = deps({
      // A lease of 40 ms, so the heartbeat (every quarter of it) runs during the step.
      queue: { ...QUEUE, leaseSeconds: 0.04 },
      now: () => new Date(),
      runInSandbox: async () => {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 25));
          leases.push(
            (
              db
                .prepare("SELECT lease_until FROM submissions WHERE id = ?")
                .get(id) as { lease_until: string }
            ).lease_until,
          );
        }
        return ACCEPTED;
      },
    });
    expect(await workOnce(d)).toBe("judged");
    expect(new Set(leases).size).toBeGreaterThan(1);
    expect(leases).toEqual([...leases].sort());
  });
});

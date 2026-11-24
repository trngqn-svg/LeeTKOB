// Contract tests for docs/contract/submit.md.
// Expected values are copied from the contract on purpose: never import them from src/.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  "lab-not-found": [404, "Lab not found"],
  "lab-published": [409, "The lab is already published"],
  "deadline-passed": [409, "The deadline has passed"],
  "too-many-submissions": [429, "Too many submissions"],
} as const;

const NOTICE =
  "If this submission is Accepted, automatic rules and an AI model check it against the lab's constraints. The model receives your code without comments, name or student ID. No deduction reaches your mark until a TA has reviewed it.";
const BODY_LIMIT = 262144;
const SOURCE_LIMIT = 65536;
const MAX_PENDING = 15;
const MAX_PER_MINUTE = 30;

const PASSWORD = "pw-contract-test";
const T0 = new Date("2026-11-25T09:00:00.000Z");
const PAST_DEADLINE = "2026-11-24T09:00:00.000Z";
const PUBLISHED_AT = "2026-11-25T08:00:00.000Z";
const SOURCE = "#include <iostream>\nint main() { std::cout << 1; }\n";

let db: DatabaseSync;
let app: ReturnType<typeof buildApp>;
const tokens: Record<string, string> = {};
let labA = ""; // class-a, open
let labB = ""; // class-b: student1 is not a member
let labPublished = ""; // class-a, published
let labLate = ""; // class-a, deadline passed
let labLatePublished = ""; // class-a, published and deadline passed

const LAB_BODY = {
  title: "Merge sort",
  statementMd: "# Sort\n\nRead n, then n integers.",
  deadline: "2026-12-01T15:00:00Z",
  timeLimitMs: 2000,
  memoryLimitMb: 128,
  tests: [{ input: "2\n2 1\n", expectedOutput: "1 2\n" }],
  constraints: [{ text: "Do not call `std::sort`.", deduction: 3 }],
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
  labPublished = await create("class-a", tokens.ta1 ?? "");
  labLate = await create("class-a", tokens.ta1 ?? "");
  labLatePublished = await create("class-a", tokens.ta1 ?? "");
  for (const id of [labPublished, labLatePublished]) {
    db.prepare(
      "INSERT INTO publications (lab_id, published_at, published_by, marks_published) VALUES (?, ?, ?, 0)",
    ).run(id, PUBLISHED_AT, "u-ta-1");
    db.prepare("UPDATE labs SET status = 'published' WHERE id = ?").run(id);
  }
  for (const id of [labLate, labLatePublished]) {
    db.prepare("UPDATE labs SET deadline = ? WHERE id = ?").run(
      PAST_DEADLINE,
      id,
    );
  }
});

beforeEach(() => {
  // Every 202 adds a queued row for student1; start each test from none.
  db.exec("DELETE FROM submissions");
});

afterAll(async () => {
  await app.close();
  db.close();
});

interface Call {
  labId?: string;
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

function submit({
  labId = labA,
  token = tokens.student ?? "",
  body = { sourceCode: SOURCE },
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
    url: `/labs/${labId}/submissions`,
    headers,
    payload,
  });
}

type Res = Awaited<ReturnType<typeof submit>>;

function expectProblem(res: Res, slug: keyof typeof CONTRACT, labId = labA) {
  const [status, title] = CONTRACT[slug];
  expect(res.statusCode).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({
    type: `https://leetkob.example/problems/${slug}`,
    title,
    status,
    instance: `/labs/${labId}/submissions`,
  });
  expect(typeof body.detail).toBe("string");
  return body;
}

const countSubmissions = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM submissions").get() as { n: number })
    .n;

let fillId = 0;
/** Stores rows for student1 directly, as earlier submissions would have. */
function fill(
  n: number,
  status: "queued" | "running" | "judged",
  createdAt: string,
  labId = labPublished, // another lab: the limits count every lab
) {
  const insert = db.prepare(`
    INSERT INTO submissions (id, lab_id, student_id, source_code, status, judge_result, locked_by, lease_until, created_at)
    VALUES (?, ?, 'u-st-1', 'int main() {}', ?, ?, ?, ?, ?)`);
  for (let i = 0; i < n; i++) {
    insert.run(
      `sub-fill-${++fillId}`,
      labId,
      status,
      status === "judged" ? "accepted" : null,
      status === "running" ? "worker-test" : null,
      status === "running" ? "2026-11-25T09:05:00.000Z" : null,
      createdAt,
    );
  }
}

const secondsBefore = (s: number) =>
  new Date(T0.getTime() - s * 1000).toISOString();

describe("202 — the submission is queued", () => {
  it("answers with every field the contract names and a Location", async () => {
    const res = await submit();
    expect(res.statusCode).toBe(202);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const body = res.json();
    expect(body).toEqual({
      submissionId: expect.any(String),
      labId: labA,
      status: "queued",
      createdAt: "2026-11-25T09:00:00.000Z",
      notice: NOTICE,
    });
    expect(res.headers.location).toBe(`/submissions/${body.submissionId}`);
  });

  it("stores one queued row with the source exactly as sent", async () => {
    const sourceCode = "  // é\r\n#include <bits/stdc++.h>\nint main(){}\t\n";
    const res = await submit({ body: { sourceCode } });
    const row = db
      .prepare(
        "SELECT lab_id, student_id, source_code, status, judge_result FROM submissions WHERE id = ?",
      )
      .get(res.json().submissionId);
    expect({ ...row }).toEqual({
      lab_id: labA,
      student_id: "u-st-1",
      source_code: sourceCode,
      status: "queued",
      judge_result: null,
    });
  });

  it("stores a second submission when the same request is sent again", async () => {
    const first = (await submit()).json().submissionId;
    const second = (await submit()).json().submissionId;
    expect(second).not.toBe(first);
    expect(countSubmissions()).toBe(2);
  });

  it("accepts a source of exactly 64 KiB in UTF-8", async () => {
    const res = await submit({
      body: { sourceCode: "é".repeat(SOURCE_LIMIT / 2) },
    });
    expect(res.statusCode).toBe(202);
  });

  it("never contains a judge result or a verdict", async () => {
    const text = (await submit()).body;
    for (const word of ["verdict", "evidence", "result", "judge"]) {
      expect(text).not.toContain(`"${word}`);
    }
  });
});

describe("401 — unauthenticated", () => {
  it("answers no token and an unknown token, and stores nothing", async () => {
    expectProblem(await submit({ token: null }), "unauthenticated");
    expectProblem(await submit({ token: "x".repeat(43) }), "unauthenticated");
    expect(countSubmissions()).toBe(0);
  });
});

describe("403 — role-not-allowed", () => {
  it("answers a TA and an admin, naming the student role", async () => {
    for (const who of ["ta1", "admin"]) {
      const body = expectProblem(
        await submit({ token: tokens[who] ?? "" }),
        "role-not-allowed",
      );
      expect(body.requiredRole).toBe("student");
    }
    expect(countSubmissions()).toBe(0);
  });
});

describe("404 — lab-not-found", () => {
  it("answers a lab of another class like a lab that does not exist", async () => {
    const other = expectProblem(
      await submit({ labId: labB }),
      "lab-not-found",
      labB,
    );
    const missing = expectProblem(
      await submit({ labId: "lab-missing" }),
      "lab-not-found",
      "lab-missing",
    );
    expect(other.detail).toBe(missing.detail);
    expect(countSubmissions()).toBe(0);
  });
});

describe("413 — payload-too-large", () => {
  it("answers a body over 256 KiB, with the body limit", async () => {
    const body = expectProblem(
      await submit({ rawBody: `"${"x".repeat(BODY_LIMIT)}"` }),
      "payload-too-large",
    );
    expect(body.limitBytes).toBe(BODY_LIMIT);
  });

  it("answers a source over 64 KiB in UTF-8, with the source limit", async () => {
    // 65 537 bytes in UTF-8 but only 32 769 characters.
    const body = expectProblem(
      await submit({
        body: { sourceCode: "é".repeat(SOURCE_LIMIT / 2) + "x" },
      }),
      "payload-too-large",
    );
    expect(body.limitBytes).toBe(SOURCE_LIMIT);
    expect(countSubmissions()).toBe(0);
  });
});

describe("415 — unsupported-media-type", () => {
  it("answers a body that is not application/json", async () => {
    expectProblem(
      await submit({ rawBody: SOURCE, contentType: "text/plain" }),
      "unsupported-media-type",
    );
  });
});

describe("422 — validation-failed", () => {
  const cases: [string, Call, string][] = [
    ["no body", { body: null }, ""],
    ["a body that is not JSON", { rawBody: "{not json" }, ""],
    ["a body that is not an object", { body: [SOURCE] }, ""],
    ["a missing sourceCode", { body: {} }, "/sourceCode"],
    [
      "a sourceCode that is not a string",
      { body: { sourceCode: 1 } },
      "/sourceCode",
    ],
    ["an empty sourceCode", { body: { sourceCode: "" } }, "/sourceCode"],
    [
      "a sourceCode of only whitespace",
      { body: { sourceCode: " \n\t " } },
      "/sourceCode",
    ],
    [
      "an unknown field",
      { body: { sourceCode: SOURCE, language: "c" } },
      "/language",
    ],
  ];
  for (const [name, call, pointer] of cases) {
    it(`answers ${name}, pointing at the field`, async () => {
      const body = expectProblem(await submit(call), "validation-failed");
      expect(body.errors).toEqual(
        expect.arrayContaining([{ pointer, message: expect.any(String) }]),
      );
      expect(countSubmissions()).toBe(0);
    });
  }
});

describe("409 — lab-published and deadline-passed", () => {
  it("answers a published lab, with the time it was published", async () => {
    const body = expectProblem(
      await submit({ labId: labPublished }),
      "lab-published",
      labPublished,
    );
    expect(body.publishedAt).toBe(PUBLISHED_AT);
    expect(countSubmissions()).toBe(0);
  });

  it("answers a lab whose deadline has passed, with the deadline", async () => {
    const body = expectProblem(
      await submit({ labId: labLate }),
      "deadline-passed",
      labLate,
    );
    expect(body.deadline).toBe(PAST_DEADLINE);
    expect(countSubmissions()).toBe(0);
  });
});

describe("429 — too-many-submissions", () => {
  it("answers 15 pending submissions in other labs, without Retry-After", async () => {
    fill(MAX_PENDING - 1, "queued", secondsBefore(600));
    fill(1, "running", secondsBefore(600));
    const res = await submit();
    const body = expectProblem(res, "too-many-submissions");
    expect(body).toMatchObject({ limit: "pending", max: MAX_PENDING });
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(countSubmissions()).toBe(MAX_PENDING);
  });

  it("accepts one fewer than the pending limit; judged rows are not pending", async () => {
    fill(MAX_PENDING - 1, "queued", secondsBefore(600));
    fill(5, "judged", secondsBefore(600));
    expect((await submit()).statusCode).toBe(202);
  });

  it("answers 30 submissions in the last minute, with Retry-After until the oldest is 60 s old", async () => {
    fill(1, "judged", secondsBefore(10));
    fill(MAX_PER_MINUTE - 1, "judged", secondsBefore(5));
    const res = await submit();
    const body = expectProblem(res, "too-many-submissions");
    expect(body).toMatchObject({ limit: "per-minute", max: MAX_PER_MINUTE });
    expect(res.headers["retry-after"]).toBe("50");
    expect(countSubmissions()).toBe(MAX_PER_MINUTE);
  });

  it("rounds Retry-After up to whole seconds", async () => {
    fill(MAX_PER_MINUTE, "judged", secondsBefore(10.5));
    const res = await submit();
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("50");
  });

  it("does not count a submission more than 60 seconds old", async () => {
    fill(1, "judged", secondsBefore(61));
    fill(MAX_PER_MINUTE - 1, "judged", secondsBefore(5));
    expect((await submit()).statusCode).toBe(202);
  });
});

describe("order of checks", () => {
  it("1. the body size before everything, even without a token", async () => {
    expectProblem(
      await submit({ token: null, rawBody: `"${"x".repeat(BODY_LIMIT)}"` }),
      "payload-too-large",
    );
  });

  it("2. the media type and the JSON syntax before authentication", async () => {
    expectProblem(
      await submit({ token: null, rawBody: "x", contentType: "text/plain" }),
      "unsupported-media-type",
    );
    expectProblem(
      await submit({ token: null, rawBody: "{not json" }),
      "validation-failed",
    );
  });

  it("3. authentication before the role", async () => {
    expectProblem(
      await submit({ token: null, labId: "lab-missing" }),
      "unauthenticated",
      "lab-missing",
    );
  });

  it("4. the role before the lab", async () => {
    expectProblem(
      await submit({ token: tokens.ta1 ?? "", labId: "lab-missing" }),
      "role-not-allowed",
      "lab-missing",
    );
  });

  it("5. the lab before the body rules", async () => {
    expectProblem(
      await submit({ labId: labB, body: { sourceCode: "" } }),
      "lab-not-found",
      labB,
    );
  });

  it("6. the body rules before the source size", async () => {
    expectProblem(
      await submit({
        body: { sourceCode: "x".repeat(SOURCE_LIMIT + 1), language: "c" },
      }),
      "validation-failed",
    );
  });

  it("7. the source size before the state of the lab", async () => {
    expectProblem(
      await submit({
        labId: labLatePublished,
        body: { sourceCode: "x".repeat(SOURCE_LIMIT + 1) },
      }),
      "payload-too-large",
      labLatePublished,
    );
  });

  it("8. published before the deadline", async () => {
    expectProblem(
      await submit({ labId: labLatePublished }),
      "lab-published",
      labLatePublished,
    );
  });

  it("9. the deadline before the limits on submitting", async () => {
    fill(MAX_PENDING, "queued", secondsBefore(600));
    expectProblem(await submit({ labId: labLate }), "deadline-passed", labLate);
  });
});

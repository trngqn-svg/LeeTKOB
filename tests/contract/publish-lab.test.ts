// Contract tests for docs/contract/publish-lab.md.
// Expected values are copied from the contract on purpose: never import them from src/.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { createStore, type Store } from "../../src/store.ts";

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
  "reviews-pending": [409, "Reviews are still pending"],
  internal: [500, "Internal server error"],
} as const;

const T0 = new Date("2026-11-10T14:03:00.000Z");

let store: Store;
let clock: Date;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  clock = T0;
  store = createStore({
    now: () => clock,
    users: [
      { id: "u-ta-1", role: "ta", token: "tok-ta-1", classIds: ["c1"] },
      { id: "u-ta-2", role: "ta", token: "tok-ta-2", classIds: ["c1"] },
      { id: "u-ta-other", role: "ta", token: "tok-ta-other", classIds: ["c2"] },
      { id: "u-st-1", role: "student", token: "tok-student", classIds: ["c1"] },
      { id: "u-admin", role: "admin", token: "tok-admin", classIds: [] },
    ],
    labs: [
      {
        id: "lab-ready",
        classId: "c1",
        pendingReviews: 0,
        judgedSubmissions: 80,
        publication: null,
      },
      {
        id: "lab-pending",
        classId: "c1",
        pendingReviews: 3,
        judgedSubmissions: 78,
        publication: null,
      },
      {
        id: "lab-c2",
        classId: "c2",
        pendingReviews: 0,
        judgedSubmissions: 40,
        publication: null,
      },
    ],
  });
  app = buildApp(store);
});

interface Call {
  labId?: string;
  token?: string | null;
  key?: string | null;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

function publish({
  labId = "lab-ready",
  token = "tok-ta-1",
  key = "key-1",
  body = { confirm: true },
  rawBody,
  contentType = "application/json",
}: Call = {}) {
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

function expectProblem(
  res: Res,
  slug: keyof typeof CONTRACT,
  labId = "lab-ready",
) {
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

const published = (labId = "lab-ready") =>
  store.labs.get(labId)?.publication ?? null;

describe("201 — first publish", () => {
  it("returns the publication with every field the contract names", async () => {
    const res = await publish({ body: { confirm: true, note: "Sorting lab" } });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(res.json()).toEqual({
      labId: "lab-ready",
      status: "published",
      publishedAt: "2026-11-10T14:03:00.000Z",
      publishedBy: "u-ta-1",
      marksPublished: 80,
      note: "Sorting lab",
    });
  });

  it("makes the lab published (side effect) and note defaults to null", async () => {
    const res = await publish();
    expect(res.json().note).toBeNull();
    expect(published()).not.toBeNull();
  });

  it("lets any TA of the class publish, not only its creator", async () => {
    const res = await publish({ token: "tok-ta-2" });
    expect(res.statusCode).toBe(201);
    expect(res.json().publishedBy).toBe("u-ta-2");
  });
});

describe("idempotency", () => {
  it("same key + same body replays the stored response, no second side effect", async () => {
    const first = await publish({ body: { confirm: true, note: "n" } });
    clock = new Date("2026-11-10T15:00:00.000Z");
    const again = await publish({ body: { confirm: true, note: "n" } });
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(published()?.publishedAt).toBe(T0.toISOString());
  });

  it("same key + different body → idempotency-key-reused, nothing changes", async () => {
    await publish({ body: { confirm: true, note: "first" } });
    const res = await publish({ body: { confirm: true, note: "second" } });
    expectProblem(res, "idempotency-key-reused");
    expect(published()?.note).toBe("first");
  });

  it("new key on a published lab → 200 with the existing publication", async () => {
    const first = await publish({ body: { confirm: true, note: "first" } });
    clock = new Date("2026-11-11T09:00:00.000Z");
    const res = await publish({
      token: "tok-ta-2",
      key: "key-2",
      body: { confirm: true, note: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(res.json()).toEqual(first.json());
  });

  it("errors are not stored: the same key works once the cause is fixed", async () => {
    expectProblem(
      await publish({ labId: "lab-pending" }),
      "reviews-pending",
      "lab-pending",
    );
    store.labs.get("lab-pending")!.pendingReviews = 0;
    const res = await publish({ labId: "lab-pending" });
    expect(res.statusCode).toBe(201);
  });

  it("keys are scoped per caller: another TA's identical key is not a replay", async () => {
    await publish({ key: "shared" });
    const res = await publish({ token: "tok-ta-2", key: "shared" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("two concurrent publishes create exactly one publication", async () => {
    const [a, b] = await Promise.all([
      publish({ key: "k-a" }),
      publish({ token: "tok-ta-2", key: "k-b" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json()).toEqual(b.json());
  });
});

describe("who may call it", () => {
  it("no Authorization header → unauthenticated", async () => {
    expectProblem(await publish({ token: null }), "unauthenticated");
  });

  it("unknown token → unauthenticated", async () => {
    expectProblem(await publish({ token: "nope" }), "unauthenticated");
  });

  it("student → forbidden-role, lab not published", async () => {
    expectProblem(await publish({ token: "tok-student" }), "forbidden-role");
    expect(published()).toBeNull();
  });

  it("admin → forbidden-role", async () => {
    expectProblem(await publish({ token: "tok-admin" }), "forbidden-role");
  });

  it("unknown lab → lab-not-found", async () => {
    expectProblem(
      await publish({ labId: "lab-missing" }),
      "lab-not-found",
      "lab-missing",
    );
  });

  it("ownership: TA of another class → lab-not-found, same body as a missing lab", async () => {
    const foreign = expectProblem(
      await publish({ token: "tok-ta-other" }),
      "lab-not-found",
    );
    const missing = expectProblem(
      await publish({ token: "tok-ta-other", labId: "lab-missing" }),
      "lab-not-found",
      "lab-missing",
    );
    expect({ ...foreign, instance: null }).toEqual({
      ...missing,
      instance: null,
    });
    expect(published()).toBeNull();
  });
});

describe("Idempotency-Key header", () => {
  it.each([
    ["missing", null],
    ["empty", ""],
    ["bad characters", "key with spaces"],
    ["too long", "k".repeat(65)],
  ])("%s → invalid-idempotency-key", async (_name, key) => {
    expectProblem(await publish({ key }), "invalid-idempotency-key");
    expect(published()).toBeNull();
  });

  it("64 characters is accepted", async () => {
    expect((await publish({ key: "k".repeat(64) })).statusCode).toBe(201);
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
    const problem = expectProblem(await publish({ body }), "validation-failed");
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer, message: expect.any(String) }),
      ]),
    );
    expect(published()).toBeNull();
  });

  it("note of exactly 500 characters is accepted", async () => {
    expect(
      (await publish({ body: { confirm: true, note: "x".repeat(500) } }))
        .statusCode,
    ).toBe(201);
  });

  it("no body → validation-failed", async () => {
    expectProblem(await publish({ body: null }), "validation-failed");
  });

  it("invalid JSON → validation-failed", async () => {
    const problem = expectProblem(
      await publish({ rawBody: "{confirm:" }),
      "validation-failed",
    );
    expect(problem.errors).toHaveLength(1);
  });

  it("non-JSON content type → unsupported-media-type", async () => {
    expectProblem(
      await publish({ rawBody: "confirm", contentType: "text/plain" }),
      "unsupported-media-type",
    );
  });
});

describe("reviews-pending", () => {
  it("refuses with pendingCount and publishes nothing", async () => {
    const problem = expectProblem(
      await publish({ labId: "lab-pending" }),
      "reviews-pending",
      "lab-pending",
    );
    expect(problem.pendingCount).toBe(3);
    expect(published("lab-pending")).toBeNull();
  });
});

describe("internal", () => {
  it("unexpected failure → internal problem, nothing published", async () => {
    store.now = () => {
      throw new Error("clock down");
    };
    expectProblem(await publish(), "internal");
    expect(published()).toBeNull();
  });
});

describe("order of checks", () => {
  it("unauthenticated beats every later check", async () => {
    expectProblem(
      await publish({ token: null, key: null, body: {} }),
      "unauthenticated",
    );
  });

  it("forbidden-role beats lab-not-found", async () => {
    expectProblem(
      await publish({ token: "tok-student", labId: "lab-c2" }),
      "forbidden-role",
      "lab-c2",
    );
  });

  it("lab-not-found beats invalid-idempotency-key", async () => {
    expectProblem(
      await publish({ token: "tok-ta-other", key: null }),
      "lab-not-found",
    );
  });

  it("invalid-idempotency-key beats validation-failed", async () => {
    expectProblem(
      await publish({ key: null, body: {} }),
      "invalid-idempotency-key",
    );
  });

  it("validation-failed beats reviews-pending", async () => {
    expectProblem(
      await publish({ labId: "lab-pending", body: {} }),
      "validation-failed",
      "lab-pending",
    );
  });

  it("already published beats reviews-pending", async () => {
    await publish();
    store.labs.get("lab-ready")!.pendingReviews = 2;
    expect((await publish({ key: "key-2" })).statusCode).toBe(200);
  });
});

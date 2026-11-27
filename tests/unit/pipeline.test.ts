// Judging pipeline (task L7; docs/ARCHITECTURE.md, section 5) and end-to-end
// worker + SQLite integration with fake sandbox and fake model.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedAccounts } from "../../src/db/seed.ts";
import { readConstraint } from "../../src/judge/constraints.ts";
import { createFakeModelClient } from "../../src/judge/model.ts";
import {
  createPipeline,
  readPipelineConfig,
} from "../../src/judge/pipeline.ts";
import type { SandboxOutcome } from "../../src/judge/types.ts";
import { createStore } from "../../src/store.ts";
import { workOnce } from "../../src/worker.ts";

describe("readPipelineConfig", () => {
  it("uses defaults when LLM_API_KEY and LLM_MODEL are set", () => {
    expect(
      readPipelineConfig({
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gemini-2.5-flash",
      }),
    ).toEqual({
      modelOff: false,
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      timeoutMs: 20_000,
      delayMs: 0,
    });
  });

  it("allows missing LLM_API_KEY and LLM_MODEL when MODEL_OFF=1", () => {
    expect(readPipelineConfig({ MODEL_OFF: "1" })).toEqual({
      modelOff: true,
      apiKey: "",
      model: "",
      timeoutMs: 20_000,
      delayMs: 0,
    });
  });

  it("throws naming LLM_API_KEY or LLM_MODEL when MODEL_OFF is not 1", () => {
    expect(() => readPipelineConfig({ LLM_MODEL: "gemini-2.5-flash" })).toThrow(
      "LLM_API_KEY",
    );
    expect(() => readPipelineConfig({ LLM_API_KEY: "k" })).toThrow("LLM_MODEL");
  });

  it("throws naming invalid MODEL_OFF, MODEL_TIMEOUT_MS or MODEL_DELAY_MS values", () => {
    expect(() => readPipelineConfig({ MODEL_OFF: "true" })).toThrow(
      "MODEL_OFF",
    );
    expect(() =>
      readPipelineConfig({ MODEL_OFF: "1", MODEL_TIMEOUT_MS: "0" }),
    ).toThrow("MODEL_TIMEOUT_MS");
    expect(() =>
      readPipelineConfig({ MODEL_OFF: "1", MODEL_TIMEOUT_MS: "-5" }),
    ).toThrow("MODEL_TIMEOUT_MS");
    expect(() =>
      readPipelineConfig({ MODEL_OFF: "1", MODEL_DELAY_MS: "-1" }),
    ).toThrow("MODEL_DELAY_MS");
    expect(() =>
      readPipelineConfig({ MODEL_OFF: "1", MODEL_DELAY_MS: "abc" }),
    ).toThrow("MODEL_DELAY_MS");
  });
});

describe("createPipeline", () => {
  const banConstraint = readConstraint({
    code: "C1",
    text: "Do not call `std::sort`.",
    deduction: 3,
  });
  const semanticConstraint = readConstraint({
    code: "C2",
    text: "Sort with a merge sort you wrote yourself.",
    deduction: 4,
  });
  const statement = "Sort n integers.";

  it("decides ban_list via hard_rule without calling the model", async () => {
    let modelCalls = 0;
    const modelClient = createFakeModelClient(async () => {
      modelCalls++;
      return {
        text: '{"verdict":"pass","evidence":[]}',
        requestId: "r1",
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0,
      };
    });

    const judge = createPipeline({
      modelOff: false,
      modelClient,
      timeoutMs: 5000,
    });

    const results = await judge({
      statement,
      constraints: [banConstraint],
      sourceCode:
        "#include <algorithm>\nint main() { int a[2]={2,1}; std::sort(a, a+2); return 0; }\n",
    });

    expect(modelCalls).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      constraintCode: "C1",
      verdict: "violation",
      decidedBy: "hard_rule",
      modelCall: null,
    });
  });

  it("catches a hard-rule error as unsure (rule_error) and still judges remaining constraints", async () => {
    const modelClient = createFakeModelClient(async () => ({
      text: '{"verdict":"pass","evidence":[]}',
      requestId: "req-after-err",
      promptTokens: 20,
      completionTokens: 5,
      costUsd: 0,
    }));

    const judge = createPipeline({
      modelOff: false,
      modelClient,
      timeoutMs: 5000,
      checkBanListFn: async () => {
        throw new Error("unexpected parser crash");
      },
    });

    const results = await judge({
      statement,
      constraints: [banConstraint, semanticConstraint],
      sourceCode: "int main() { return 0; }\n",
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      constraintCode: "C1",
      verdict: "unsure",
      decidedBy: "fallback",
      reason: "rule_error",
      evidence: [],
      modelCall: null,
    });
    expect(results[1]).toMatchObject({
      constraintCode: "C2",
      verdict: "pass",
      decidedBy: "model",
    });
  });

  it("returns unsure (model_off) for semantic constraints when modelOff is true without calling the model", async () => {
    let modelCalls = 0;
    const modelClient = createFakeModelClient(async () => {
      modelCalls++;
      return {
        text: '{"verdict":"pass","evidence":[]}',
        requestId: "r-unused",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
      };
    });

    const judge = createPipeline({
      modelOff: true,
      modelClient,
      timeoutMs: 5000,
    });

    const results = await judge({
      statement,
      constraints: [banConstraint, semanticConstraint],
      sourceCode: "int main() { return 0; }\n",
    });

    expect(modelCalls).toBe(0);
    expect(results).toEqual([
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
    ]);
  });

  it("judges a mixed lab in constraint order using hard rules then the model", async () => {
    const modelClient = createFakeModelClient(async () => ({
      text: JSON.stringify({
        verdict: "violation",
        evidence: [{ line: 2, text: "int main() { return 0; }" }],
      }),
      requestId: "req-mix",
      promptTokens: 50,
      completionTokens: 15,
      costUsd: 0.0001,
    }));

    const judge = createPipeline({
      modelOff: false,
      modelClient,
      timeoutMs: 5000,
    });

    const results = await judge({
      statement,
      constraints: [banConstraint, semanticConstraint],
      sourceCode: "// harmless\nint main() { return 0; }\n",
    });

    expect(results.map((r) => r.constraintCode)).toEqual(["C1", "C2"]);
    expect(results[0]).toMatchObject({
      verdict: "pass",
      decidedBy: "hard_rule",
    });
    expect(results[1]).toMatchObject({
      verdict: "violation",
      decidedBy: "model",
      evidence: [{ line: 2, text: "int main() { return 0; }" }],
    });
    expect(results[1]?.modelCall?.requestId).toBe("req-mix");
  });
});

describe("worker + real pipeline integration (SQLite)", () => {
  const T0 = new Date("2026-11-26T10:00:00.000Z");
  const PASSWORD = "pw-pipeline-int";
  const QUEUE = { workerId: "w-int", leaseSeconds: 60, maxAttempts: 3 };
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof buildApp>;
  let studentToken = "";
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
    studentToken = await login("student1@leetkob.example");
    const taToken = await login("ta1@leetkob.example");
    labId = (
      await app.inject({
        method: "POST",
        url: "/classes/class-a/labs",
        headers: { authorization: `Bearer ${taToken}` },
        payload: {
          title: "Merge sort",
          statementMd: "Sort numbers.",
          tests: [{ input: "1\n5\n", expectedOutput: "5\n" }],
          constraints: [
            { text: "Do not call `std::sort`.", deduction: 3 },
            {
              text: "Sort with a merge sort you wrote yourself.",
              deduction: 4,
            },
          ],
        },
      })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function submitCode(sourceCode: string) {
    const res = await app.inject({
      method: "POST",
      url: `/labs/${labId}/submissions`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { sourceCode },
    });
    expect(res.statusCode).toBe(202);
    return res.json().submissionId as string;
  }

  it("stores hard_rule violation, model unsure, and sampled pass review items in SQLite", async () => {
    const accepted: SandboxOutcome = {
      result: "accepted",
      tests: [{ position: 1, result: "passed", timeMs: 3 }],
    };

    // Submission 1: ban_list violation (C1) + model pass sampled (C2)
    await submitCode(
      "#include <algorithm>\nint main() { int a[1]={1}; std::sort(a,a+1); return 0; }\n",
    );
    const passModel = createFakeModelClient(async () => ({
      text: '{"verdict":"pass","evidence":[]}',
      requestId: "req-s1",
      promptTokens: 30,
      completionTokens: 5,
      costUsd: 0.00001,
    }));

    const r1 = await workOnce({
      db,
      queue: QUEUE,
      now: () => T0,
      runInSandbox: async () => accepted,
      judgeConstraints: createPipeline({
        modelOff: false,
        modelClient: passModel,
        timeoutMs: 5000,
      }),
      samplePass: () => true,
    });
    expect(r1).toBe("judged");

    const items1 = db
      .prepare("SELECT reason FROM review_items ORDER BY id")
      .all() as { reason: string }[];
    expect(items1.map((i) => i.reason)).toEqual(["violation", "sample"]);

    const calls1 = db
      .prepare("SELECT request_id, outcome FROM model_calls")
      .all() as { request_id: string | null; outcome: string }[];
    expect(calls1).toEqual([{ request_id: "req-s1", outcome: "ok" }]);

    // Submission 2: ban_list pass (not sampled) + model unsure
    await submitCode("int main() { return 0; }\n");
    const unsureModel = createFakeModelClient(async () => ({
      text: '{"verdict":"unsure","evidence":[]}',
      requestId: "req-s2",
      promptTokens: 30,
      completionTokens: 5,
      costUsd: 0,
    }));
    const r2 = await workOnce({
      db,
      queue: QUEUE,
      now: () => T0,
      runInSandbox: async () => accepted,
      judgeConstraints: createPipeline({
        modelOff: false,
        modelClient: unsureModel,
        timeoutMs: 5000,
      }),
      samplePass: () => false,
    });
    expect(r2).toBe("judged");

    const itemsAll = db
      .prepare("SELECT reason FROM review_items ORDER BY id")
      .all() as { reason: string }[];
    expect(itemsAll.map((i) => i.reason)).toEqual([
      "violation",
      "sample",
      "unsure",
    ]);
  });

  it("writes no verdicts, model calls or review items when sandbox is wrong_answer", async () => {
    await submitCode("int main() { return 0; }\n");
    const wrongOutcome: SandboxOutcome = {
      result: "wrong_answer",
      tests: [{ position: 1, result: "wrong_answer", timeMs: 2 }],
    };

    const r = await workOnce({
      db,
      queue: QUEUE,
      now: () => T0,
      runInSandbox: async () => wrongOutcome,
      judgeConstraints: createPipeline({ modelOff: true, timeoutMs: 5000 }),
      samplePass: () => true,
    });
    expect(r).toBe("judged");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM verdicts").get() as { n: number })
        .n,
    ).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM review_items").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM model_calls").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });
});

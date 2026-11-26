// Checker CLI and eval gate tests (task L4; docs/ARCHITECTURE.md, sections 5.3 and 8).
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCheckerArgs, runChecker } from "../../src/checker/cli.ts";
import { evaluateGate } from "../../src/checker/eval-gate.ts";
import { createFakeModelClient } from "../../src/judge/model.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseCheckerArgs", () => {
  it("parses required --data and --output and optional --call-log", () => {
    expect(
      parseCheckerArgs([
        "--data",
        "leetkob-eval",
        "--output",
        "preds.jsonl",
        "--call-log",
        "calls.jsonl",
      ]),
    ).toEqual({
      dataDir: "leetkob-eval",
      outputPath: "preds.jsonl",
      callLogPath: "calls.jsonl",
    });
  });

  it("throws when --data or --output is missing or an unknown flag is passed", () => {
    expect(() => parseCheckerArgs(["--data", "d"])).toThrow("--output");
    expect(() => parseCheckerArgs(["--output", "o"])).toThrow("--data");
    expect(() =>
      parseCheckerArgs(["--data", "d", "--output", "o", "--bad"]),
    ).toThrow("--bad");
  });
});

describe("runChecker", () => {
  it("runs MODEL_OFF=1 on leetkob-eval with zero network calls, valid eval.mjs output, and 0 wrongful deductions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const outDir = makeTempDir("leetkob-checker-off-");
    const outPath = join(outDir, "predictions.jsonl");
    const summaryPath = join(outDir, "summary.json");
    const dataDir = resolve("leetkob-eval");

    const stats = await runChecker({
      dataDir,
      outputPath: outPath,
      modelOff: true,
      timeoutMs: 5000,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stats.solutions).toBe(47);
    expect(stats.pairs).toBe(102);
    expect(stats.modelCalls).toBe(0);

    const evalRun = spawnSync(
      process.execPath,
      [
        resolve("leetkob-eval/eval.mjs"),
        "--data",
        dataDir,
        "--predictions",
        outPath,
        "--json",
        summaryPath,
      ],
      { encoding: "utf8" },
    );

    expect(evalRun.status).not.toBe(2);
    expect([0, 1]).toContain(evalRun.status);

    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
      pairs: number;
      wrongful: number;
      unsure: number;
      caught: number;
    };
    expect(summary.pairs).toBe(102);
    expect(summary.wrongful).toBe(0);
    // 102 total pairs - 55 ban-list pairs = 47 semantic pairs (all unsure when MODEL_OFF=1).
    expect(summary.unsure).toBe(47);
  });

  it("writes call-log JSONL with requestId when model is on (fake model)", async () => {
    const dir = makeTempDir("leetkob-checker-on-");
    const dataDir = join(dir, "data");
    mkdirSync(join(dataDir, "problems/demo"), { recursive: true });
    mkdirSync(join(dataDir, "solutions/demo"), { recursive: true });

    writeFileSync(
      join(dataDir, "problems/demo/statement.md"),
      "Implement demo.",
    );
    writeFileSync(
      join(dataDir, "problems/demo/constraints.json"),
      JSON.stringify([
        { id: "C1", text: "Do not use `goto`.", deduction: 3 },
        { id: "C2", text: "Use recursion cleanly.", deduction: 4 },
      ]),
    );
    writeFileSync(
      join(dataDir, "solutions/demo/s01.cpp"),
      "int main() { return 0; }\n",
    );

    const outPath = join(dir, "predictions.jsonl");
    const logPath = join(dir, "calls.jsonl");
    const fakeModel = createFakeModelClient(async () => ({
      text: '{"verdict":"pass","evidence":[]}',
      requestId: "req-log-42",
      promptTokens: 77,
      completionTokens: 11,
      costUsd: 0.00005,
    }));

    const stats = await runChecker({
      dataDir,
      outputPath: outPath,
      callLogPath: logPath,
      modelOff: false,
      modelClient: fakeModel,
      timeoutMs: 5000,
    });

    expect(stats.pairs).toBe(2);
    expect(stats.modelCalls).toBe(1);

    const predLines = readFileSync(outPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(predLines).toHaveLength(2);
    expect(predLines[0]).toEqual({
      solution: "demo/s01",
      constraint: "C1",
      verdict: "pass",
      evidence: [],
    });
    expect(predLines[1]).toEqual({
      solution: "demo/s01",
      constraint: "C2",
      verdict: "pass",
      evidence: [],
    });

    const logLines = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatchObject({
      solution: "demo/s01",
      constraint: "C2",
      provider: "fake",
      model: "fake-model",
      requestId: "req-log-42",
      promptTokens: 77,
      completionTokens: 11,
      outcome: "ok",
    });
    expect(typeof logLines[0]?.prompt).toBe("string");
  });
});

describe("evaluateGate", () => {
  const baseSummary = {
    pairs: 102,
    wrongful: 0,
    recall: 1,
    unsureRate: 0.1,
    pass: true,
  };

  it("passes on exit 0 with 0 wrongful deductions", () => {
    expect(evaluateGate(baseSummary, 0, false).ok).toBe(true);
    expect(evaluateGate(baseSummary, 0, true).ok).toBe(true);
  });

  it("passes in model-off mode on exit 1 when wrongful is 0, and fails in strict mode", () => {
    const modelOffSummary = {
      ...baseSummary,
      recall: 0.4,
      unsureRate: 0.46,
      pass: false,
    };
    expect(evaluateGate(modelOffSummary, 1, false).ok).toBe(true);
    expect(evaluateGate(modelOffSummary, 1, true).ok).toBe(false);
  });

  it("always fails on exit 2, null exit code, or any wrongful deduction", () => {
    expect(evaluateGate(baseSummary, 2, false).ok).toBe(false);
    expect(evaluateGate(baseSummary, null, false).ok).toBe(false);
    expect(evaluateGate({ ...baseSummary, wrongful: 1 }, 1, false).ok).toBe(
      false,
    );
    expect(evaluateGate({ ...baseSummary, wrongful: 1 }, 0, false).ok).toBe(
      false,
    );
  });
});

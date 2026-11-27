// Checker command (task L4; docs/ARCHITECTURE.md, section 5.3):
// Reads a dataset folder (`problems/<id>/statement.md`, `constraints.json`, and
// `solutions/<id>/*.cpp`) and writes JSONL predictions (and optional model call log).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConstraint } from "../judge/constraints.ts";
import { createPipeline, createPipelineFromEnv } from "../judge/pipeline.ts";
import type { Constraint, ModelClient } from "../judge/types.ts";

export interface CheckerArgs {
  dataDir: string;
  outputPath: string;
  callLogPath?: string;
}

export function parseCheckerArgs(argv: string[]): CheckerArgs {
  let dataDir: string | undefined;
  let outputPath: string | undefined;
  let callLogPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data") {
      dataDir = argv[++i];
      if (!dataDir) throw new Error("--data requires a directory path.");
    } else if (arg === "--output") {
      outputPath = argv[++i];
      if (!outputPath) throw new Error("--output requires a file path.");
    } else if (arg === "--call-log") {
      callLogPath = argv[++i];
      if (!callLogPath) throw new Error("--call-log requires a file path.");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!dataDir) throw new Error("--data is required.");
  if (!outputPath) throw new Error("--output is required.");

  return callLogPath
    ? { dataDir, outputPath, callLogPath }
    : { dataDir, outputPath };
}

export interface RunCheckerOptions {
  dataDir: string;
  outputPath: string;
  callLogPath?: string;
  modelOff?: boolean;
  modelClient?: ModelClient;
  timeoutMs?: number;
  delayMs?: number;
}

export interface CheckerStats {
  solutions: number;
  pairs: number;
  modelCalls: number;
}

interface RawConstraint {
  id: string;
  text: string;
  deduction: number;
}

export async function runChecker(
  options: RunCheckerOptions,
): Promise<CheckerStats> {
  const root = resolve(options.dataDir);
  const problemsDir = join(root, "problems");
  const solutionsDir = join(root, "solutions");

  const judge = options.modelClient
    ? createPipeline({
        modelOff: options.modelOff ?? false,
        modelClient: options.modelClient,
        timeoutMs: options.timeoutMs ?? 20_000,
        delayMs: options.delayMs ?? 0,
      })
    : options.modelOff
      ? createPipeline({
          modelOff: true,
          timeoutMs: options.timeoutMs ?? 20_000,
        })
      : createPipelineFromEnv(process.env);

  const problemIds = readdirSync(problemsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const predictionLines: string[] = [];
  const callLogLines: string[] = [];
  let solutions = 0;

  for (const problemId of problemIds) {
    const statement = readFileSync(
      join(problemsDir, problemId, "statement.md"),
      "utf8",
    );
    const rawConstraints = JSON.parse(
      readFileSync(join(problemsDir, problemId, "constraints.json"), "utf8"),
    ) as RawConstraint[];
    const constraints: Constraint[] = rawConstraints.map((c) =>
      readConstraint({ code: c.id, text: c.text, deduction: c.deduction }),
    );

    const solDir = join(solutionsDir, problemId);
    const solFiles = readdirSync(solDir)
      .filter((f) => f.endsWith(".cpp"))
      .sort();

    for (const file of solFiles) {
      solutions++;
      const solutionId = `${problemId}/${file.replace(/\.cpp$/, "")}`;
      const sourceCode = readFileSync(join(solDir, file), "utf8");
      const results = await judge({ statement, constraints, sourceCode });

      for (const r of results) {
        predictionLines.push(
          JSON.stringify({
            solution: solutionId,
            constraint: r.constraintCode,
            verdict: r.verdict,
            evidence: r.evidence,
          }),
        );
        if (r.modelCall) {
          callLogLines.push(
            JSON.stringify({
              solution: solutionId,
              constraint: r.constraintCode,
              ...r.modelCall,
            }),
          );
        }
      }
    }
  }

  const outPath = resolve(options.outputPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    predictionLines.length > 0 ? predictionLines.join("\n") + "\n" : "",
    "utf8",
  );

  if (options.callLogPath) {
    const logPath = resolve(options.callLogPath);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      callLogLines.length > 0 ? callLogLines.join("\n") + "\n" : "",
      "utf8",
    );
  }

  return {
    solutions,
    pairs: predictionLines.length,
    modelCalls: callLogLines.length,
  };
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const args = parseCheckerArgs(process.argv.slice(2));
  const stats = await runChecker(args);
  console.log(
    `checker: ${stats.solutions} solutions, ${stats.pairs} pairs, ${stats.modelCalls} model calls`,
  );
}

// Runs leetkob-eval/eval.mjs and enforces the CI gate without shell pipes or
// `continue-on-error` (docs/ARCHITECTURE.md, section 8).
// Fails whenever eval.mjs exits 2 (invalid predictions), reports any wrongful
// deduction (> 0), or (when --strict is passed) exits non-zero.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EvalSummary {
  pairs: number;
  wrongful: number;
  recall: number;
  unsureRate: number;
  pass: boolean;
}

export function evaluateGate(
  summary: EvalSummary | null,
  exitCode: number | null,
  strict: boolean,
): { ok: boolean; reason: string } {
  if (exitCode === null) {
    return { ok: false, reason: "eval.mjs terminated without an exit code" };
  }
  if (exitCode === 2) {
    return { ok: false, reason: "eval.mjs exited 2 (invalid input)" };
  }
  if (exitCode !== 0 && exitCode !== 1) {
    return { ok: false, reason: `eval.mjs exited unexpectedly (${exitCode})` };
  }
  if (!summary) {
    return { ok: false, reason: "eval.mjs did not write a summary JSON file" };
  }
  if (summary.wrongful > 0) {
    return {
      ok: false,
      reason: `${summary.wrongful} wrongful deduction(s) found`,
    };
  }
  if (strict && exitCode !== 0) {
    return { ok: false, reason: "strict gate requires eval.mjs exit code 0" };
  }
  return { ok: true, reason: "ok" };
}

function parseGateArgs(argv: string[]) {
  let dataDir: string | undefined;
  let predictionsPath: string | undefined;
  let jsonPath: string | undefined;
  let strict = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data") {
      dataDir = argv[++i];
    } else if (arg === "--predictions") {
      predictionsPath = argv[++i];
    } else if (arg === "--json") {
      jsonPath = argv[++i];
    } else if (arg === "--strict") {
      strict = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!dataDir || !predictionsPath || !jsonPath) {
    throw new Error("--data, --predictions, and --json are required.");
  }
  return { dataDir, predictionsPath, jsonPath, strict };
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const { dataDir, predictionsPath, jsonPath, strict } = parseGateArgs(
    process.argv.slice(2),
  );
  const evalScript = resolve("leetkob-eval/eval.mjs");
  const result = spawnSync(
    process.execPath,
    [
      evalScript,
      "--data",
      resolve(dataDir),
      "--predictions",
      resolve(predictionsPath),
      "--json",
      resolve(jsonPath),
    ],
    { encoding: "utf8" },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const summary = existsSync(resolve(jsonPath))
    ? (JSON.parse(readFileSync(resolve(jsonPath), "utf8")) as EvalSummary)
    : null;
  const verdict = evaluateGate(summary, result.status, strict);
  if (!verdict.ok) {
    console.error(`eval-gate FAIL: ${verdict.reason}`);
    process.exit(1);
  }
  console.log("eval-gate PASS");
}

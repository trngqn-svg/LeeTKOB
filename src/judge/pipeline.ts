// Judging pipeline glue (task L7; docs/ARCHITECTURE.md, section 5).
// For an Accepted submission, runs hard rules on every ban_list constraint first,
// then runs semantic constraints through the model client + guardrails (or falls
// back to unsure with reason "model_off" when MODEL_OFF=1).
import type { JudgeConstraints } from "../worker.ts";
import { judgeSemanticConstraint } from "./guardrails.ts";
import { checkBanList } from "./hard-rules.ts";
import { createGeminiModelClient } from "./model.ts";
import type { Constraint, ConstraintResult, ModelClient } from "./types.ts";

type Env = Record<string, string | undefined>;

export interface PipelineConfig {
  modelOff: boolean;
  apiKey: string;
  model: string;
  timeoutMs: number;
  delayMs: number;
}

function nonNegativeInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${name} must be a whole number of at least 0, not "${raw}".`,
    );
  }
  return Number(raw);
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `${name} must be a whole number of at least 1, not "${raw}".`,
    );
  }
  return Number(raw);
}

/**
 * Reads pipeline environment settings. When MODEL_OFF=1, LLM_API_KEY and LLM_MODEL
 * are not required; otherwise both must be present.
 */
export function readPipelineConfig(env: Env): PipelineConfig {
  const rawOff = env.MODEL_OFF;
  if (
    rawOff !== undefined &&
    rawOff !== "" &&
    rawOff !== "0" &&
    rawOff !== "1"
  ) {
    throw new Error(`MODEL_OFF must be "0" or "1", not "${rawOff}".`);
  }
  const modelOff = rawOff === "1";
  const timeoutMs = positiveInt(env, "MODEL_TIMEOUT_MS", 20_000);
  const delayMs = nonNegativeInt(env, "MODEL_DELAY_MS", 0);

  if (modelOff) {
    return {
      modelOff: true,
      apiKey: env.LLM_API_KEY ?? "",
      model: env.LLM_MODEL ?? "",
      timeoutMs,
      delayMs,
    };
  }

  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required unless MODEL_OFF=1.");
  }
  const model = env.LLM_MODEL?.trim() ?? "";
  if (!model) {
    throw new Error("LLM_MODEL is required unless MODEL_OFF=1.");
  }

  return {
    modelOff: false,
    apiKey,
    model,
    timeoutMs,
    delayMs,
  };
}

export interface PipelineOptions {
  modelOff: boolean;
  modelClient?: ModelClient;
  timeoutMs: number;
  delayMs?: number;
  checkBanListFn?: (
    sourceCode: string,
    constraint: Constraint,
  ) => Promise<ConstraintResult>;
  now?: () => number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Builds the `JudgeConstraints` pipeline used by both the judge worker and the
 * CLI checker. Never throws on a hard-rule or model error: turns them into
 * `unsure` fallback verdicts so remaining constraints still get judged.
 */
export function createPipeline(options: PipelineOptions): JudgeConstraints {
  const checkBan = options.checkBanListFn ?? checkBanList;
  const delayMs = options.delayMs ?? 0;
  let calledModelOnce = false;

  return async ({ statement, constraints, sourceCode }) => {
    const results: ConstraintResult[] = [];

    for (const constraint of constraints) {
      if (constraint.kind === "ban_list") {
        try {
          results.push(await checkBan(sourceCode, constraint));
        } catch {
          results.push({
            constraintCode: constraint.code,
            verdict: "unsure",
            decidedBy: "fallback",
            reason: "rule_error",
            evidence: [],
            modelCall: null,
          });
        }
        continue;
      }

      if (options.modelOff || !options.modelClient) {
        results.push({
          constraintCode: constraint.code,
          verdict: "unsure",
          decidedBy: "fallback",
          reason: "model_off",
          evidence: [],
          modelCall: null,
        });
        continue;
      }

      if (delayMs > 0 && calledModelOnce) {
        await sleep(delayMs);
      }
      calledModelOnce = true;

      results.push(
        await judgeSemanticConstraint({
          statement,
          constraint,
          sourceCode,
          modelClient: options.modelClient,
          timeoutMs: options.timeoutMs,
          ...(options.now ? { now: options.now } : {}),
        }),
      );
    }

    return results;
  };
}

/** Builds the production pipeline from environment variables. */
export function createPipelineFromEnv(env: Env): JudgeConstraints {
  const config = readPipelineConfig(env);
  if (config.modelOff) {
    return createPipeline({
      modelOff: true,
      timeoutMs: config.timeoutMs,
    });
  }
  const modelClient = createGeminiModelClient({
    apiKey: config.apiKey,
    model: config.model,
  });
  return createPipeline({
    modelOff: false,
    modelClient,
    timeoutMs: config.timeoutMs,
    delayMs: config.delayMs,
  });
}

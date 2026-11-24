// Shared types of the judging pipeline (docs/ARCHITECTURE.md, sections 3 and 5).
// The worker, the checker command and the tests all build on these, so a change here
// is a change for every member: agree it first.

// ---------------------------------------------------------------------------
// Constraints

/** Set by code from the constraint text: "Do not use" / "Do not call" is a ban list. */
export type ConstraintKind = "ban_list" | "semantic";

export interface Constraint {
  /** "C1", "C2", ... as in constraints.json and lab_constraints.code. */
  code: string;
  text: string;
  kind: ConstraintKind;
  /** The backticked names of a ban list; empty for a semantic constraint. */
  bannedNames: string[];
  /** The TA's number. The pipeline never reads it to decide anything. */
  deduction: number;
}

// ---------------------------------------------------------------------------
// Verdicts

export type Verdict = "pass" | "violation" | "unsure";

export type DecidedBy = "hard_rule" | "model" | "fallback";

/** Why a verdict fell back to unsure. Present exactly when decidedBy is "fallback". */
export type ReasonCode =
  | "model_off"
  | "timeout"
  | "schema_invalid"
  | "model_error"
  | "evidence_mismatch"
  | "cost_cap"
  | "rule_error";

/** One line of the ORIGINAL source: 1-based line number and that line's exact text. */
export interface EvidenceLine {
  line: number;
  text: string;
}

/**
 * The outcome for one (submission, constraint). The union makes the schema's CHECKs
 * hold in the type system: a violation always has evidence, and a reason exists
 * exactly when the verdict fell back. There is no deduction field, on purpose.
 */
export type ConstraintResult =
  | {
      constraintCode: string;
      verdict: "pass" | "unsure";
      decidedBy: "hard_rule" | "model";
      evidence: EvidenceLine[];
      modelCall: ModelCallRecord | null;
    }
  | {
      constraintCode: string;
      verdict: "violation";
      decidedBy: "hard_rule" | "model";
      evidence: [EvidenceLine, ...EvidenceLine[]];
      modelCall: ModelCallRecord | null;
    }
  | {
      constraintCode: string;
      verdict: "unsure";
      decidedBy: "fallback";
      reason: ReasonCode;
      evidence: [];
      /** null for model_off and rule_error: no call was made. */
      modelCall: ModelCallRecord | null;
    };

// ---------------------------------------------------------------------------
// Model

/** What the prompt is built from: nothing else may reach the model (brief section 3). */
export interface ModelInput {
  statement: string;
  /** One semantic constraint, never a ban list. */
  constraint: Constraint;
  /** The code with comments blanked and line breaks kept, so line numbers match. */
  codeWithoutComments: string;
}

/** The provider's raw answer. Guardrails parse and check `text`; it is never stored. */
export interface ModelReply {
  text: string;
  requestId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number;
}

/**
 * The real client calls the provider; the fake one in tests returns canned replies.
 * The caller owns the timeout: it aborts `signal`, and the client must stop then.
 */
export interface ModelClient {
  readonly provider: string;
  readonly model: string;
  complete(prompt: string, signal: AbortSignal): Promise<ModelReply>;
}

/** One row of model_calls / one line of the checker's call log. */
export interface ModelCallRecord {
  provider: string;
  model: string;
  requestId: string | null;
  prompt: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  costUsd: number;
  outcome: "ok" | "timeout" | "schema_invalid" | "error";
}

// ---------------------------------------------------------------------------
// Sandbox

export type JudgeResult =
  | "accepted"
  | "wrong_answer"
  | "compile_error"
  | "runtime_error"
  | "time_limit"
  | "memory_limit";

export interface TestCase {
  position: number;
  input: string;
  expectedOutput: string;
}

/** From the lab (FAQ-05). Wall time is 3 times the CPU time, set by the sandbox. */
export interface SandboxLimits {
  timeLimitMs: number;
  memoryLimitMb: number;
}

/** Per test: never the input or the output (FAQ-02). */
export interface TestResult {
  position: number;
  result: Exclude<JudgeResult, "accepted" | "compile_error"> | "passed";
  timeMs: number;
}

export type SandboxOutcome =
  | { result: "compile_error"; compilerMessage: string }
  | { result: Exclude<JudgeResult, "compile_error">; tests: TestResult[] };

/**
 * Compiles and runs inside the sandbox only. Rejects (throws) only for a failure of
 * the system (Docker down, image missing): the worker then releases the job.
 * Anything the student's code does is an outcome, never a throw.
 */
export type RunInSandbox = (
  sourceCode: string,
  tests: TestCase[],
  limits: SandboxLimits,
) => Promise<SandboxOutcome>;

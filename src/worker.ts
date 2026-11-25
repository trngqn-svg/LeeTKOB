// The judge worker (docs/ARCHITECTURE.md, sections 4 and 5): claims a queued submission,
// runs it in the sandbox, judges the constraints of an accepted one, and finishes it in one
// guarded transaction. The sandbox (Q6) and the pipeline (L7) are passed in.
import type { DatabaseSync } from "node:sqlite";
import {
  claimNext,
  finishJob,
  heartbeat,
  putBack,
  release,
  type QueueOptions,
} from "./db/queue.ts";
import type {
  Constraint,
  ConstraintKind,
  ConstraintResult,
  RunInSandbox,
  SandboxOutcome,
  TestCase,
} from "./judge/types.ts";

/** The pipeline of L7: one result per constraint. It never sees who the student is. */
export type JudgeConstraints = (input: {
  statement: string;
  constraints: Constraint[];
  sourceCode: string;
}) => Promise<ConstraintResult[]>;

export interface WorkerDeps {
  db: DatabaseSync;
  queue: QueueOptions;
  now: () => Date;
  runInSandbox: RunInSandbox;
  judgeConstraints: JudgeConstraints;
  samplePass: () => boolean;
}

export type WorkResult =
  "idle" | "judged" | "released" | "unavailable" | "lost";

/** The sandbox threw: by its contract, a failure of the system, never of the student. */
class SandboxUnavailable extends Error {}

/** Takes at most one job and carries it to the end. */
export async function workOnce(deps: WorkerDeps): Promise<WorkResult> {
  const { db, queue, now } = deps;
  const job = claimNext(db, queue, now());
  if (!job) return "idle";

  let lost = false;
  const beat = () => {
    if (!heartbeat(db, queue, job.id, now())) lost = true;
  };
  const timer = setInterval(beat, (queue.leaseSeconds * 1000) / 4);
  try {
    const lab = loadLab(db, job.labId);
    let outcome: SandboxOutcome;
    try {
      outcome = await deps.runInSandbox(job.sourceCode, lab.tests, {
        timeLimitMs: lab.timeLimitMs,
        memoryLimitMb: lab.memoryLimitMb,
      });
    } catch (error) {
      throw new SandboxUnavailable("The sandbox is unavailable.", {
        cause: error,
      });
    }
    beat();
    // Another worker owns the job now: do not spend a model call on it.
    if (lost) return "lost";
    const results =
      outcome.result === "accepted"
        ? await deps.judgeConstraints({
            statement: lab.statement,
            constraints: lab.constraints,
            sourceCode: job.sourceCode,
          })
        : [];
    const done = finishJob(db, queue, {
      id: job.id,
      now: now(),
      outcome,
      results,
      samplePass: deps.samplePass,
    });
    return done ? "judged" : "lost";
  } catch (error) {
    if (error instanceof SandboxUnavailable) {
      // Docker down or the image missing: give the job back without counting the attempt.
      console.error(
        `worker ${queue.workerId}: job ${job.id} put back, sandbox unavailable:`,
        error.cause,
      );
      putBack(db, queue, job.id);
      return "unavailable";
    }
    // Not the student's fault (a bug in the pipeline): give the job back now, counted.
    console.error(`worker ${queue.workerId}: job ${job.id} released:`, error);
    release(db, queue, job.id, now());
    return "released";
  } finally {
    clearInterval(timer);
  }
}

export interface WorkerLoopOptions {
  /** The wait when the queue is empty, and the first wait after a failure. */
  pollMs: number;
  /** The longest wait after failures in a row. Default 60 s. */
  maxBackoffMs?: number;
}

/**
 * Runs workOnce until stop(). It waits pollMs when the queue is empty. After a failure it
 * waits pollMs, then twice as long after each failure in a row, up to maxBackoffMs, so a
 * Docker outage is not hammered (ARCHITECTURE section 4.1). stop() ends any wait at once.
 */
export function startWorker(
  deps: WorkerDeps,
  { pollMs, maxBackoffMs = 60_000 }: WorkerLoopOptions,
): { stop: () => Promise<void> } {
  let running = true;
  let wake: (() => void) | null = null;
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  const loop = (async () => {
    let failures = 0;
    while (running) {
      let result: WorkResult | "error" = "idle";
      try {
        result = await workOnce(deps);
      } catch (error) {
        // The database itself failed; wait and try again rather than die.
        console.error(`worker ${deps.queue.workerId}:`, error);
        result = "error";
      }
      if (!running) break;
      if (
        result === "unavailable" ||
        result === "released" ||
        result === "error"
      ) {
        failures++;
        await sleep(Math.min(pollMs * 2 ** (failures - 1), maxBackoffMs));
      } else {
        if (result === "judged") failures = 0;
        if (result === "idle") await sleep(pollMs);
      }
    }
  })();
  return {
    stop: async () => {
      running = false;
      wake?.();
      await loop;
    },
  };
}

function loadLab(db: DatabaseSync, labId: string) {
  const lab = db
    .prepare(
      "SELECT statement_md, time_limit_ms, memory_limit_mb FROM labs WHERE id = ?",
    )
    .get(labId) as {
    statement_md: string;
    time_limit_ms: number;
    memory_limit_mb: number;
  };
  const tests = (
    db
      .prepare(
        "SELECT position, input, expected_output FROM lab_tests WHERE lab_id = ? ORDER BY position",
      )
      .all(labId) as unknown as {
      position: number;
      input: string;
      expected_output: string;
    }[]
  ).map((t): TestCase => ({
    position: t.position,
    input: t.input,
    expectedOutput: t.expected_output,
  }));
  const constraints = (
    db
      .prepare(
        "SELECT code, text, kind, banned_names, deduction FROM lab_constraints WHERE lab_id = ? ORDER BY id",
      )
      .all(labId) as unknown as {
      code: string;
      text: string;
      kind: ConstraintKind;
      banned_names: string;
      deduction: number;
    }[]
  ).map((c): Constraint => ({
    code: c.code,
    text: c.text,
    kind: c.kind,
    bannedNames: JSON.parse(c.banned_names) as string[],
    deduction: c.deduction,
  }));
  return {
    statement: lab.statement_md,
    timeLimitMs: lab.time_limit_ms,
    memoryLimitMb: lab.memory_limit_mb,
    tests,
    constraints,
  };
}

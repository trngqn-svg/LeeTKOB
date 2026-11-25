// The worker queue: the statements of docs/ARCHITECTURE.md, section 4.1. The submissions
// table is the queue; every function takes the time, so leases are exact in tests.
import type { DatabaseSync } from "node:sqlite";
import type { ConstraintResult, SandboxOutcome } from "../judge/types.ts";

export interface QueueOptions {
  workerId: string;
  leaseSeconds: number;
  maxAttempts: number;
}

export interface ClaimedJob {
  id: string;
  labId: string;
  sourceCode: string;
}

const leaseEnd = (opts: QueueOptions, now: Date) =>
  new Date(now.getTime() + opts.leaseSeconds * 1000).toISOString();

/** Fails or requeues expired leases, then claims the oldest queued job, or null. */
export function claimNext(
  db: DatabaseSync,
  opts: QueueOptions,
  now: Date,
): ClaimedJob | null {
  const t = now.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE submissions
          SET status = 'failed', locked_by = NULL, lease_until = NULL, finished_at = ?
        WHERE status = 'running' AND lease_until < ? AND attempts >= ?`,
    ).run(t, t, opts.maxAttempts);
    db.prepare(
      `UPDATE submissions
          SET status = 'queued', locked_by = NULL, lease_until = NULL
        WHERE status = 'running' AND lease_until < ? AND attempts < ?`,
    ).run(t, opts.maxAttempts);
    const job = db
      .prepare(
        `UPDATE submissions
            SET status = 'running', locked_by = ?, lease_until = ?,
                attempts = attempts + 1, started_at = COALESCE(started_at, ?)
          WHERE id = (SELECT id FROM submissions WHERE status = 'queued'
                       ORDER BY created_at LIMIT 1)
        RETURNING id, lab_id, source_code`,
      )
      .get(opts.workerId, leaseEnd(opts, now), t) as
      { id: string; lab_id: string; source_code: string } | undefined;
    db.exec("COMMIT");
    return job
      ? { id: job.id, labId: job.lab_id, sourceCode: job.source_code }
      : null;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Extends the lease. False means this worker lost the job and must write nothing. */
export function heartbeat(
  db: DatabaseSync,
  opts: QueueOptions,
  id: string,
  now: Date,
): boolean {
  const { changes } = db
    .prepare(
      `UPDATE submissions SET lease_until = ?
        WHERE id = ? AND status = 'running' AND locked_by = ?`,
    )
    .run(leaseEnd(opts, now), id, opts.workerId);
  return changes > 0;
}

/**
 * After any other error that is not the student's (a bug in the pipeline): back to queued
 * at once, or failed on the last attempt. The attempt counts, so such a job cannot block
 * the queue forever.
 */
export function release(
  db: DatabaseSync,
  opts: QueueOptions,
  id: string,
  now: Date,
): boolean {
  const { changes } = db
    .prepare(
      `UPDATE submissions
          SET status = CASE WHEN attempts < ? THEN 'queued' ELSE 'failed' END,
              locked_by = NULL, lease_until = NULL,
              finished_at = CASE WHEN attempts < ? THEN NULL ELSE ? END
        WHERE id = ? AND status = 'running' AND locked_by = ?`,
    )
    .run(
      opts.maxAttempts,
      opts.maxAttempts,
      now.toISOString(),
      id,
      opts.workerId,
    );
  return changes > 0;
}

/**
 * After the sandbox was unavailable (Docker down, image missing): back to queued at once,
 * and the attempt is not counted, so an outage never turns a submission into failed.
 */
export function putBack(
  db: DatabaseSync,
  opts: QueueOptions,
  id: string,
): boolean {
  const { changes } = db
    .prepare(
      `UPDATE submissions
          SET status = 'queued', attempts = attempts - 1,
              locked_by = NULL, lease_until = NULL
        WHERE id = ? AND status = 'running' AND locked_by = ?`,
    )
    .run(id, opts.workerId);
  return changes > 0;
}

export interface Finish {
  id: string;
  now: Date;
  outcome: SandboxOutcome;
  /** One per constraint, only for an accepted submission; empty otherwise. */
  results: ConstraintResult[];
  /** Draws a pass for the TA's sample (brief section 3: 10 percent). */
  samplePass: () => boolean;
}

/**
 * The guarded finish: the result, the verdicts and the review items in one transaction.
 * False, and nothing written, when this worker lost the lease or the lab was published.
 */
export function finishJob(
  db: DatabaseSync,
  opts: QueueOptions,
  { id, now, outcome, results, samplePass }: Finish,
): boolean {
  const detail =
    outcome.result === "compile_error"
      ? { compilerMessage: outcome.compilerMessage }
      : { tests: outcome.tests };
  db.exec("BEGIN IMMEDIATE");
  try {
    const done = db
      .prepare(
        `UPDATE submissions
            SET status = 'judged', judge_result = ?, judge_detail = ?, finished_at = ?,
                locked_by = NULL, lease_until = NULL
          WHERE id = ? AND status = 'running' AND locked_by = ?
            AND EXISTS (SELECT 1 FROM labs WHERE id = submissions.lab_id AND status = 'open')
        RETURNING lab_id`,
      )
      .get(
        outcome.result,
        JSON.stringify(detail),
        now.toISOString(),
        id,
        opts.workerId,
      ) as { lab_id: string } | undefined;
    if (!done) {
      db.exec("ROLLBACK");
      return false;
    }

    const findConstraint = db.prepare(
      "SELECT id FROM lab_constraints WHERE lab_id = ? AND code = ?",
    );
    const insertCall = db.prepare(
      `INSERT INTO model_calls (submission_id, constraint_id, provider, model, request_id, prompt,
                                prompt_tokens, completion_tokens, latency_ms, cost_usd, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    );
    const insertVerdict = db.prepare(
      `INSERT INTO verdicts (submission_id, constraint_id, verdict, decided_by, reason_code,
                             evidence, model_call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (submission_id, constraint_id) DO NOTHING RETURNING id`,
    );
    const insertItem = db.prepare(
      `INSERT INTO review_items (verdict_id, lab_id, reason) VALUES (?, ?, ?)
       ON CONFLICT (verdict_id) DO NOTHING`,
    );

    for (const r of results) {
      const constraint = findConstraint.get(done.lab_id, r.constraintCode) as
        { id: number } | undefined;
      if (!constraint) {
        throw new Error(
          `No constraint ${r.constraintCode} in lab ${done.lab_id}.`,
        );
      }
      const call = r.modelCall
        ? (insertCall.get(
            id,
            constraint.id,
            r.modelCall.provider,
            r.modelCall.model,
            r.modelCall.requestId,
            r.modelCall.prompt,
            r.modelCall.promptTokens,
            r.modelCall.completionTokens,
            r.modelCall.latencyMs,
            r.modelCall.costUsd,
            r.modelCall.outcome,
          ) as { id: number })
        : null;
      const verdict = insertVerdict.get(
        id,
        constraint.id,
        r.verdict,
        r.decidedBy,
        r.decidedBy === "fallback" ? r.reason : null,
        JSON.stringify(r.evidence),
        call?.id ?? null,
      ) as { id: number } | undefined;
      if (!verdict) continue; // already stored: exactly once
      const reason =
        r.verdict !== "pass" ? r.verdict : samplePass() ? "sample" : null;
      if (reason) insertItem.run(verdict.id, done.lab_id, reason);
    }
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

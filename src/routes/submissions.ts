import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { authenticate, isMember } from "../auth.ts";
import { sendProblem } from "../problems.ts";
import { escapePointer, type FieldError } from "./publish.ts";

export const SUBMIT_BODY_LIMIT = 256 * 1024;
export const SOURCE_LIMIT = 64 * 1024; // bytes in UTF-8 (FAQ-05)
export const SUBMIT_NOTICE =
  "If this submission is Accepted, automatic rules and an AI model check it against the lab's constraints. The model receives your code without comments, name or student ID. No deduction reaches your mark until a TA has reviewed it.";

/** The body rules of docs/contract/submit.md, all errors at once. The size is checked later. */
export function validateSubmitBody(body: unknown): {
  errors: FieldError[];
  sourceCode?: string;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      errors: [{ pointer: "", message: "Body must be a JSON object." }],
    };
  }
  const fields = body as Record<string, unknown>;
  const errors: FieldError[] = Object.keys(fields)
    .filter((k) => k !== "sourceCode")
    .map((k) => ({
      pointer: `/${escapePointer(k)}`,
      message: "Unknown field.",
    }));
  const { sourceCode } = fields;
  if (typeof sourceCode !== "string" || sourceCode.trim() === "") {
    errors.push({
      pointer: "/sourceCode",
      message:
        "Required: a string with at least one character that is not whitespace.",
    });
  }
  return errors.length > 0
    ? { errors }
    : { errors, sourceCode: sourceCode as string };
}

export function registerSubmissions(
  app: FastifyInstance,
  db: DatabaseSync,
  now: () => Date,
) {
  const maxPending = Number(process.env.SUBMIT_MAX_PENDING) || 15;
  const maxPerMinute = Number(process.env.SUBMIT_MAX_PER_MINUTE) || 30;

  const findLab = db.prepare(`
    SELECT l.class_id, l.status, l.deadline, p.published_at
      FROM labs l LEFT JOIN publications p ON p.lab_id = l.id
     WHERE l.id = ?`);
  const countPending = db.prepare(
    "SELECT COUNT(*) AS n FROM submissions WHERE student_id = ? AND status IN ('queued', 'running')",
  );
  const recent = db.prepare(
    "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM submissions WHERE student_id = ? AND created_at > ?",
  );
  const insert = db.prepare(
    "INSERT INTO submissions (id, lab_id, student_id, source_code, created_at) VALUES (?, ?, ?, ?, ?)",
  );

  app.post<{ Params: { labId: string } }>(
    "/labs/:labId/submissions",
    { bodyLimit: SUBMIT_BODY_LIMIT },
    (request, reply) => {
      const { labId } = request.params;
      const instance = `/labs/${labId}/submissions`;
      const at = now();

      const user = authenticate(db, request.headers.authorization, at);
      if (!user) {
        return sendProblem(
          reply,
          "unauthenticated",
          instance,
          "Send a valid Bearer token.",
        );
      }
      if (user.role !== "student") {
        return sendProblem(
          reply,
          "role-not-allowed",
          instance,
          `Role ${user.role} cannot submit.`,
          { requiredRole: "student" },
        );
      }
      const lab = findLab.get(labId) as LabRow | undefined;
      // Same answer for "no such lab" and "not your class": ids of other classes must not leak.
      if (!lab || !isMember(db, user.id, lab.class_id)) {
        return sendProblem(
          reply,
          "lab-not-found",
          instance,
          "No lab with this id is in your classes.",
        );
      }

      const { errors, sourceCode } = validateSubmitBody(request.body);
      if (sourceCode === undefined) {
        return sendProblem(
          reply,
          "validation-failed",
          instance,
          "The body breaks the rules of the contract.",
          { errors },
        );
      }
      if (Buffer.byteLength(sourceCode, "utf8") > SOURCE_LIMIT) {
        return sendProblem(
          reply,
          "payload-too-large",
          instance,
          `The source is larger than ${SOURCE_LIMIT} bytes in UTF-8.`,
          { limitBytes: SOURCE_LIMIT },
        );
      }
      if (lab.status === "published") {
        return sendProblem(
          reply,
          "lab-published",
          instance,
          "This lab is published and takes no more submissions.",
          { publishedAt: lab.published_at },
        );
      }
      if (
        lab.deadline !== null &&
        new Date(lab.deadline).getTime() < at.getTime()
      ) {
        return sendProblem(
          reply,
          "deadline-passed",
          instance,
          "The deadline of this lab has passed.",
          { deadline: lab.deadline },
        );
      }

      const id = `sub-${randomUUID()}`;
      const createdAt = at.toISOString();
      // The limits and the insert in one transaction, so two requests cannot both pass the limit.
      db.exec("BEGIN IMMEDIATE");
      try {
        const pending = (countPending.get(user.id) as { n: number }).n;
        if (pending >= maxPending) {
          db.exec("ROLLBACK");
          return sendProblem(
            reply,
            "too-many-submissions",
            instance,
            `You already have ${pending} submissions waiting to be judged.`,
            { limit: "pending", max: maxPending },
          );
        }
        const windowStart = new Date(at.getTime() - 60_000).toISOString();
        const last = recent.get(user.id, windowStart) as {
          n: number;
          oldest: string | null;
        };
        if (last.n >= maxPerMinute && last.oldest !== null) {
          db.exec("ROLLBACK");
          const wait = Math.ceil(
            (new Date(last.oldest).getTime() + 60_000 - at.getTime()) / 1000,
          );
          reply.header("retry-after", String(Math.max(wait, 1)));
          return sendProblem(
            reply,
            "too-many-submissions",
            instance,
            `You made ${last.n} submissions in the last minute.`,
            { limit: "per-minute", max: maxPerMinute },
          );
        }
        insert.run(id, labId, user.id, sourceCode, createdAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return reply.code(202).header("location", `/submissions/${id}`).send({
        submissionId: id,
        labId,
        status: "queued",
        createdAt,
        notice: SUBMIT_NOTICE,
      });
    },
  );

  const findSubmission = db.prepare(`
    SELECT s.id, s.lab_id, s.student_id, s.status, s.judge_result, s.judge_detail,
           s.source_code, s.created_at, s.started_at, s.finished_at, l.class_id
      FROM submissions s JOIN labs l ON l.id = s.lab_id
     WHERE s.id = ?`);

  app.get<{ Params: { submissionId: string } }>(
    "/submissions/:submissionId",
    (request, reply) => {
      const { submissionId } = request.params;
      const instance = `/submissions/${submissionId}`;

      const user = authenticate(db, request.headers.authorization, now());
      if (!user) {
        return sendProblem(
          reply,
          "unauthenticated",
          instance,
          "Send a valid Bearer token.",
        );
      }
      if (user.role === "admin") {
        return sendProblem(
          reply,
          "role-not-allowed",
          instance,
          "An admin has no access to submissions.",
          { requiredRole: ["student", "ta"] },
        );
      }

      const row = findSubmission.get(submissionId) as SubmissionRow | undefined;
      const allowed =
        row !== undefined &&
        (user.role === "student"
          ? row.student_id === user.id
          : isMember(db, user.id, row.class_id));
      // Same answer for every cause: ids of other students' submissions must not leak.
      if (!row || !allowed) {
        return sendProblem(
          reply,
          "submission-not-found",
          instance,
          "No submission with this id is yours to read.",
        );
      }

      // Only the student-facing columns: never a verdict, a lease or a test's data.
      const judged = row.status === "judged";
      return reply.header("cache-control", "private, no-store").send({
        id: row.id,
        labId: row.lab_id,
        studentId: row.student_id,
        status: row.status,
        judgeResult: judged ? row.judge_result : null,
        judgeDetail:
          judged && row.judge_detail !== null
            ? (JSON.parse(row.judge_detail) as unknown)
            : null,
        sourceCode: row.source_code,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      });
    },
  );
}

interface SubmissionRow {
  id: string;
  lab_id: string;
  student_id: string;
  status: string;
  judge_result: string | null;
  judge_detail: string | null;
  source_code: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  class_id: string;
}

interface LabRow {
  class_id: string;
  status: string;
  deadline: string | null;
  published_at: string | null;
}

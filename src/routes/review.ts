import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { authenticate, isMember } from "../auth.ts";
import { sendProblem } from "../problems.ts";
import { escapePointer, type FieldError } from "./publish.ts";

export function registerReview(
  app: FastifyInstance,
  db: DatabaseSync,
  now: () => Date,
) {
  const findLab = db.prepare("SELECT class_id, status FROM labs WHERE id = ?");
  // The same three numbers Publish counts (ARCHITECTURE section 4.3).
  const summary = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM review_items WHERE lab_id = ? AND status = 'pending') AS pending_reviews,
      (SELECT COUNT(*) FROM submissions WHERE lab_id = ? AND status IN ('queued', 'running')) AS unjudged,
      (SELECT COUNT(*) FROM submissions WHERE lab_id = ? AND status = 'failed') AS failed`);
  const findConstraints = db.prepare(
    "SELECT code, text, kind, deduction FROM lab_constraints WHERE lab_id = ? ORDER BY id",
  );
  const findSubmissions = db.prepare(`
    SELECT s.id, s.student_id, u.display_name, s.status, s.judge_result, s.created_at,
           EXISTS (SELECT 1 FROM verdicts v JOIN review_items r ON r.verdict_id = v.id
                    WHERE v.submission_id = s.id AND r.status = 'pending') AS has_pending
      FROM submissions s JOIN users u ON u.id = s.student_id
     WHERE s.lab_id = ?
     ORDER BY s.created_at, s.id`);
  const findVerdicts = db.prepare(`
    SELECT v.submission_id, c.code, c.deduction, v.verdict, v.decided_by, v.reason_code,
           v.evidence, r.id AS item_id, r.reason, r.status, r.final_verdict, r.final_evidence,
           r.note, r.reviewed_by, r.reviewed_at
      FROM verdicts v
      JOIN submissions s ON s.id = v.submission_id
      JOIN lab_constraints c ON c.id = v.constraint_id
      LEFT JOIN review_items r ON r.verdict_id = v.id
     WHERE s.lab_id = ?
     ORDER BY c.id`);

  app.get<{
    Params: { labId: string };
    Querystring: Record<string, unknown>;
  }>("/labs/:labId/review-queue", (request, reply) => {
    const { labId } = request.params;
    const instance = `/labs/${labId}/review-queue`;

    const user = authenticate(db, request.headers.authorization, now());
    if (!user) {
      return sendProblem(
        reply,
        "unauthenticated",
        instance,
        "Send a valid Bearer token.",
      );
    }
    if (user.role !== "ta") {
      return sendProblem(
        reply,
        "role-not-allowed",
        instance,
        "Only a TA reads verdicts before Publish (FAQ-08).",
        { requiredRole: "ta" },
      );
    }

    // Fastify turns a repeated parameter into an array, so "true" twice is not "true".
    const query = request.query;
    const wrong =
      Object.keys(query).find((k) => k !== "pending") ??
      (query.pending !== undefined &&
      query.pending !== "true" &&
      query.pending !== "false"
        ? "pending"
        : undefined);
    if (wrong) {
      return sendProblem(
        reply,
        "invalid-query",
        instance,
        `The parameter ${wrong} is not allowed here.`,
        { parameter: wrong },
      );
    }

    const lab = findLab.get(labId) as
      { class_id: string; status: string } | undefined;
    // Same answer for "no such lab" and "not your class": ids of other classes must not leak.
    if (!lab || !isMember(db, user.id, lab.class_id)) {
      return sendProblem(
        reply,
        "lab-not-found",
        instance,
        "No lab with this id is in your classes.",
      );
    }

    const verdicts = new Map<string, unknown[]>();
    for (const v of findVerdicts.all(labId) as unknown as VerdictRow[]) {
      const list = verdicts.get(v.submission_id) ?? [];
      list.push({
        constraintCode: v.code,
        deduction: v.deduction,
        verdict: v.verdict,
        decidedBy: v.decided_by,
        reasonCode: v.reason_code,
        evidence: JSON.parse(v.evidence) as unknown,
        reviewItem:
          v.item_id === null
            ? null
            : {
                id: v.item_id,
                reason: v.reason,
                status: v.status,
                finalVerdict: v.final_verdict,
                finalEvidence:
                  v.final_evidence === null
                    ? null
                    : (JSON.parse(v.final_evidence) as unknown),
                note: v.note,
                reviewedBy: v.reviewed_by,
                reviewedAt: v.reviewed_at,
              },
      });
      verdicts.set(v.submission_id, list);
    }

    const onlyPending = query.pending === "true";
    const submissions = (
      findSubmissions.all(labId) as unknown as SubmissionRow[]
    )
      .filter((s) => !onlyPending || s.has_pending === 1)
      .map((s) => ({
        submissionId: s.id,
        studentId: s.student_id,
        studentName: s.display_name,
        status: s.status,
        judgeResult: s.judge_result,
        createdAt: s.created_at,
        // Only an accepted submission is checked against the constraints (FAQ-04).
        verdicts:
          s.status === "judged" && s.judge_result === "accepted"
            ? (verdicts.get(s.id) ?? [])
            : [],
      }));
    const counts = summary.get(labId, labId, labId) as {
      pending_reviews: number;
      unjudged: number;
      failed: number;
    };

    return reply.header("cache-control", "private, no-store").send({
      labId,
      labStatus: lab.status,
      summary: {
        submissions: submissions.length,
        pendingReviews: counts.pending_reviews,
        unjudgedSubmissions: counts.unjudged,
        failedSubmissions: counts.failed,
      },
      constraints: findConstraints.all(labId).map((c) => ({ ...c })),
      submissions,
    });
  });

  const findItem = db.prepare(`
    SELECT r.id, r.reason, r.status, r.final_verdict, r.final_evidence, r.note,
           r.reviewed_by, r.reviewed_at, r.lab_id, s.id AS submission_id, s.source_code,
           c.code, l.class_id, l.status AS lab_status, p.published_at
      FROM review_items r
      JOIN verdicts v ON v.id = r.verdict_id
      JOIN submissions s ON s.id = v.submission_id
      JOIN lab_constraints c ON c.id = v.constraint_id
      JOIN labs l ON l.id = r.lab_id
      LEFT JOIN publications p ON p.lab_id = l.id
     WHERE r.id = ?`);
  const storeDecision = db.prepare(`
    UPDATE review_items
       SET status = 'reviewed', final_verdict = ?, final_evidence = ?, note = ?,
           reviewed_by = ?, reviewed_at = ?
     WHERE id = ? AND status = 'pending'`);
  const countPending = db.prepare(
    "SELECT COUNT(*) AS n FROM review_items WHERE lab_id = ? AND status = 'pending'",
  );

  app.post<{ Params: { itemId: string } }>(
    "/review-items/:itemId/decision",
    { bodyLimit: DECISION_BODY_LIMIT },
    (request, reply) => {
      const { itemId } = request.params;
      const instance = `/review-items/${itemId}/decision`;
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
      if (user.role !== "ta") {
        return sendProblem(
          reply,
          "role-not-allowed",
          instance,
          "Only a TA decides a review item.",
          { requiredRole: "ta" },
        );
      }

      const found = /^[1-9]\d*$/.test(itemId)
        ? (findItem.get(Number(itemId)) as ItemRow | undefined)
        : undefined;
      // Same answer for "no such item" and "not your class": ids of other classes must not leak.
      if (!found || !isMember(db, user.id, found.class_id)) {
        return sendProblem(
          reply,
          "review-item-not-found",
          instance,
          "No review item with this id is in your classes.",
        );
      }

      const { errors, decision } = validateDecision(
        request.body,
        found.source_code,
      );
      if (!decision) {
        return sendProblem(
          reply,
          "validation-failed",
          instance,
          "The body breaks the rules of the contract.",
          { errors },
        );
      }

      // The state check and the write in one transaction, so Publish cannot run between them.
      db.exec("BEGIN IMMEDIATE");
      let item: ItemRow;
      let pending: number;
      try {
        item = findItem.get(found.id) as unknown as ItemRow;
        if (item.lab_status === "published") {
          db.exec("ROLLBACK");
          return sendProblem(
            reply,
            "lab-published",
            instance,
            "The lab is published: its review items are read-only.",
            { publishedAt: item.published_at },
          );
        }
        if (item.status === "reviewed") {
          db.exec("ROLLBACK");
          const same =
            item.final_verdict === decision.finalVerdict &&
            item.final_evidence === decision.finalEvidence &&
            item.note === decision.note;
          if (same) {
            return reply.send({
              reviewItem: itemView(item),
              pendingReviews: (countPending.get(item.lab_id) as { n: number })
                .n,
            });
          }
          return sendProblem(
            reply,
            "review-already-decided",
            instance,
            "This item is already decided, with another decision.",
            { reviewItem: itemView(item) },
          );
        }
        storeDecision.run(
          decision.finalVerdict,
          decision.finalEvidence,
          decision.note,
          user.id,
          at.toISOString(),
          item.id,
        );
        item = findItem.get(found.id) as unknown as ItemRow;
        pending = (countPending.get(item.lab_id) as { n: number }).n;
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return reply.send({
        reviewItem: itemView(item),
        pendingReviews: pending,
      });
    },
  );
}

export const DECISION_BODY_LIMIT = 64 * 1024;

interface Decision {
  finalVerdict: "pass" | "violation";
  /** JSON text as stored, null for a pass. */
  finalEvidence: string | null;
  note: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The body rules of docs/contract/review-decision.md, all errors at once. */
export function validateDecision(
  body: unknown,
  sourceCode: string,
): { errors: FieldError[]; decision?: Decision } {
  if (!isObject(body)) {
    return {
      errors: [{ pointer: "", message: "Body must be a JSON object." }],
    };
  }
  const errors: FieldError[] = [];
  const err = (pointer: string, message: string) =>
    errors.push({ pointer, message });
  for (const k of Object.keys(body)) {
    if (!["finalVerdict", "evidence", "note"].includes(k)) {
      err(`/${escapePointer(k)}`, "Unknown field.");
    }
  }

  const { finalVerdict, evidence, note } = body;
  if (finalVerdict !== "pass" && finalVerdict !== "violation") {
    err("/finalVerdict", 'Required: "pass" or "violation" (FAQ-09).');
  }

  const lines = sourceCode.split("\n").map((l) => l.replace(/\r$/, ""));
  const kept: { line: number; text: string }[] = [];
  if (evidence !== undefined && !Array.isArray(evidence)) {
    err("/evidence", "Must be an array of { line, text }.");
  } else {
    const list: unknown[] = evidence ?? [];
    if (list.length > 20) err("/evidence", "At most 20 lines.");
    if (finalVerdict === "violation" && list.length === 0) {
      err("/evidence", "A violation needs at least one evidence line.");
    }
    if (finalVerdict === "pass" && list.length > 0) {
      err("/evidence", "A pass has no evidence.");
    }
    list.forEach((e, i) => {
      const at = `/evidence/${i}`;
      if (!isObject(e)) return err(at, "Must be an object.");
      for (const k of Object.keys(e)) {
        if (k !== "line" && k !== "text") {
          err(`${at}/${escapePointer(k)}`, "Unknown field.");
        }
      }
      const { line, text } = e;
      const lineOk = Number.isInteger(line) && (line as number) >= 1;
      if (!lineOk) err(`${at}/line`, "An integer of at least 1.");
      if (typeof text !== "string") err(`${at}/text`, "Must be a string.");
      if (!lineOk || typeof text !== "string") return;
      const source = lines[(line as number) - 1];
      if (source === undefined) {
        err(`${at}/line`, `The source has ${lines.length} lines.`);
      } else if (source.trim() !== text.trim()) {
        err(`${at}/text`, "Does not match that line of the source.");
      } else {
        kept.push({ line: line as number, text });
      }
    });
  }

  if (
    note !== undefined &&
    note !== null &&
    (typeof note !== "string" || note.length > 1000)
  ) {
    err("/note", "A string of at most 1000 characters, or null.");
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    decision: {
      finalVerdict: finalVerdict as Decision["finalVerdict"],
      finalEvidence: finalVerdict === "violation" ? JSON.stringify(kept) : null,
      note: (note as string | null | undefined) ?? null,
    },
  };
}

function itemView(r: ItemRow) {
  return {
    id: r.id,
    submissionId: r.submission_id,
    constraintCode: r.code,
    reason: r.reason,
    status: r.status,
    finalVerdict: r.final_verdict,
    finalEvidence:
      r.final_evidence === null
        ? null
        : (JSON.parse(r.final_evidence) as unknown),
    note: r.note,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
  };
}

interface ItemRow {
  id: number;
  reason: string;
  status: string;
  final_verdict: string | null;
  final_evidence: string | null;
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  lab_id: string;
  submission_id: string;
  source_code: string;
  code: string;
  class_id: string;
  lab_status: string;
  published_at: string | null;
}

interface SubmissionRow {
  id: string;
  student_id: string;
  display_name: string;
  status: string;
  judge_result: string | null;
  created_at: string;
  has_pending: number;
}

interface VerdictRow {
  submission_id: string;
  code: string;
  deduction: number;
  verdict: string;
  decided_by: string;
  reason_code: string | null;
  evidence: string;
  item_id: number | null;
  reason: string | null;
  status: string | null;
  final_verdict: string | null;
  final_evidence: string | null;
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { authenticate, isMember } from "../auth.ts";
import { sendProblem } from "../problems.ts";

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

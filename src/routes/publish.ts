import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { authenticate, isMember } from "../auth.ts";
import { sendProblem } from "../problems.ts";

const KEY_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;
const NOTE_MAX = 500;

export interface FieldError {
  pointer: string;
  message: string;
}

export const escapePointer = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");

export function validatePublishBody(body: unknown): FieldError[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return [{ pointer: "", message: "Body must be a JSON object." }];
  }
  const fields = body as Record<string, unknown>;
  const errors: FieldError[] = Object.keys(fields)
    .filter((k) => k !== "confirm" && k !== "note")
    .map((k) => ({
      pointer: `/${escapePointer(k)}`,
      message: "Unknown field.",
    }));
  if (fields.confirm !== true) {
    errors.push({ pointer: "/confirm", message: "Required, must be true." });
  }
  if (
    fields.note !== undefined &&
    (typeof fields.note !== "string" || fields.note.length > NOTE_MAX)
  ) {
    errors.push({
      pointer: "/note",
      message: `Must be a string of at most ${NOTE_MAX} characters.`,
    });
  }
  return errors;
}

interface PublicationRow {
  published_at: string;
  published_by: string;
  marks_published: number;
  note: string | null;
}

const view = (labId: string, p: PublicationRow) => ({
  labId,
  status: "published",
  publishedAt: p.published_at,
  publishedBy: p.published_by,
  marksPublished: p.marks_published,
  note: p.note,
});

export function registerPublish(
  app: FastifyInstance,
  db: DatabaseSync,
  now: () => Date,
) {
  const findLab = db.prepare(
    "SELECT class_id, deadline FROM labs WHERE id = ?",
  );
  const findKey = db.prepare(
    "SELECT body_hash, status, body FROM idempotency_keys WHERE user_id = ? AND lab_id = ? AND idem_key = ?",
  );
  const storeKey = db.prepare(
    `INSERT INTO idempotency_keys (user_id, lab_id, idem_key, body_hash, status, body)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const findPublication = db.prepare(
    "SELECT published_at, published_by, marks_published, note FROM publications WHERE lab_id = ?",
  );
  // What blocks Publish (ARCHITECTURE section 4.3): the same numbers as the review queue.
  const blockers = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM review_items WHERE lab_id = ? AND status = 'pending') AS pending_reviews,
      (SELECT COUNT(*) FROM submissions WHERE lab_id = ? AND status IN ('queued', 'running')) AS unjudged,
      (SELECT COUNT(*) FROM submissions WHERE lab_id = ? AND status = 'failed') AS failed,
      (SELECT COUNT(*) FROM submissions WHERE lab_id = ? AND status = 'judged') AS judged`);
  const insertPublication = db.prepare(
    "INSERT INTO publications (lab_id, published_at, published_by, marks_published, note) VALUES (?, ?, ?, ?, ?)",
  );
  const closeLab = db.prepare(
    "UPDATE labs SET status = 'published' WHERE id = ?",
  );

  app.post<{ Params: { labId: string } }>(
    "/labs/:labId/publish",
    (request, reply) => {
      const { labId } = request.params;
      const instance = `/labs/${labId}/publish`;
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
          "forbidden-role",
          instance,
          `Role ${user.role} cannot publish.`,
        );
      }

      const lab = findLab.get(labId) as
        { class_id: string; deadline: string | null } | undefined;
      // Same answer for "no such lab" and "not your class": ids of other classes must not leak.
      if (!lab || !isMember(db, user.id, lab.class_id)) {
        return sendProblem(
          reply,
          "lab-not-found",
          instance,
          "No lab with this id in your classes.",
        );
      }

      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !KEY_FORMAT.test(key)) {
        return sendProblem(
          reply,
          "invalid-idempotency-key",
          instance,
          "Send Idempotency-Key: 1-64 characters from A-Z a-z 0-9 _ -.",
        );
      }

      const errors = validatePublishBody(request.body);
      if (errors.length > 0) {
        return sendProblem(
          reply,
          "validation-failed",
          instance,
          "See errors.",
          { errors },
        );
      }
      const note = (request.body as { note?: string }).note ?? null;
      const bodyHash = JSON.stringify({ confirm: true, note });

      const stored = findKey.get(user.id, labId, key) as
        { body_hash: string; status: number; body: string } | undefined;
      if (stored) {
        if (stored.body_hash !== bodyHash) {
          return sendProblem(
            reply,
            "idempotency-key-reused",
            instance,
            "This key was already used with a different body. Use a new key.",
          );
        }
        return reply
          .code(stored.status)
          .header("idempotent-replayed", "true")
          .type("application/json")
          .send(stored.body);
      }

      // The checks and the publication in one transaction: no submission can start or
      // finish judging, and no review item can be decided, between them.
      db.exec("BEGIN IMMEDIATE");
      let status = 200;
      let body: ReturnType<typeof view>;
      try {
        const existing = findPublication.get(labId) as
          PublicationRow | undefined;
        if (existing) {
          body = view(labId, existing);
        } else {
          if (
            lab.deadline !== null &&
            new Date(lab.deadline).getTime() >= at.getTime()
          ) {
            db.exec("ROLLBACK");
            return sendProblem(
              reply,
              "deadline-not-passed",
              instance,
              "The lab's deadline has not passed yet (FAQ-12).",
              { deadline: lab.deadline },
            );
          }
          const n = blockers.get(labId, labId, labId, labId) as {
            pending_reviews: number;
            unjudged: number;
            failed: number;
            judged: number;
          };
          const pendingCount = n.pending_reviews + n.unjudged + n.failed;
          if (pendingCount > 0) {
            db.exec("ROLLBACK");
            return sendProblem(
              reply,
              "reviews-pending",
              instance,
              `${n.pending_reviews} reviews are still pending, ${n.unjudged} submissions are still being judged and ${n.failed} failed to be judged.`,
              {
                pendingCount,
                pendingReviews: n.pending_reviews,
                unjudgedSubmissions: n.unjudged,
                failedSubmissions: n.failed,
              },
            );
          }
          const publication: PublicationRow = {
            published_at: at.toISOString(),
            published_by: user.id,
            marks_published: n.judged,
            note,
          };
          insertPublication.run(
            labId,
            publication.published_at,
            publication.published_by,
            publication.marks_published,
            publication.note,
          );
          closeLab.run(labId);
          body = view(labId, publication);
          status = 201;
        }
        // Only 2xx answers are stored, so a refused request can be retried with its key.
        storeKey.run(
          user.id,
          labId,
          key,
          bodyHash,
          status,
          JSON.stringify(body),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return reply.code(status).send(body);
    },
  );
}

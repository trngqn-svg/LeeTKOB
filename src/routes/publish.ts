import type { FastifyInstance } from "fastify";
import { sendProblem } from "../problems.ts";
import type { Lab, Store } from "../store.ts";

const KEY_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;
const NOTE_MAX = 500;

interface FieldError {
  pointer: string;
  message: string;
}

const escapePointer = (key: string) =>
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

const view = (lab: Lab) => ({
  labId: lab.id,
  status: "published",
  ...lab.publication,
});

export function registerPublish(app: FastifyInstance, store: Store) {
  app.post<{ Params: { labId: string } }>(
    "/labs/:labId/publish",
    (request, reply) => {
      const { labId } = request.params;
      const instance = `/labs/${labId}/publish`;

      const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const user = token ? store.usersByToken.get(token) : undefined;
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

      const lab = store.labs.get(labId);
      // Same answer for "no such lab" and "not your class": ids of other classes must not leak.
      if (!lab || !user.classIds.includes(lab.classId)) {
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

      const storeKey = JSON.stringify([user.id, lab.id, key]);
      const bodyHash = JSON.stringify({ confirm: true, note });
      const stored = store.idempotency.get(storeKey);
      if (stored) {
        if (stored.bodyHash !== bodyHash) {
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
          .send(stored.body);
      }

      let status = 200;
      if (!lab.publication) {
        if (lab.pendingReviews > 0) {
          return sendProblem(
            reply,
            "reviews-pending",
            instance,
            `${lab.pendingReviews} reviews in this lab are still pending.`,
            { pendingCount: lab.pendingReviews },
          );
        }
        // Synchronous check-then-set: one Node process cannot interleave two publishes here.
        lab.publication = {
          publishedAt: store.now().toISOString(),
          publishedBy: user.id,
          marksPublished: lab.judgedSubmissions,
          note,
        };
        status = 201;
      }

      const body = view(lab);
      store.idempotency.set(storeKey, { bodyHash, status, body });
      return reply.code(status).send(body);
    },
  );
}

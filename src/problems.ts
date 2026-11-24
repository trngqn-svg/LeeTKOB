import type { FastifyReply } from "fastify";

// RFC 9457 problem types; titles and statuses are fixed by the contracts in
// docs/contract/ (the list is in docs/ARCHITECTURE.md, section 6.5).
export const PROBLEMS = {
  "invalid-credentials": { status: 401, title: "Email or password is wrong" },
  "role-not-allowed": { status: 403, title: "Your role may not do this" },
  "class-not-found": { status: 404, title: "Class not found" },
  "payload-too-large": { status: 413, title: "Request body is too large" },
  "invalid-query": { status: 400, title: "Query parameter is invalid" },
  "unsupported-media-type": { status: 415, title: "Unsupported media type" },
  "validation-failed": { status: 422, title: "Request body is invalid" },
  unauthenticated: { status: 401, title: "Authentication required" },
  "forbidden-role": { status: 403, title: "Only TAs may publish marks" },
  "lab-not-found": { status: 404, title: "Lab not found" },
  "invalid-idempotency-key": {
    status: 400,
    title: "Idempotency-Key is missing or invalid",
  },
  "idempotency-key-reused": {
    status: 422,
    title: "Idempotency-Key reused with a different body",
  },
  "reviews-pending": { status: 409, title: "Reviews are still pending" },
  "deadline-not-passed": {
    status: 409,
    title: "The deadline has not passed yet",
  },
  "lab-published": { status: 409, title: "The lab is already published" },
  "deadline-passed": { status: 409, title: "The deadline has passed" },
  "too-many-submissions": { status: 429, title: "Too many submissions" },
  "submission-not-found": { status: 404, title: "Submission not found" },
  "review-item-not-found": { status: 404, title: "Review item not found" },
  "review-already-decided": {
    status: 409,
    title: "The review item is already decided",
  },
  internal: { status: 500, title: "Internal server error" },
} as const;

export type ProblemSlug = keyof typeof PROBLEMS;

export const PROBLEM_BASE = "https://leetkob.example/problems/";

export function sendProblem(
  reply: FastifyReply,
  slug: ProblemSlug,
  instance: string,
  detail: string,
  extra: Record<string, unknown> = {},
) {
  const { status, title } = PROBLEMS[slug];
  return reply
    .code(status)
    .type("application/problem+json")
    .send(
      JSON.stringify({
        type: PROBLEM_BASE + slug,
        title,
        status,
        detail,
        instance,
        ...extra,
      }),
    );
}

import type { FastifyReply } from "fastify";

// RFC 9457 problem types; titles and statuses are fixed by docs/contract/publish-lab.md.
export const PROBLEMS = {
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

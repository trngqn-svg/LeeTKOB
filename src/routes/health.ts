import type { FastifyInstance } from "fastify";

// Liveness probe for the deployment (PA#5); no auth, no data.
export function registerHealth(app: FastifyInstance) {
  app.get("/health", () => ({ status: "ok" }));
}

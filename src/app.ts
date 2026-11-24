import type { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { sendProblem } from "./problems.ts";
import { registerHealth } from "./routes/health.ts";
import { registerLabs } from "./routes/labs.ts";
import { registerLogin } from "./routes/login.ts";
import { registerPublish } from "./routes/publish.ts";
import { registerReview } from "./routes/review.ts";
import { registerSubmissions } from "./routes/submissions.ts";
import type { Store } from "./store.ts";

// shortcut: db is optional only because the /health test builds the app without one, and the
// store only carries the clock; make db required and pass `now` alone in a commit that may
// touch the tests' setup.
export function buildApp(store: Store, db?: DatabaseSync) {
  const app = Fastify({ logger: false });
  // Only JSON bodies are accepted; without this, text/plain would be parsed as a string.
  app.removeContentTypeParser("text/plain");

  app.setErrorHandler(
    (error: { code?: string; statusCode?: number }, request, reply) => {
      const instance = request.url.split("?")[0] ?? request.url;
      if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
        return sendProblem(
          reply,
          "unsupported-media-type",
          instance,
          "Send application/json.",
        );
      }
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        // Fastify refuses the body before reading it, so this comes before every check.
        const limitBytes =
          request.routeOptions.bodyLimit ?? app.initialConfig.bodyLimit;
        return sendProblem(
          reply,
          "payload-too-large",
          instance,
          `The body is larger than ${limitBytes} bytes.`,
          { limitBytes },
        );
      }
      if (error.statusCode === 400) {
        // Fastify's body parser: invalid or empty JSON.
        return sendProblem(
          reply,
          "validation-failed",
          instance,
          "Body is not valid JSON.",
          {
            errors: [{ pointer: "", message: "Body is not valid JSON." }],
          },
        );
      }
      return sendProblem(
        reply,
        "internal",
        instance,
        "Unexpected error. Retry with the same key.",
      );
    },
  );

  registerHealth(app);
  if (db) {
    registerLogin(app, db, store.now);
    registerLabs(app, db, store.now);
    registerSubmissions(app, db, store.now);
    registerReview(app, db, store.now);
    registerPublish(app, db, store.now);
  }
  return app;
}

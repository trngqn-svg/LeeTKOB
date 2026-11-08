import Fastify from "fastify";
import { sendProblem } from "./problems.ts";
import { registerPublish } from "./routes/publish.ts";
import type { Store } from "./store.ts";

export function buildApp(store: Store) {
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

  registerPublish(app, store);
  return app;
}

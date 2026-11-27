window.addEventListener("DOMContentLoaded", () => {
  window.SwaggerUIBundle({
    url: "./openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    presets: [
      window.SwaggerUIBundle.presets.apis,
      window.SwaggerUIStandalonePreset,
    ],
    layout: "StandaloneLayout",
  });
});

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
    // No badge from validator.swagger.io: the page's CSP allows images from our own
    // host only, so the badge would be blocked and show as a broken image.
    validatorUrl: null,
  });
});

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // leetkob-eval is the lecturer's published dev set: it must stay byte for byte as published.
  { ignores: ["node_modules", "coverage", "leetkob-eval/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The Swagger UI page (docs/swagger/) runs in the browser, where `window` exists.
  {
    files: ["docs/swagger/**/*.js"],
    languageOptions: { globals: { window: "readonly" } },
  },
);

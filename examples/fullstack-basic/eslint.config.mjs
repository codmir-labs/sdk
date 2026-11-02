// Lint config for the example only; the repo's `npm run lint` covers src/. Run: npx eslint --config examples/fullstack-basic/eslint.config.mjs examples/fullstack-basic (from the repo root).
import js from "@eslint/js";

const nodeAndWeb = {
  process: "readonly", console: "readonly", fetch: "readonly", setTimeout: "readonly", Buffer: "readonly",
  URL: "readonly", Uint8Array: "readonly", document: "readonly", window: "readonly",
};

export default [
  { ignores: ["**/node_modules/**", "**/captures/**", "**/public/build/**"] },
  js.configs.recommended,
  { rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
  { languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: nodeAndWeb } },
];

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "no-case-declarations": "warn",
      "no-empty": "warn",
      "no-empty-pattern": "warn",
      "no-useless-escape": "warn",
      "no-useless-catch": "warn",
      "no-constant-condition": "warn",
      "no-control-regex": "warn",
      "no-prototype-builtins": "warn",
      "no-misleading-character-class": "warn",
      "prefer-const": "warn",
    },
  }
);

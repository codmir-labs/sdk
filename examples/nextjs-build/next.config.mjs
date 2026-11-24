import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default {
  // The smoke is about bundling. The repo's ESLint config is for src/, so `next build` does not lint this app with it.
  eslint: { ignoreDuringBuilds: true },
  // The SDK is linked from the repo root (`file:../..`), so file tracing starts there.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "../.."),
};

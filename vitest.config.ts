import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Same injection as tsup.config.ts, so tests see the version a build would report (CSL-5589).
export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(version) },
});

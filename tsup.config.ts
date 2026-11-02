import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Entry points and formats come from the package.json scripts; this file only injects the version (CSL-5589).
export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(version) },
});

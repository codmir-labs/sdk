import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Entry points and formats come from the package.json scripts; this file only injects the version (CSL-5589).
// nanoid 5 is ESM-only, so an external `require("nanoid")` in the CJS output throws ERR_REQUIRE_ESM on Node 18 and
// on 20 before 20.19. Bundling it keeps `require("@codmir/sdk")` working on every supported Node (CSL-5375).
export default defineConfig({
  noExternal: ["nanoid"],
  define: { __SDK_VERSION__: JSON.stringify(version) },
});

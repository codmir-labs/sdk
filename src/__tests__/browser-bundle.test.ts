/**
 * CSL-5616: a browser bundler must be able to bundle `@codmir/sdk/browser` and `@codmir/sdk/replay` from the built
 * dist. tsup once inlined nanoid's Node build into their shared chunk (`import "crypto"`, `Buffer`), so esbuild
 * with `platform: "browser"` failed with `Could not resolve "crypto"`. Needs `npm run build` first (CI builds before test).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { generateId } from "../id";

const dist = new URL("../../dist/", import.meta.url);
const hasDist = existsSync(new URL("browser/index.js", dist)) && existsSync(new URL("replay/index.js", dist));

describe("generateId", () => {
  it("is 21 characters of the URL-safe alphabet and does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it("honours a size", () => {
    expect(generateId(8)).toHaveLength(8);
  });
});

describe.skipIf(!hasDist)("browser bundles of the built dist", () => {
  for (const entry of ["browser/index.js", "replay/index.js"]) {
    it(`esbuild bundles ${entry} for the browser with no Node crypto or Buffer`, async () => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL(entry, dist))],
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        logLevel: "silent",
      });
      expect(result.errors).toEqual([]);
      const code = result.outputFiles.map((f) => f.text).join("\n");
      expect(code).not.toMatch(/from\s*["'](node:)?crypto["']/);
      expect(code).not.toMatch(/\bBuffer\b/);
    });
  }
});

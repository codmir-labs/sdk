/**
 * CSL-5612: rrweb is loaded only by `@codmir/sdk/replay`. The root, /browser, /nextjs and /overseer bundles
 * (and every chunk they import) must not mention it. Needs `npm run build` first; CI runs this after the build.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../../../dist/", import.meta.url));
const hasDist = existsSync(join(dist, "replay/index.js")) && existsSync(join(dist, "index.js"));

/** The entry file plus every relative file it imports or requires, transitively. */
function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const m of text.matchAll(/(?:from\s*|import\s*\(?\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      queue.push(join(dirname(file), m[1]));
    }
  }
  return seen;
}

describe.skipIf(!hasDist)("rrweb stays out of every entry but /replay (built dist)", () => {
  const entries = ["index", "browser/index", "nextjs/index", "overseer/index"];

  for (const entry of entries) {
    for (const ext of ["js", "cjs"]) {
      it(`${entry}.${ext} and its chunks do not mention rrweb`, () => {
        const files = reachable(join(dist, `${entry}.${ext}`));
        expect(files.size).toBeGreaterThan(0);
        const offenders = [...files].filter(([, text]) => /rrweb/i.test(text)).map(([f]) => f);
        expect(offenders).toEqual([]);
      });
    }
  }

  it("/replay does load it (the check above can fail)", () => {
    const files = reachable(join(dist, "replay/index.js"));
    expect([...files.values()].some((text) => text.includes("@rrweb/record"))).toBe(true);
  });
});

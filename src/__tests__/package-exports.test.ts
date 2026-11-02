import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, unknown>;
  files: string[];
  scripts: Record<string, string>;
};

function leafFiles(node: unknown): string[] {
  if (typeof node === "string") return [node];
  return Object.values(node as Record<string, unknown>).flatMap(leafFiles);
}

// CSL-5590: @codmir/sdk is the error, tracing and replay SDK. Agent, council, serverless and runtime
// code lives in the private @codmir/agent-kit workspace and must not leak back into the published exports.
const CORE_SUBPATHS = [
  ".",
  "./client",
  "./types",
  "./overseer",
  "./tracing",
  "./nextjs",
  "./nextjs/server",
  "./react-native",
  "./browser",
  "./replay",
  "./express",
  "./hono",
  "./remix",
  "./remix/server",
  "./verify",
  "./report",
];

describe("@codmir/sdk package exports", () => {
  it("lists only the core subpaths", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([...CORE_SUBPATHS].sort());
  });

  it("publishes only dist, README and LICENSE", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
  });

  it("points every export at dist output", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      for (const file of leafFiles(target)) {
        expect(file, subpath).toMatch(/^\.\/dist\//);
      }
    }
  });

  // CSL-5601: the published 2.0.1 shipped 0 declarations because `build` had no --dts.
  it("builds with --dts so the declarations exist", () => {
    expect(pkg.scripts.build).toContain("--dts");
  });

  it("declares types for both the import and require condition, each next to its code", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const cond = target as Record<string, { types: string; default: string }>;
      expect(cond.import.types, subpath).toBe(cond.import.default.replace(/\.js$/, ".d.ts"));
      expect(cond.require.types, subpath).toBe(cond.require.default.replace(/\.cjs$/, ".d.cts"));
    }
  });
});

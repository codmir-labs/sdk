import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, unknown>;
  files: string[];
};

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
      for (const file of Object.values(target as Record<string, string>)) {
        expect(file, subpath).toMatch(/^\.\/dist\//);
      }
    }
  });
});

/**
 * The shape a browser bundle has: the bundler replaces the literal `process.env.NODE_ENV` and defines no `process`
 * global. The detection module is bundled by esbuild and the output runs in a context with no `process`.
 */
import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";

type Detect = {
  detectEnvironment(): string;
  detectRelease(): string;
  detectNextClientHost(): { release: string; environment: string };
};

function bundled(define: Record<string, string>): Detect {
  const out = buildSync({
    entryPoints: ["src/overseer/detect.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "Detect",
    define,
  });
  return runInNewContext(`${out.outputFiles[0].text}; Detect`, {}) as Detect;
}

describe("detection in a bundle with no process global", () => {
  it("reads the inlined NODE_ENV and leaves the release empty", () => {
    const d = bundled({ "process.env.NODE_ENV": '"production"' });
    expect(d.detectEnvironment()).toBe("production");
    expect(d.detectRelease()).toBe("");
  });

  it("gives empty values and does not throw when nothing is inlined", () => {
    // esbuild's browser platform inlines NODE_ENV="development" on its own; pinning it to undefined is "no define".
    const d = bundled({ "process.env.NODE_ENV": "undefined" });
    expect(d.detectEnvironment()).toBe("");
    expect(d.detectRelease()).toBe("");
    expect(d.detectNextClientHost()).toEqual({ release: "", environment: "" });
  });

  it("picks up the inlined Next.js client variables, each on its own", () => {
    const d = bundled({ "process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA": '"abc1234"' });
    expect(d.detectNextClientHost()).toEqual({ release: "abc1234", environment: "" });
    const both = bundled({
      "process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA": '" abc1234 "',
      "process.env.NEXT_PUBLIC_VERCEL_ENV": '"preview"',
    });
    expect(both.detectNextClientHost()).toEqual({ release: "abc1234", environment: "preview" });
  });
});

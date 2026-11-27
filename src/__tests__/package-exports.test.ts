import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, unknown>;
  files: string[];
  peerDependencies?: Record<string, string>;
  scripts: Record<string, string>;
};

function leafFiles(node: unknown): string[] {
  if (typeof node === "string") return [node];
  return Object.values(node as Record<string, unknown>).flatMap(leafFiles);
}

// @codmir/sdk is the error, tracing and replay SDK. Agent, council, serverless and runtime
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
  "./logs",
  "./logs/node",
  "./logs/parse",
  "./express",
  "./hono",
  "./remix",
  "./remix/server",
  "./verify",
  "./report",
  "./feedback",
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

  // The published 2.0.1 shipped 0 declarations because `build` had no --dts.
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

  // Releases go through the release job of the CI workflow (semantic-release): a version below npm `latest` is refused
  // there. A script that runs `npm publish` by hand would skip that check.
  it("has no script that publishes to npm by hand", () => {
    const PUBLISH = /\b(?:npm|pnpm|yarn)\s+publish\b/;
    for (const [name, command] of Object.entries(pkg.scripts)) expect(command, `package.json script ${name}`).not.toMatch(PUBLISH);
    const files = (dir: URL): URL[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)],
      );
    for (const file of files(new URL("../../scripts/", import.meta.url))) {
      expect(readFileSync(file, "utf8"), file.pathname).not.toMatch(PUBLISH);
    }
  });

  // npm 7 and later checks an optional peer's range whenever the app has that package, so a peer the code never loads
  // only stops installs (React 17, Next.js 14). Skips without a build.
  it.skipIf(!existsSync(new URL("../../dist/index.js", import.meta.url)))("loads every peer dependency from some file under dist", () => {
    const dist = new URL("../../dist/", import.meta.url);
    const walk = (dir: URL): URL[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)],
      );
    const code = walk(dist)
      .filter((file) => /\.(?:c?js|mjs|d\.c?ts)$/.test(file.pathname))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const unused = Object.keys(pkg.peerDependencies ?? {}).filter((peer) => {
      const name = peer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`(?:\\bfrom\\s*|\\brequire\\(\\s*|\\bimport\\(\\s*)["']${name}(?:/[^"']*)?["']`).test(code);
    });
    expect(unused, "peer dependencies no file under dist loads").toEqual([]);
  });
});

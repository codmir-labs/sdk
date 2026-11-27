import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Loaded the way semantic-release loads it: by Node's own CommonJS loader, not by Vite's transform.
const { analyzeCommits, exportKeys } = createRequire(import.meta.url)("./export-guard.cjs");
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));

const REMOVED = ["./serverless", "./council", "./runtime", "./runtime/protocol", "./agent", "./mcp", "./ai"];
const KEPT = [".", "./client", "./overseer"];

const root = mkdtempSync(join(tmpdir(), "export-guard-"));
let counter = 0;

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}

function exportsOf(keys) {
  return Object.fromEntries(keys.map((key) => [key, { import: `./dist/${key}.js` }]));
}

// A scratch repo whose tag v1.0.0 holds a package.json with `tagKeys` and whose working tree holds `nowKeys`.
function repo(tagKeys, nowKeys) {
  const cwd = join(root, `repo-${counter++}`);
  mkdirSync(cwd);
  git(cwd, "init", "-q");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo", exports: exportsOf(tagKeys) }));
  git(cwd, "add", "package.json");
  git(cwd, "commit", "-q", "-m", "feat: first");
  git(cwd, "tag", "v1.0.0");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo", exports: exportsOf(nowKeys) }));
  git(cwd, "commit", "-q", "--allow-empty", "-am", "refactor: move code");
  return cwd;
}

function run(cwd, lastRelease = { gitTag: "v1.0.0" }) {
  const lines = [];
  const result = analyzeCommits({}, { cwd, lastRelease, logger: { log: (line) => lines.push(line) } });
  return { result, lines };
}

describe("analyzeCommits", () => {
  it("returns major and names all seven keys when they are gone", () => {
    const { result, lines } = run(repo([...KEPT, ...REMOVED], KEPT));
    expect(result).toBe("major");
    expect(lines).toHaveLength(1);
    for (const key of REMOVED) expect(lines[0], key).toContain(key);
    expect(lines[0]).toContain("v1.0.0");
  });

  it("does not name a key that is still exported", () => {
    const { lines } = run(repo([...KEPT, ...REMOVED], KEPT));
    expect(lines[0]).not.toMatch(/\.\/client|\.\/overseer/);
  });

  it("returns major for a single removed key", () => {
    expect(run(repo([...KEPT, "./mcp"], KEPT)).result).toBe("major");
  });

  it("returns null when the same keys are exported", () => {
    expect(run(repo(KEPT, KEPT)).result).toBeNull();
  });

  it("returns null when keys were only added", () => {
    expect(run(repo(KEPT, [...KEPT, "./new"])).result).toBeNull();
  });

  it("returns null with no last release, and says why", () => {
    const cwd = repo(KEPT, []);
    for (const lastRelease of [{}, null]) {
      const { result, lines } = run(cwd, lastRelease);
      expect(result).toBeNull();
      expect(lines).toEqual(["No last release, so there is no export to compare against"]);
    }
  });

  it("returns null when the tag cannot be read, and says why", () => {
    const cwd = repo([...KEPT, ...REMOVED], KEPT);
    const { result, lines } = run(cwd, { gitTag: "v9.9.9" });
    expect(result).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Could not read the exports of package.json at v9.9.9");
  });

  it("returns null when the tag has no package.json", () => {
    const cwd = join(root, `repo-${counter++}`);
    mkdirSync(cwd);
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "README.md"), "x");
    git(cwd, "add", "README.md");
    git(cwd, "commit", "-q", "-m", "feat: first");
    git(cwd, "tag", "v1.0.0");
    expect(run(cwd).result).toBeNull();
  });
});

describe("exportKeys", () => {
  it("lists the keys of an object, and none for a string or a missing field", () => {
    expect(exportKeys(JSON.stringify({ exports: exportsOf(KEPT) }))).toEqual(KEPT);
    expect(exportKeys(JSON.stringify({ exports: "./index.js" }))).toEqual([]);
    expect(exportKeys("{}")).toEqual([]);
  });
});

describe("release.plugins", () => {
  it("lists the guard right after the commit-analyzer", () => {
    const names = packageJson.release.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    const analyzer = names.indexOf("@semantic-release/commit-analyzer");
    expect(analyzer).toBeGreaterThanOrEqual(0);
    expect(names[analyzer + 1]).toBe("./.github/release/export-guard.cjs");
  });
});

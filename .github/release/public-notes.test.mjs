import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Loaded the way semantic-release loads them: by Node's own loader, not by Vite's transform.
const require = createRequire(import.meta.url);
const plugin = require("./public-notes.cjs");
const changelog = require("@semantic-release/changelog");
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
const CLI = fileURLToPath(new URL("../../scripts/check-public-words.mjs", import.meta.url));

// Tracker-shaped keys are built from parts, and the private word is made up and passed as a hash, so that this file
// passes the check it tests.
const key = (n) => ["QQQ", n].join("-");
const hashOf = (word) => createHash("sha256").update(word.toLowerCase()).digest("hex").slice(0, 16);
const PRIVATE = "zork-private";
const extraHashes = [hashOf(PRIVATE)];

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HISTORY = "## [1.0.2](https://github.com/example/repo/compare/v1.0.1...v1.0.2) (2025-01-01)\n\n### Bug Fixes\n\n* an old fix\n";
const UNRELEASED = "## Unreleased\n\n### Features\n\n* **feedback:** a visitor reads what became of their feedback.\n\n### Bug Fixes\n\n* **overseer:** events are sent under steady load.\n";

function project(changelogText) {
  const cwd = mkdtempSync(join(tmpdir(), "public-notes-"));
  made.push(cwd);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.1" }));
  if (changelogText !== undefined) writeFileSync(join(cwd, "CHANGELOG.md"), changelogText);
  return cwd;
}

const commit = (hash, message) => ({ hash, message, commit: { short: hash.slice(0, 7), long: hash } });
const logs = [];
const logger = { log: (...args) => logs.push(args.join(" ")), error: () => {}, warn: () => {} };

function context(cwd, commits, notes) {
  return {
    cwd,
    logger,
    commits,
    lastRelease: { gitTag: "v2.0.1", version: "2.0.1" },
    nextRelease: { gitTag: "v2.1.0", version: "2.1.0", type: "minor", ...(notes === undefined ? {} : { notes }) },
    options: { repositoryUrl: "https://github.com/example/repo.git" },
  };
}

const hitsIn = (text) => spawnSync(process.execPath, [CLI, "--extra-hashes", extraHashes.join(",")], { cwd: text, encoding: "utf8" });

function wordsHits(notes) {
  const dir = mkdtempSync(join(tmpdir(), "public-notes-words-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "notes.md"), notes);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return hitsIn(dir).stdout.split("\n").filter(Boolean);
}

const sha = (n) => String(n).repeat(40).slice(0, 40);
const synthetic = [
  commit(sha(1), `feat(feedback): visitors see what became of their feedback (${key("1234")}, 1235-1237) [skip ci] (#10)`),
  commit(sha(2), `fix(overseer): events are sent under steady load (#11) [skip ci]`),
  commit(sha(3), `fix(agent-kit): the private package keeps its own state (#12)`),
  commit(sha(4), `fix(agent-kit, browser): one line for two scopes (#13)`),
  commit(sha(5), `fix(express): handle ${key("5678")} errors once [skip ci]`),
  commit(sha(6), `docs(agent-kit): only private words here (#14)`),
  commit(sha(7), `fix(agent): a change to the private package (${key("2001")}, ${key("2002")}) (#15)`),
  commit(sha(8), `fix(browser): ranges and lists (${key("3001")}..3003, ${key("3004")} and ${key("3005")}) (#16)`),
];

describe("generateNotes", () => {
  it("(a) takes the Unreleased section as the notes, under the generator's version heading", async () => {
    const cwd = project(`${UNRELEASED}\n${HISTORY}`);
    const notes = await plugin.generateNotes({}, context(cwd, synthetic));
    const [heading, ...body] = notes.split("\n");
    expect(heading).toBe("# [2.1.0](https://github.com/example/repo/compare/v2.0.1...v2.1.0) (" + heading.slice(-11, -1) + ")");
    expect(body.join("\n")).toBe(`\n${UNRELEASED.split("\n").slice(2).join("\n").trim()}\n`);
    expect(notes).not.toContain("visitors see what became"); // nothing from the commit subjects
  });

  it("(a) the section is gone from the rewritten CHANGELOG, and the release is written once, newest first", async () => {
    const cwd = project(`${UNRELEASED}\n${HISTORY}`);
    const notes = await plugin.generateNotes({}, context(cwd, synthetic));
    const prepared = { ...context(cwd, synthetic, notes) };
    await plugin.prepare({}, prepared);
    await changelog.prepare({ changelogFile: "CHANGELOG.md" }, prepared);
    const file = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    expect(file).not.toMatch(/unreleased/i);
    expect(file.match(/^#{1,2} .*$/gm)).toEqual([notes.split("\n")[0], HISTORY.split("\n")[0]]);
    expect(file.split("a visitor reads what became").length).toBe(2);
    expect(file.endsWith(HISTORY)).toBe(true);
  });

  it("keeps the notes it made when semantic-release asks again after a commit", async () => {
    const cwd = project(`${UNRELEASED}\n${HISTORY}`);
    const notes = await plugin.generateNotes({}, context(cwd, synthetic));
    await plugin.prepare({}, context(cwd, synthetic, notes)); // the section is gone from the file now
    expect(await plugin.generateNotes({}, context(cwd, synthetic, notes))).toBe(notes);
  });

  it("(b) without an Unreleased section, the generated notes hold no key, no [skip ci] and no agent-kit line", async () => {
    for (const text of [HISTORY, `## Unreleased\n\n${HISTORY}`, undefined]) {
      const notes = await plugin.generateNotes({ extraHashes }, context(project(text), synthetic));
      expect(wordsHits(notes)).toEqual([]);
      expect(notes).not.toMatch(/agent-kit/);
      expect(notes).not.toMatch(/skip ci/i);
      expect(notes).not.toContain("QQQ");
      expect(notes).toContain("**feedback:** visitors see what became of their feedback ([#10]");
      expect(notes).toContain("**browser:** one line for two scopes");
      expect(notes).toContain("**express:** handle errors once");
      expect(notes).not.toMatch(/\(#\d+\)/); // the linked `([#N](...))` stays, the plain duplicate goes
      expect(notes).not.toMatch(/\(\s*\)|\(,\)|\(\.\./);
      expect(notes).toContain("**browser:** ranges and lists ([#16]");
      expect(notes).not.toContain("a change to the private package");
      expect(notes).not.toMatch(/### Documentation/); // its only line was a private scope
    }
  });

  it("(c) stops on a private word, naming the line and not the word", async () => {
    const cwd = project(`## Unreleased\n\n### Features\n\n* a plain line\n* mentions ${PRIVATE} here\n\n${HISTORY}`);
    const before = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    const failure = await plugin.generateNotes({ extraHashes }, context(cwd, synthetic)).catch((error) => error);
    expect(failure).toMatchObject({ code: "EPUBLICWORDS", name: "SemanticReleaseError" });
    expect(failure.details).toContain("release notes:6: private-word");
    expect(failure.details).not.toContain(PRIVATE);
    expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(before);
  });

  it("(c) prepare stops on a hit and writes nothing", async () => {
    const cwd = project(`${UNRELEASED}\n${HISTORY}`);
    const before = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    const notes = `# [2.1.0]\n\n* mentions ${PRIVATE} and ${key("4321")}\n`;
    const failure = await plugin.prepare({ extraHashes }, context(cwd, synthetic, notes)).catch((error) => error);
    expect(failure).toMatchObject({ code: "EPUBLICWORDS" });
    expect(failure.details).toContain("release notes:3: ticket-key");
    expect(failure.details).toContain("release notes:3: private-word");
    expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(before);
    expect(readdirSync(cwd).sort()).toEqual(["CHANGELOG.md", "package.json"]);
  });

  it("(c) a key left in the Unreleased section stops the release too", async () => {
    const cwd = project(`## Unreleased\n\n* see ${key("9999")}\n\n${HISTORY}`);
    await expect(plugin.generateNotes({}, context(cwd, synthetic))).rejects.toMatchObject({ code: "EPUBLICWORDS" });
  });
});

describe("splitUnreleased", () => {
  it("ends the section at the next level 1 or 2 heading, not at a ### heading or inside a fence", () => {
    const text = "# Changelog\n\n## Unreleased\n\n### Features\n\n```\n## not a heading\n```\n\ntext\n\n# [2.0.0]\n\nold\n";
    const { found, content, rest } = plugin.splitUnreleased(text);
    expect(found).toBe(true);
    expect(content).toBe("### Features\n\n```\n## not a heading\n```\n\ntext");
    expect(rest).toBe("# Changelog\n\n# [2.0.0]\n\nold\n");
  });

  it("finds nothing when there is no such heading, or an empty section", () => {
    expect(plugin.splitUnreleased(HISTORY)).toEqual({ found: false, content: "", rest: HISTORY });
    expect(plugin.splitUnreleased(`## Unreleased\n\n${HISTORY}`)).toMatchObject({ found: true, content: "" });
  });
});

describe("package.json", () => {
  it("lists the plugin where the notes generator was, above the changelog plugin", () => {
    const names = packageJson.release.plugins.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
    expect(names).toContain("./.github/release/public-notes.cjs");
    expect(names).not.toContain("@semantic-release/release-notes-generator");
    expect(names.indexOf("./.github/release/public-notes.cjs")).toBeLessThan(names.indexOf("@semantic-release/changelog"));
    expect(names.indexOf("./.github/release/public-notes.cjs")).toBeGreaterThan(names.indexOf("./.github/release/no-downgrade.cjs"));
  });
});

describe("check-public-words, after the rules moved to a module", () => {
  it("(d) prints the same lines as before for the same input", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-notes-cli-"));
    made.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), `// ok UTF-8 SHA-256\n// fixes ${key("1234")}\nconst x = "${PRIVATE}";\n// ${["jane", "corp.io"].join("@")}\n`);
    writeFileSync(join(dir, `${key("77")}.md`), "fine\n");
    writeFileSync(join(dir, "b.md"), `<!-- public-${"words"}: allow ticket-key a reason -->\n${key("1234")}\n# public-${"words"}: allow private-word\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const run = hitsIn(dir);
    expect(run.status).toBe(1);
    expect(run.stdout.split("\n").filter(Boolean)).toEqual([
      `${key("77")}.md:0: ticket-key`,
      "b.md:3: allow-without-reason",
      "src/a.ts:2: ticket-key",
      "src/a.ts:3: private-word",
      "src/a.ts:4: person-email",
    ]);
    expect(run.stderr).toBe("5 hits: the repository holds public words only (see CONTRIBUTING.md)\n");
  });
});

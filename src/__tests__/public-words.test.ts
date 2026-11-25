import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// scripts/check-public-words.mjs run on small git repositories made here. The words are made up; their hashes are
// passed with --extra-hashes, so no real private word is needed. Keys and addresses are built from parts so that
// this file passes the check itself.
const SCRIPT = fileURLToPath(new URL("../../scripts/check-public-words.mjs", import.meta.url));
const hashOf = (word: string) => createHash("sha256").update(word.toLowerCase()).digest("hex").slice(0, 16);
const PRIVATE = ["zork-private", "quux"];
const HASHES = PRIVATE.map(hashOf).join(",");
const KEY = ["ZZZ", "1234"].join("-");
const ALLOW = "public-" + "words: allow ";
const address = (local: string, domain: string) => `${local}@${domain}`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Files = Record<string, string | Buffer>;

function repo(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), "public-words-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function check(files: Files, args: string[] = ["--extra-hashes", HASHES]) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo(files), encoding: "utf8" });
  return { code: run.status, hits: run.stdout.split("\n").filter(Boolean), all: run.stdout + run.stderr };
}

describe("check-public-words", () => {
  it("passes a clean repository, with a standard's name that looks like a key", () => {
    const run = check({
      "a.ts": "// UTF-8, SHA-256, ISO-8601, RFC-2606 and AES-256\nexport const x = 1;\n",
      "README.md": `Mail ${address("hello", "codmir.com")} or ${address("jane", "example.com")}.\n`,
    });
    expect(run).toMatchObject({ code: 0, hits: [] });
  });

  it("ticket-key: file, line and rule", () => {
    const run = check({ "src/a.ts": `const a = 1;\n// fixes ${KEY}\n`, "b.md": "fine\n" });
    expect(run.code).toBe(1);
    expect(run.hits).toEqual(["src/a.ts:2: ticket-key"]);
    expect(run.all).not.toContain(KEY);
  });

  it("ticket-key: only a whole word counts", () => {
    const run = check({ "a.ts": `// x${KEY} ${KEY}9999999 lower-1234\n// ${KEY}\n` });
    expect(run.hits).toEqual(["a.ts:2: ticket-key"]);
  });

  it("private-word: the word, inside a longer token, with another case, as a part, and the word is never printed", () => {
    const run = check({
      "a.ts": [
        "// zork-private",
        "// x-zork-private-y",
        "// zork-private.example",
        "// ZORK-PRIVATE",
        "// a_zork_private_b",
        "// x-quux-y",
        "// quux.example",
        "// QUUX",
        "// zork private, zorkprivate, zork-privately, quuxes",
      ].join("\n"),
    });
    expect(run.code).toBe(1);
    expect(run.hits).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `a.ts:${n}: private-word`));
    expect(run.all).not.toMatch(/zork|quux/i);
    expect(run.all).not.toContain(hashOf("zork-private"));
  });

  it("private-word: --hash prints the hash of a lower-cased word", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--hash", "Zork-Private"], { encoding: "utf8" });
    expect(run.stdout.trim()).toBe(hashOf("zork-private"));
    expect(run.status).toBe(0);
  });

  it("person-email: an address of a person hits, an address made for examples and the role address do not", () => {
    const run = check({
      "a.ts": [
        `// ${address("bob", "acme-corp.io")}`,
        `// ${address("a", "b.test")} ${address("a", "mail.example.org")} ${address("a", "x.invalid")} ${address("a", "localhost")}`,
        `// ${address("12345+me", "users.noreply.github.com")} ${address("a", "anthropic.com")} ${address("hello", "codmir.com")}`,
        `// ${address("jo", "codmir.com")}`,
        "// pkg@1.2.3 and @scope/pkg@latest",
      ].join("\n"),
    });
    expect(run.hits).toEqual(["a.ts:1: person-email", "a.ts:4: person-email"]);
    expect(run.all).not.toContain("acme-corp");
  });

  it("an exception with a reason passes, one without a reason fails", () => {
    const run = check({
      "ok.ts": `// ${ALLOW}ticket-key a fixture shaped like a key\nconst a = "${KEY}";\n`,
      "bad.ts": `// ${ALLOW}ticket-key\nconst a = "${KEY}";\n`,
      "md.md": `<!-- ${ALLOW}ticket-key -->\n${KEY}\n`,
    });
    expect(run.hits.sort()).toEqual(["bad.ts:1: allow-without-reason", "bad.ts:2: ticket-key", "md.md:1: allow-without-reason", "md.md:2: ticket-key"].sort());
  });

  it("an exception covers the next line and its own rule only", () => {
    const run = check({
      "a.ts": [`// ${ALLOW}ticket-key a fixture`, `${KEY}`, `${KEY}`, `// ${ALLOW}person-email a fixture`, `${KEY}`].join("\n"),
    });
    expect(run.hits).toEqual(["a.ts:3: ticket-key", "a.ts:5: ticket-key"]);
  });

  it("skips a lock file and a binary file", () => {
    const run = check({
      "package-lock.json": `{"name": "${KEY}", "x": "zork-private"}\n`,
      "sub/yarn.lock": `${KEY}\n`,
      "image.bin": Buffer.concat([Buffer.from([0x89, 0x50, 0, 0x0a]), Buffer.from(`${KEY} zork-private\n`)]),
    });
    expect(run).toMatchObject({ code: 0, hits: [] });
  });

  it("a file name with a key or a private word hits", () => {
    const run = check({ [`docs/${KEY}.md`]: "fine\n", "zork-private.test.ts": "fine\n", "ok.md": "fine\n" });
    expect(run.hits.sort()).toEqual([`docs/${KEY}.md:0: ticket-key`, "zork-private.test.ts:0: private-word"].sort());
    expect(run.code).toBe(1);
  });
});

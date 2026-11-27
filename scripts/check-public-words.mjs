#!/usr/bin/env node
// The public repository holds public words only. Reads every tracked file (`git ls-files -z`) and prints
// `file:line: rule` for each hit, exit 1 when there is one. Plain Node, no dependency.
//
//   node scripts/check-public-words.mjs                   check the repository in the current directory
//   node scripts/check-public-words.mjs --hash <word>     print the hash to add to PRIVATE_HASHES (scripts/public-words-rules.mjs)
//   node scripts/check-public-words.mjs --extra-hashes <hash>,<hash>   more hashed words, for the tests
//
// Rules (scripts/public-words-rules.mjs, shared with the release plugin): ticket-key, private-word, person-email. A hit on a file name is printed as line 0.
// One line is excepted by a comment on the line before it: the words `public-words: allow`, the rule's name and a
// reason (`<!-- ... -->`, `# ...` and `/* ... */` work too). An exception without a reason is a hit of its own.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { hashOf, rulesHit } from "./public-words-rules.mjs";

const LOCK_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]);

const args = process.argv.slice(2);
if (args[0] === "--hash") {
  if (!args[1]) {
    console.error("usage: check-public-words.mjs --hash <word>");
    process.exit(2);
  }
  console.log(hashOf(args[1].toLowerCase()));
  process.exit(0);
}
const extra = args.indexOf("--extra-hashes");
const extraHashes = new Set(extra === -1 ? [] : (args[extra + 1] ?? "").split(",").filter(Boolean));

let files;
try {
  files = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
} catch {
  console.error("check-public-words: `git ls-files` failed; run it inside a git repository");
  process.exit(2);
}

const hits = [];
for (const file of files) {
  for (const rule of rulesHit(file, extraHashes)) hits.push(`${file}:0: ${rule}`);
  if (LOCK_FILES.has(basename(file))) continue;
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue; // listed but not a readable file: a submodule, a file deleted from the work tree
  }
  if (buffer.subarray(0, 8192).includes(0)) continue; // binary
  const lines = buffer.toString("utf8").split("\n");
  let allowed = new Set();
  lines.forEach((line, index) => {
    const found = rulesHit(line, extraHashes).filter((rule) => !allowed.has(rule));
    for (const rule of found) hits.push(`${file}:${index + 1}: ${rule}`);
    allowed = new Set();
    const directive = /public-words: allow (ticket-key|private-word|person-email)\b(.*)$/.exec(line);
    if (directive) {
      if (directive[2].replace(/-->|\*\/|[\s*#/-]/g, "") === "") hits.push(`${file}:${index + 1}: allow-without-reason`);
      else allowed.add(directive[1]);
    }
  });
}

for (const hit of hits) console.log(hit);
if (hits.length > 0) {
  console.error(`${hits.length} hit${hits.length === 1 ? "" : "s"}: the repository holds public words only (see CONTRIBUTING.md)`);
  process.exit(1);
}

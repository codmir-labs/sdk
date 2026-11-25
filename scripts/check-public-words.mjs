#!/usr/bin/env node
// The public repository holds public words only. Reads every tracked file (`git ls-files -z`) and prints
// `file:line: rule` for each hit, exit 1 when there is one. Plain Node, no dependency.
//
//   node scripts/check-public-words.mjs                   check the repository in the current directory
//   node scripts/check-public-words.mjs --hash <word>     print the hash to add to PRIVATE_HASHES
//   node scripts/check-public-words.mjs --extra-hashes <hash>,<hash>   more hashed words, for the tests
//
// Rules: ticket-key, private-word, person-email. A hit on a file name is printed as line 0.
// One line is excepted by a comment on the line before it: the words `public-words: allow`, the rule's name and a
// reason (`<!-- ... -->`, `# ...` and `/* ... */` work too). An exception without a reason is a hit of its own.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const RULES = ["ticket-key", "private-word", "person-email"];

// ticket-key: a tracker's key, `[A-Z][A-Z0-9]{1,5}-[0-9]{2,6}` as a whole word, unless its prefix names a standard.
// Written as plain prefixes joined into one alternation, each with the reason it is allowed.
const ALLOWED_KEY_PREFIXES = [
  ["SHA", "SHA-256, SHA-1: hash functions"],
  ["UTF", "UTF-8, UTF-16: character encodings"],
  ["ISO", "ISO-8601: dates and other ISO standards"],
  ["RFC", "RFC-2606 style references to an IETF document"],
  ["ES", "ES-2022 style names of an ECMAScript edition"],
  ["CVE", "CVE-2024-... public vulnerability ids"],
  ["CWE", "CWE-79 public weakness ids"],
  ["AES", "AES-256: the cipher"],
  ["HTTP", "HTTP-2: the protocol version"],
  ["HMAC", "HMAC-SHA-256: the signature scheme"],
  ["TLS", "TLS-1: the protocol version"],
  ["IEEE", "IEEE-754: floating point"],
  ["ECMA", "ECMA-262: the language standard"],
  ["PKCS", "PKCS-8: key formats"],
  ["WCAG", "WCAG-2: the accessibility guidelines"],
];
const ALLOWED_KEY = new RegExp(`^(?:${ALLOWED_KEY_PREFIXES.map(([prefix]) => prefix).join("|")})$`);
const KEY = /\b([A-Z][A-Z0-9]{1,5})-[0-9]{2,6}\b/g;

// private-word: SHA-256 (first 16 hex digits) of lower-case words that stay out of this repository. The words
// themselves are never written here; `--hash <word>` prints the hash of one.
const PRIVATE_HASHES = new Set([
  "68532911925788a0",
  "2dde44a97b1d5463",
  "6d975c4a0486e750",
  "ae226beb2a3e3120",
  "4b8ba6a80dbb7ef0",
  "a256a14f65106e31",
  "f8338866fd287412",
  "78d348809970a6ef",
  "436fcc8059d98c12",
  "76a42b7fa7a0debc",
  "e388075da4fa4e95",
  "9883e91eb15dadaa",
  "4a57ce9d53b47358",
  "0cf6855c1a3c323b",
  "90e63f21915cd861",
  "5de1b57c2822de4d",
  "51b071861befe742",
]);

// person-email: an address at a name reserved for examples, or one of the project's own role addresses.
const EXAMPLE_DOMAINS = ["example.com", "example.org", "example.net", "users.noreply.github.com", "anthropic.com"];
const EXAMPLE_TLDS = ["test", "invalid", "localhost", "example"]; // RFC 2606 reserved names
const PUBLIC_ROLE_ADDRESSES = [
  ["hello@codmir.com", "the project's contact address: the `author` of package.json, public on purpose"],
];
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g;

const LOCK_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]);
const MAX_RUN = 4; // the longest run of joined parts compared with a hashed word

const hashOf = (word) => createHash("sha256").update(word).digest("hex").slice(0, 16);

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
if (extra !== -1) for (const hash of (args[extra + 1] ?? "").split(",").filter(Boolean)) PRIVATE_HASHES.add(hash);

// `a-b_c.d` is one token of four parts. The whole token, every run of two to four parts and every part is compared,
// a run joined as it was written and with each of the three separators (`zork-name` is also `ZORK_NAME`).
function privateWordIn(text) {
  for (const token of text.toLowerCase().match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g) ?? []) {
    if (PRIVATE_HASHES.has(hashOf(token))) return true;
    const parts = token.split(/[-_.]/);
    if (parts.length === 1) continue;
    const seps = token.match(/[-_.]/g);
    for (let size = 2; size <= Math.min(MAX_RUN, parts.length); size++) {
      for (let at = 0; at + size <= parts.length; at++) {
        const run = parts.slice(at, at + size);
        let written = run[0];
        for (let k = 1; k < size; k++) written += seps[at + k - 1] + run[k];
        if (PRIVATE_HASHES.has(hashOf(written))) return true;
        for (const joiner of ["-", "_", "."]) if (PRIVATE_HASHES.has(hashOf(run.join(joiner)))) return true;
      }
    }
    for (const part of parts) if (PRIVATE_HASHES.has(hashOf(part))) return true;
  }
  return false;
}

function emailsIn(text) {
  for (const match of text.matchAll(EMAIL)) {
    const domain = match[1].toLowerCase();
    const address = match[0].toLowerCase();
    if (PUBLIC_ROLE_ADDRESSES.some(([role]) => role === address)) continue;
    if (EXAMPLE_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))) continue;
    if (EXAMPLE_TLDS.includes(domain.slice(domain.lastIndexOf(".") + 1))) continue;
    return true;
  }
  return false;
}

function rulesHit(text) {
  const hit = [];
  for (const match of text.matchAll(KEY)) {
    if (!ALLOWED_KEY.test(match[1])) {
      hit.push("ticket-key");
      break;
    }
  }
  if (privateWordIn(text)) hit.push("private-word");
  if (emailsIn(text)) hit.push("person-email");
  return hit;
}

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
  for (const rule of rulesHit(file)) hits.push(`${file}:0: ${rule}`);
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
    const found = rulesHit(line).filter((rule) => !allowed.has(rule));
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

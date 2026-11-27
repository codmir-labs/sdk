"use strict";

// A semantic-release plugin that makes the release notes public. It takes the place of
// `@semantic-release/release-notes-generator` in `release.plugins` of package.json and calls that generator itself:
// semantic-release joins what every notes step returns, so a step listed after the generator could add to its text
// but never replace it.
//
//   generateNotes  the notes are the `## Unreleased` section of CHANGELOG.md under the version heading the generator
//                  makes. With no such section they are the generated notes, cleaned: no tracker key, no `[skip ci]`,
//                  no `(#N)` where the line already links the pull request, and no line of a private scope.
//   prepare        takes the Unreleased section out of CHANGELOG.md, before `@semantic-release/changelog` prepends
//                  the notes, so the file reads newest release first and the release is written once.
//
// Both steps run the rules of scripts/public-words-rules.mjs (the ones `npm run check:words` runs) on the notes and
// stop the release on a hit, before any file is written or anything is published.

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

// Scopes of changes to packages users never get: `agent-kit` is the package, and `agent` is the scope its commits use.
const PRIVATE_SCOPES = ["agent-kit", "agent"];
const RULES_FILE = join(__dirname, "..", "..", "scripts", "public-words-rules.mjs");

// The shape of @semantic-release/error: semantic-release prints `<code> <message>`, then the details.
function releaseError(code, message, details) {
  return Object.assign(new Error(message), { name: "SemanticReleaseError", code, details, semanticRelease: true });
}

const loadRules = () => import(pathToFileURL(RULES_FILE).href);

const changelogPathOf = (pluginConfig, cwd) => join(cwd, pluginConfig.changelogFile ?? "CHANGELOG.md");

// More hashed private words, for the tests (the CLI's `--extra-hashes`): an array or a comma list of hashes.
function extraHashesOf(pluginConfig) {
  const given = pluginConfig.extraHashes ?? [];
  return new Set(typeof given === "string" ? given.split(",").filter(Boolean) : given);
}

// The `## Unreleased` section of a changelog: its text without the heading, and the file without the section. The
// section runs to the next heading of level 1 or 2 (`### Features` is inside it); fenced code is skipped over.
function splitUnreleased(text) {
  const lines = text.split("\n");
  let fenced = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    if (start === -1) {
      if (/^## +unreleased\s*$/i.test(lines[i])) start = i;
    } else if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1) return { found: false, content: "", rest: text };
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/^\s*\n/, "");
  return { found: true, content: lines.slice(start + 1, end).join("\n").trim(), rest };
}

// The heading the generator writes (`# [2.1.0](compare link) (date)`), else one made from the version.
function headingOf(generated, version) {
  const first = generated.split("\n").find((line) => line.trim() !== "");
  return first && /^#{1,2}\s/.test(first) ? first : `## ${version}`;
}

// The generated notes as public text. Every step is a plain text edit, and what it leaves is still checked.
function cleanGenerated(generated, rules) {
  const keyText = rules.KEY.source;
  const isKept = (prefix) => rules.ALLOWED_KEY.test(prefix);
  const keyList = new RegExp(`\\s*\\(\\s*(${keyText})(?:[\\s,;&+/.\\d-]|\\band\\b|${keyText})*\\)`, "g");
  const bareKey = new RegExp(`\\s*${keyText}:?`, "g");
  const keyPrefix = (text) => /^([A-Z][A-Z0-9]{1,5})-/.exec(text.trim())?.[1] ?? "";

  const kept = [];
  for (const line of generated.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      kept.push(line);
      continue;
    }
    let text = line;
    const scoped = /^(\s*[*-]\s+)\*\*([^*]+?):\*\*(\s*)/.exec(text);
    if (scoped) {
      const scopes = scoped[2].split(/\s*,\s*/);
      const left = scopes.filter((scope) => !PRIVATE_SCOPES.includes(scope.trim()));
      if (left.length === 0) continue;
      if (left.length !== scopes.length) text = `${scoped[1]}**${left.join(", ")}:**${scoped[3]}${text.slice(scoped[0].length)}`;
    }
    text = text
      .replace(/\s*\[(?:skip ci|ci skip|skip-ci)\]/gi, "")
      .replace(keyList, (group, first) => (isKept(keyPrefix(first)) ? group : ""))
      .replace(bareKey, (key) => (isKept(keyPrefix(key)) ? key : ""))
      .replace(/\(\s*\)/g, "")
      .replace(/\s\(#\d+\)/g, "") // the generator's own `([#N](link))` stays
      .replace(/(\S)[ \t]{2,}/g, "$1 ")
      .replace(/\s+$/, "");
    kept.push(text);
  }

  // A section whose lines were all dropped goes with them.
  const out = [];
  kept.forEach((line, i) => {
    if (/^#{3,6}\s/.test(line)) {
      const next = kept.slice(i + 1).findIndex((later) => /^#{1,6}\s/.test(later));
      const body = kept.slice(i + 1, next === -1 ? undefined : i + 1 + next);
      if (body.every((bodyLine) => bodyLine.trim() === "")) return;
    }
    out.push(line);
  });
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

// Every line of `notes` the words rules hit, as `{ line, rule }`; the line's own text is never repeated.
function wordsHits(notes, rules, extraHashes) {
  const hits = [];
  notes.split("\n").forEach((text, index) => {
    for (const rule of rules.rulesHit(text, extraHashes)) hits.push({ line: index + 1, rule });
  });
  return hits;
}

async function assertPublicWords(notes, pluginConfig) {
  const rules = await loadRules();
  const hits = wordsHits(notes, rules, extraHashesOf(pluginConfig));
  if (hits.length === 0) return;
  throw releaseError(
    "EPUBLICWORDS",
    `The release notes hold words that are not public (${hits.length} hit${hits.length === 1 ? "" : "s"}); nothing was written or published.`,
    `${hits.map(({ line, rule }) => `release notes:${line}: ${rule}`).join("\n")}\n\n` +
      "The notes are the `## Unreleased` section of CHANGELOG.md, else the generated notes. Edit that text " +
      "and run the release again (see CONTRIBUTING.md).\n",
  );
}

// semantic-release calls this with the context of the release; the generator's output is the only output.
async function generateNotes(pluginConfig, context) {
  const { cwd, nextRelease } = context;
  // After a prepare step has made a commit, semantic-release makes the notes again for the publish steps. The
  // Unreleased section is gone from the file by then, and the notes already made are the ones to keep.
  if (nextRelease.notes) {
    await assertPublicWords(nextRelease.notes, pluginConfig);
    return nextRelease.notes;
  }
  const { generateNotes: generate } = await import("@semantic-release/release-notes-generator");
  const generated = await generate(pluginConfig.generator ?? {}, context);
  const file = changelogPathOf(pluginConfig, cwd);
  const unreleased = existsSync(file) ? splitUnreleased(readFileSync(file, "utf8")) : { content: "" };
  const notes = unreleased.content
    ? `${headingOf(generated ?? "", nextRelease.version)}\n\n${unreleased.content}\n`
    : cleanGenerated(generated ?? "", await loadRules());
  await assertPublicWords(notes, pluginConfig);
  return notes;
}

// Runs before @semantic-release/changelog (it is listed above it), which prepends the notes to the file.
async function prepare(pluginConfig, context) {
  const { cwd, logger, nextRelease } = context;
  if (nextRelease.notes) await assertPublicWords(nextRelease.notes, pluginConfig);
  const file = changelogPathOf(pluginConfig, cwd);
  if (!existsSync(file)) return;
  const { found, rest } = splitUnreleased(readFileSync(file, "utf8"));
  if (!found) return;
  writeFileSync(file, rest);
  logger.log("Folded the Unreleased section of %s into the notes of %s", file, nextRelease.version);
}

module.exports = { generateNotes, prepare, splitUnreleased, cleanGenerated, headingOf };

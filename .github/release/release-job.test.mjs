import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The release job of .github/workflows/ci.yml runs only when a maintainer dispatches the workflow on main.
// The file is read line by line, as the 2-space block-style YAML it is written in.
const lines = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8").split("\n");
const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const file = { indent: -2, line: -1, end: lines.length };

// The keys one level inside a block, each with the line range of its own block.
function keys(block) {
  const indent = block.indent + 2;
  const found = [];
  for (let line = block.line + 1; line < block.end; line++) {
    const match = /^( *)([\w-]+):/.exec(lines[line]);
    if (match && match[1].length === indent) found.push({ name: match[2], indent, line });
  }
  return found.map((key, i) => ({ ...key, end: i + 1 < found.length ? found[i + 1].line : block.end }));
}

function key(block, name) {
  const found = keys(block).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`ci.yml has no ${name} there`);
  return found;
}

const on = key(file, "on");
const jobs = key(file, "jobs");
const build = key(jobs, "build");
const release = key(jobs, "release");

// GitHub reads `if:` as an expression and compares strings without case. Only a plain chain of
// `github.<field> == '<text>'` joined by && is read here; anything else fails, for a person to look at.
function releaseRuns(github) {
  const condition = lines[key(release, "if").line].replace(/^\s*if:\s*/, "").replace(/^\$\{\{(.*)\}\}\s*$/, "$1");
  return condition.split("&&").every((part) => {
    const match = /^\s*github\.(\w+)\s*==\s*'([^']*)'\s*$/.exec(part);
    if (!match) throw new Error(`Not a plain && of github.<field> == '<text>' checks: ${part.trim()}`);
    return String(github[match[1]] ?? "").toLowerCase() === match[2].toLowerCase();
  });
}

describe("ci.yml release job", () => {
  it("the workflow runs on push, pull_request and workflow_dispatch, and the build job on all three", () => {
    expect(keys(on).map(({ name }) => name)).toEqual(["push", "pull_request", "workflow_dispatch"]);
    expect(keys(build).map(({ name }) => name)).not.toContain("if");
  });

  it.each([
    ["push", "refs/heads/main", false],
    ["push", "refs/tags/v2.0.1", false],
    ["pull_request", "refs/pull/1/merge", false],
    ["schedule", "refs/heads/main", false],
    ["workflow_dispatch", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/feature", false],
    ["workflow_dispatch", "refs/tags/v2.0.1", false],
  ])("on %s of %s, the release job runs: %s", (event_name, ref, runs) => {
    expect(releaseRuns({ event_name, ref })).toBe(runs);
  });

  it("only the release job runs semantic-release, and no npm script does", () => {
    const code = (block) => lines.slice(block.line, block.end).map((line) => line.replace(/#.*/, ""));
    const runsIt = (block) => code(block).some((line) => line.includes("semantic-release"));
    expect(keys(jobs).filter(runsIt).map(({ name }) => name)).toEqual(["release"]);
    expect(Object.entries(scripts).filter(([, command]) => command.includes("semantic-release"))).toEqual([]);
  });
});

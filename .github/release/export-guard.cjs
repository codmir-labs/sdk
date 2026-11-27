"use strict";

// A semantic-release plugin that makes a release a major when the package stops exporting an entry it exported at the
// last release. Removing a key of `exports` breaks every app that imports it (ERR_PACKAGE_PATH_NOT_EXPORTED), whatever
// the commit message says, so the commit-analyzer's answer is not enough. Listed in the `release.plugins` of
// package.json right after the commit-analyzer: semantic-release takes the highest type that any plugin returns.

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// The keys of `exports` in a package.json text. A string or missing `exports` has no subpath keys to lose.
function exportKeys(packageJsonText) {
  const { exports } = JSON.parse(packageJsonText);
  return exports !== null && typeof exports === "object" ? Object.keys(exports) : [];
}

// semantic-release calls this once per release with the commits since the last one; the answer is a release type or
// null. null leaves the commit-analyzer's answer as it is.
function analyzeCommits(pluginConfig, context) {
  const { cwd, lastRelease, logger } = context;
  const tag = lastRelease?.gitTag;
  if (!tag) {
    logger.log("No last release, so there is no export to compare against");
    return null;
  }
  let before;
  let now;
  try {
    before = exportKeys(
      execFileSync("git", ["show", `${tag}:package.json`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    );
    now = exportKeys(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch (error) {
    logger.log(`Could not read the exports of package.json at ${tag}, so none are compared: ${error.message}`);
    return null;
  }
  const missing = before.filter((key) => !now.includes(key));
  if (missing.length === 0) {
    logger.log(`Every export of ${tag} is still there`);
    return null;
  }
  logger.log(`Exports of ${tag} that are gone: ${missing.join(", ")}; a release without them is a major`);
  return "major";
}

module.exports = { analyzeCommits, exportKeys };

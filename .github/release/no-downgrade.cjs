"use strict";

// A semantic-release plugin that refuses any next version that is not above npm `latest`, prereleases included.
// semantic-release takes the next version from the last v* git tag, so a missing tag makes it compute a lower version
// and publish that over `latest`. Listed in the `release.plugins` of package.json.

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const REGISTRY = "https://registry.npmjs.org";

// semver.org 2.0.0: MAJOR.MINOR.PATCH, then an optional -prerelease and +build. Numbers have no leading zeros.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;

function parse(version) {
  const match = SEMVER.exec(version);
  if (!match) throw new TypeError(`Not a semantic version: ${JSON.stringify(version)}`);
  return { numbers: match.slice(1, 4), prerelease: match[4] === undefined ? [] : match[4].split(".") };
}

// Digit strings without leading zeros: the longer one is larger, and the same length compares as text.
function compareNumbers(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Prerelease identifiers: numbers compare as numbers and sort below words, which compare in ASCII order.
function compareIdentifiers(a, b) {
  const aIsNumber = /^\d+$/.test(a);
  const bIsNumber = /^\d+$/.test(b);
  if (aIsNumber && bIsNumber) return compareNumbers(a, b);
  if (aIsNumber !== bIsNumber) return aIsNumber ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Semver precedence (semver.org, item 11) as -1, 0 or 1. Build metadata does not count.
function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const order = compareNumbers(x.numbers[i], y.numbers[i]);
    if (order !== 0) return order;
  }
  if (x.prerelease.length === 0 && y.prerelease.length === 0) return 0;
  if (x.prerelease.length === 0) return 1; // 2.1.0 > 2.1.0-beta.1
  if (y.prerelease.length === 0) return -1;
  for (let i = 0; i < Math.min(x.prerelease.length, y.prerelease.length); i++) {
    const order = compareIdentifiers(x.prerelease[i], y.prerelease[i]);
    if (order !== 0) return order;
  }
  return Math.sign(x.prerelease.length - y.prerelease.length); // 2.1.0-beta < 2.1.0-beta.1
}

// The rule: a release must be strictly above npm latest.
function isAbove(next, latest) {
  return compareVersions(next, latest) > 0;
}

// npm `latest` of a package, read from the public registry without a token, or null when it was never published.
async function readNpmLatest(name, fetchImpl = fetch) {
  const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  const latest = (await response.json())["dist-tags"]?.latest;
  if (typeof latest !== "string") throw new Error(`GET ${url} has no latest dist-tag`);
  return latest;
}

// The shape of @semantic-release/error: semantic-release prints `<code> <message>`, then the details.
function releaseError(code, message, details) {
  return Object.assign(new Error(message), { name: "SemanticReleaseError", code, details, semanticRelease: true });
}

// semantic-release calls this once the next version is known, before anything is written, tagged or published.
// It passes two arguments; the third is for the tests.
async function verifyRelease(pluginConfig, context, readLatest = readNpmLatest) {
  const { cwd, logger, nextRelease } = context;
  const { name } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  let latest;
  try {
    latest = await readLatest(name);
  } catch (error) {
    const reason = error.cause ? `${error.message} (${error.cause.message ?? error.cause})` : error.message;
    throw releaseError(
      "ENPMLATEST",
      `Could not read npm latest of ${name}, so ${nextRelease.version} is not released: ${reason}`,
    );
  }
  if (latest === null) {
    logger.log(`${name} is not on npm yet, so ${nextRelease.version} has no latest to stay above`);
    return;
  }
  if (!isAbove(nextRelease.version, latest)) {
    throw releaseError(
      "ENODOWNGRADE",
      `Refusing to release ${nextRelease.version}: it is not above npm latest ${latest} of ${name}.`,
      `semantic-release takes the next version from the last \`v*\` tag on the branch, so this usually means the tag ` +
        `of a published version is missing. Tag the commit that \`${name}@${latest}\` was published from ` +
        `(\`npm view ${name}@${latest} gitHead\`) as \`v${latest}\`, push the tag and run the release again.\n`,
    );
  }
  logger.log(`${nextRelease.version} is above npm latest ${latest} of ${name}`);
}

module.exports = { verifyRelease, isAbove, compareVersions, readNpmLatest };

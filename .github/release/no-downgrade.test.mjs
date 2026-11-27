import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Loaded the way semantic-release loads it: by Node's own CommonJS loader, not by Vite's transform.
const { compareVersions, isAbove, readNpmLatest, verifyRelease } = createRequire(import.meta.url)("./no-downgrade.cjs");
const packageJson = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("isAbove", () => {
  it("accepts a next version above latest", () => {
    expect(isAbove("2.1.0", "2.0.1")).toBe(true);
    expect(isAbove("2.0.2", "2.0.1")).toBe(true);
    expect(isAbove("3.0.0", "2.0.1")).toBe(true);
  });

  it("refuses a next version equal to latest", () => {
    expect(isAbove("2.0.1", "2.0.1")).toBe(false);
    expect(isAbove("2.0.1+build.7", "2.0.1")).toBe(false); // build metadata does not count
  });

  it("refuses a next version below latest", () => {
    expect(isAbove("2.0.0", "2.0.1")).toBe(false);
    expect(isAbove("1.9.9", "2.0.1")).toBe(false);
  });

  it("refuses a major below latest, as a missing v2.0.1 tag would compute", () => {
    expect(isAbove("1.1.0", "2.0.1")).toBe(false);
  });

  it("refuses a prerelease when latest is higher", () => {
    expect(isAbove("2.0.1-rc.1", "2.0.1")).toBe(false);
    expect(isAbove("1.1.0-beta.1", "2.0.1")).toBe(false);
  });

  it("accepts a prerelease above latest", () => {
    expect(isAbove("2.1.0-beta.1", "2.0.1")).toBe(true);
  });

  it("compares numbers as numbers, not as text", () => {
    expect(isAbove("2.10.0", "2.9.0")).toBe(true);
    expect(isAbove("10.0.0", "9.0.0")).toBe(true);
  });
});

describe("compareVersions", () => {
  it("orders prereleases by semver precedence", () => {
    const ordered = ["2.1.0-1", "2.1.0-alpha", "2.1.0-alpha.1", "2.1.0-beta", "2.1.0-beta.2", "2.1.0-beta.10", "2.1.0"];
    for (let i = 1; i < ordered.length; i++) {
      const [lower, higher] = [ordered[i - 1], ordered[i]];
      expect(compareVersions(lower, higher), `${lower} < ${higher}`).toBe(-1);
      expect(compareVersions(higher, lower), `${higher} > ${lower}`).toBe(1);
    }
    expect(compareVersions("2.0.1+a", "2.0.1+b")).toBe(0);
  });

  it("throws on anything that is not a semantic version", () => {
    for (const bad of ["v2.0.1", "2.0", "02.0.1", "2.0.1-01", "", undefined]) {
      expect(() => compareVersions(bad, "2.0.1"), String(bad)).toThrow(TypeError);
    }
  });
});

function fakeContext(version) {
  const lines = [];
  return { cwd: dirname(packageJson), nextRelease: { version }, logger: { log: (line) => lines.push(line) }, lines };
}

// A stand-in for the registry read, which records the package names it was asked for.
function latestIs(version, names = []) {
  return async (name) => {
    names.push(name);
    return version;
  };
}

async function refusal(promise) {
  const error = await promise.then(
    () => undefined,
    (thrown) => thrown,
  );
  expect(error, "the release was not refused").toBeInstanceOf(Error);
  expect(error.semanticRelease).toBe(true);
  return error;
}

describe("verifyRelease", () => {
  it("passes a version above npm latest, read for this package", async () => {
    const names = [];
    const context = fakeContext("2.1.0");
    await verifyRelease({}, context, latestIs("2.0.1", names));
    expect(names).toEqual(["@codmir/sdk"]);
    expect(context.lines).toEqual(["2.1.0 is above npm latest 2.0.1 of @codmir/sdk"]);
  });

  it("refuses 1.1.0 when npm latest is 2.0.1, naming both", async () => {
    const error = await refusal(verifyRelease({}, fakeContext("1.1.0"), latestIs("2.0.1")));
    expect(error.code).toBe("ENODOWNGRADE");
    expect(error.message).toBe("Refusing to release 1.1.0: it is not above npm latest 2.0.1 of @codmir/sdk.");
    expect(error.details).toContain("`@codmir/sdk@2.0.1` was published from (`npm view @codmir/sdk@2.0.1 gitHead`)");
  });

  it("refuses a version equal to npm latest", async () => {
    const error = await refusal(verifyRelease({}, fakeContext("2.0.1"), latestIs("2.0.1")));
    expect(error.code).toBe("ENODOWNGRADE");
  });

  it("refuses a prerelease below npm latest", async () => {
    const error = await refusal(verifyRelease({}, fakeContext("2.0.1-rc.1"), latestIs("2.0.1")));
    expect(error.code).toBe("ENODOWNGRADE");
  });

  it("passes when the package is not on npm yet", async () => {
    const context = fakeContext("1.0.0");
    await verifyRelease({}, context, latestIs(null));
    expect(context.lines).toEqual(["@codmir/sdk is not on npm yet, so 1.0.0 has no latest to stay above"]);
  });

  it("refuses when npm latest cannot be read, with the reason", async () => {
    const offline = async () => {
      throw new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND registry.npmjs.org") });
    };
    const error = await refusal(verifyRelease({}, fakeContext("2.1.0"), offline));
    expect(error.code).toBe("ENPMLATEST");
    expect(error.message).toBe(
      "Could not read npm latest of @codmir/sdk, so 2.1.0 is not released: " +
        "fetch failed (getaddrinfo ENOTFOUND registry.npmjs.org)",
    );
  });
});

describe("readNpmLatest", () => {
  function fakeFetch(status, body) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, accept: init.headers.accept });
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    };
    return { calls, fetchImpl };
  }

  it("reads the latest dist-tag of the abbreviated packument", async () => {
    const { calls, fetchImpl } = fakeFetch(200, { "dist-tags": { latest: "2.0.1", beta: "2.1.0-beta.1" } });
    expect(await readNpmLatest("@codmir/sdk", fetchImpl)).toBe("2.0.1");
    expect(calls).toEqual([
      { url: "https://registry.npmjs.org/@codmir%2fsdk", accept: "application/vnd.npm.install-v1+json" },
    ]);
  });

  it("answers null for a package that was never published", async () => {
    expect(await readNpmLatest("@codmir/sdk", fakeFetch(404, { error: "Not found" }).fetchImpl)).toBe(null);
  });

  it("throws on any other registry answer", async () => {
    await expect(readNpmLatest("@codmir/sdk", fakeFetch(503, {}).fetchImpl)).rejects.toThrow(/answered 503/);
  });

  it("throws when the packument has no latest dist-tag", async () => {
    const { fetchImpl } = fakeFetch(200, { "dist-tags": {} });
    await expect(readNpmLatest("@codmir/sdk", fetchImpl)).rejects.toThrow(/no latest dist-tag/);
  });
});

describe("package.json", () => {
  it("lists this plugin in release.plugins, by a path that resolves from the repo root", () => {
    const { release } = JSON.parse(readFileSync(packageJson, "utf8"));
    const names = release.plugins.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
    const local = names.filter((name) => name.startsWith("."));
    expect(local).toEqual([
      "./.github/release/export-guard.cjs",
      "./.github/release/no-downgrade.cjs",
      "./.github/release/public-notes.cjs",
    ]);
    // semantic-release resolves a plugin path from the directory it runs in, the repo root.
    const resolved = createRequire(packageJson).resolve("./.github/release/no-downgrade.cjs");
    expect(resolved).toBe(fileURLToPath(new URL("./no-downgrade.cjs", import.meta.url)));
  });
});

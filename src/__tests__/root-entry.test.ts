/**
 * CSL-5375: `npm install @codmir/sdk` is the error SDK. The root entry exports init and captureException,
 * wired to the same core as `@codmir/sdk/overseer`. The dist tests need `npm run build` first (CI builds before test).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Root from "../index";
import Default, { CodmirClient, Overseer } from "../index";

const ROOT_NAMES = [
  "init",
  "captureException",
  "captureMessage",
  "setUser",
  "setTag",
  "setTags",
  "addBreadcrumb",
  "flush",
  "close",
  "getClient",
];

describe("root entry (source)", () => {
  let bodies: any[];
  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    Root.close();
    vi.unstubAllGlobals();
  });

  it("exports the error SDK functions", () => {
    for (const name of ROOT_NAMES) expect(typeof (Root as any)[name], name).toBe("function");
  });

  it("init then captureException sends one event through the transport", async () => {
    Root.init({ clientKey: "osk_test", environment: "production" });
    Root.setUser({ id: "u1" });
    const id = Root.captureException(new TypeError("boom"));
    expect(typeof id).toBe("string");
    expect(await Root.flush()).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].events).toHaveLength(1);
    expect(bodies[0].events[0]).toMatchObject({ type: "error", event: { message: "boom", id } });
  });

  it("shares the singleton with the Overseer namespace", () => {
    Root.init({ clientKey: "osk_test" });
    expect(Root.getClient()).not.toBeNull();
    expect(Overseer.getClient()).toBe(Root.getClient());
  });

  it("keeps CodmirClient and the default export", () => {
    expect(typeof CodmirClient).toBe("function");
    expect(Default).toBe(CodmirClient);
    expect(typeof Overseer.init).toBe("function");
  });
});

const dist = new URL("../../dist/", import.meta.url);
const hasDist = existsSync(new URL("index.js", dist)) && existsSync(new URL("index.cjs", dist));

describe.skipIf(!hasDist)("root entry (built dist)", () => {
  it("resolves init and captureException as ESM", async () => {
    const mod = await import(pathToFileURL(fileURLToPath(new URL("index.js", dist))).href);
    for (const name of ROOT_NAMES) expect(typeof mod[name], name).toBe("function");
    expect(typeof mod.CodmirClient).toBe("function");
    expect(mod.default).toBe(mod.CodmirClient);
  });

  it("resolves init and captureException as CJS", () => {
    const mod = createRequire(import.meta.url)(fileURLToPath(new URL("index.cjs", dist)));
    for (const name of ROOT_NAMES) expect(typeof mod[name], name).toBe("function");
    expect(typeof mod.CodmirClient).toBe("function");
  });

  // nanoid 5 is ESM-only: a bare require("nanoid") throws ERR_REQUIRE_ESM on Node 18 and 20 before 20.19.
  // The SDK has no nanoid dependency any more (CSL-5616), so no output may name it.
  it("does not require nanoid from the CJS output", () => {
    const dir = fileURLToPath(dist);
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".cjs"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(`${dir}${f}`, "utf8"), f).not.toMatch(/require\(["']nanoid["']\)/);
  });

  it("resolves the package name through exports, ESM and CJS", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const esm = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", 'import { init, captureException } from "@codmir/sdk"; console.log(typeof init, typeof captureException)'],
      { cwd: root, encoding: "utf8" },
    );
    const cjs = execFileSync(
      process.execPath,
      ["-e", 'const { init, captureException } = require("@codmir/sdk"); console.log(typeof init, typeof captureException)'],
      { cwd: root, encoding: "utf8" },
    );
    expect(esm.trim()).toBe("function function");
    expect(cjs.trim()).toBe("function function");
  });
});

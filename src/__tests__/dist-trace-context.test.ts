/**
 * An error carries the trace of the active span whichever entry point captured it and whichever started the span, under
 * `require` and under `import`. Each case runs in a fresh Node process against the built dist and a capture server on
 * 127.0.0.1. Needs `npm run build` first (CI builds before test); skips without one.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, until, type FakeServer } from "./helpers/fake-server";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const built = existsSync(`${dist}index.cjs`) && existsSync(`${dist}index.js`);
const run = promisify(execFile);

let server: FakeServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.close();
});

const PRELUDE = `
const DIST = process.env.DIST;
const FILES = { root: "index", overseer: "overseer/index", express: "express/index", nextjs: "nextjs/index", tracing: "tracing/index", browser: "browser/index" };
const config = { dsn: process.env.SERVER + "/p", clientKey: "osk_dist", tracesSampleRate: 1 };
const assert = (ok, what) => { if (!ok) throw new Error("failed: " + what); };
const say = (value) => console.log("RESULT " + JSON.stringify(value));
`;
const LOAD = {
  cjs: { flag: "--input-type=commonjs", load: `const load = async (name) => require(DIST + FILES[name] + ".cjs");` },
  esm: { flag: "--input-type=module", load: `const load = async (name) => import((await import("node:url")).pathToFileURL(DIST + FILES[name] + ".js").href);` },
};
/** A page for the browser entry: the repo's own jsdom, installed as the globals a browser has. */
const PAGE = `
const { JSDOM } = require(process.env.REPO + "node_modules/jsdom");
const dom = new JSDOM("<!doctype html><p>page</p>", { url: "https://app.example.test/start" });
for (const key of ["window", "document", "location", "history", "navigator"]) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
`;

/** Runs `body` in a new process and returns what it passed to `say`. */
async function child(format: "cjs" | "esm", body: string, options: { page?: boolean } = {}): Promise<any> {
  const { flag, load } = LOAD[format];
  // The page needs `require`, which an ES module has to make for itself.
  const page = options.page ? (format === "esm" ? `const require = (await import("node:module")).createRequire(process.env.REPO + "x.js");\n${PAGE}` : PAGE) : "";
  const script = `${PRELUDE}\n${load}\n(async () => {\n${page}\n${body}\n})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`;
  const env = { ...process.env, DIST: dist, REPO: repo, SERVER: server.url };
  const { stdout } = await run(process.execPath, [flag, "-e", script], { env, timeout: 30_000 });
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  return line ? JSON.parse(line.slice("RESULT ".length)) : undefined;
}

const traces = (): Record<string, any> => Object.fromEntries(server.errors("/p").map((e) => [e.message as string, (e.contexts as any)?.trace]));

describe.skipIf(!built).each(["cjs", "esm"] as const)("a trace across entry points under %s", (format) => {
  it("a span opened through /tracing is on an error captured through /overseer, /express, /nextjs and the root", async () => {
    const ids = await child(format, `
      const express = await load("express"), root = await load("root"), overseer = await load("overseer"), nextjs = await load("nextjs"), tracing = await load("tracing");
      express.init(config);
      let ids;
      await tracing.startSpan({ op: "task", name: "work" }, async () => {
        const span = tracing.getActiveSpan();
        ids = { trace_id: span.traceId, span_id: span.spanId };
        root.captureException(new Error("via root"));
        overseer.captureException(new Error("via overseer"));
        nextjs.captureException(new Error("via nextjs"));
        express.captureException(new Error("via express"));
      });
      root.captureException(new Error("outside"));
      assert(await root.flush(), "flush");
      root.close();
      say(ids);
    `);
    await until(() => server.errors("/p").length === 5, "five errors");
    const seen = traces();
    for (const name of ["via root", "via overseer", "via nextjs", "via express"]) expect(seen[name], name).toEqual(ids);
    expect(seen.outside).toBeUndefined();
  });

  it("the page's standing root, set through /browser, is on an error captured through /overseer and /express", async () => {
    const ids = await child(format, `
      const browser = await load("browser"), overseer = await load("overseer"), express = await load("express"), tracing = await load("tracing");
      browser.init({ ...config, browserTracing: true });
      const root = tracing.getActiveSpan();
      assert(root && root.op === "pageload", "the pageload transaction is the active span");
      overseer.captureException(new Error("via overseer"));
      express.captureException(new Error("via express"));
      assert(await overseer.flush(), "flush");
      browser.close();
      say({ trace_id: root.traceId, span_id: root.spanId });
    `, { page: true });
    await until(() => server.errors("/p").length === 2, "two errors");
    const seen = traces();
    expect(seen["via overseer"]).toEqual(ids);
    expect(seen["via express"]).toEqual(ids);
  });
});

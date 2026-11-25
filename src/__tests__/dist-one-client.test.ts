/**
 * Whatever entry point starts the SDK, every other one uses that client, under `require` and under `import`. Each case
 * runs in a fresh Node process against the built dist and a capture server on 127.0.0.1. Needs `npm run build` first
 * (CI builds before test); skips without one.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, until, settle, type FakeServer } from "./helpers/fake-server";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
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
const FILES = { root: "index", overseer: "overseer/index", express: "express/index", nextjs: "nextjs/index", tracing: "tracing/index", feedback: "feedback/index", logs: "logs/index" };
const config = { dsn: process.env.SERVER + "/p", clientKey: "osk_dist", tracesSampleRate: 1 };
const assert = (ok, what) => { if (!ok) throw new Error("failed: " + what); };
`;
const LOAD = {
  cjs: { flag: "--input-type=commonjs", load: `const load = async (name) => require(DIST + FILES[name] + ".cjs");` },
  esm: { flag: "--input-type=module", load: `const load = async (name) => import((await import("node:url")).pathToFileURL(DIST + FILES[name] + ".js").href);` },
};

/** Runs `body` (async statements; `load(name)` gives an entry, `config` the init options) in a new process. */
async function child(format: "cjs" | "esm", body: string): Promise<void> {
  const { flag, load } = LOAD[format];
  const script = `${PRELUDE}\n${load}\n(async () => {\n${body}\n})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`;
  const env = { ...process.env, DIST: dist, SERVER: server.url };
  await run(process.execPath, [flag, "-e", script], { env, timeout: 30_000 });
}

describe.skipIf(!built)("the CommonJS files", () => {
  it("hold no ES module syntax and no import.meta", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}${e.name}/`) : e.name.endsWith(".cjs") ? [`${dir}${e.name}`] : []));
    const all = files(dist);
    expect(all.length).toBeGreaterThan(20);
    for (const file of all) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/import\.meta|^\s*(import|export)\s[^(]/m);
    }
  });
});

const messages = (): string[] => server.errors("/p").map((e) => e.message as string).sort();

describe.skipIf(!built).each(["cjs", "esm"] as const)("one client under %s", (format) => {
  it("init through /express: the root, /overseer and /nextjs capture into it, and they hold one client", async () => {
    await child(format, `
      const express = await load("express"), root = await load("root"), overseer = await load("overseer"), nextjs = await load("nextjs");
      express.init(config);
      assert(root.getClient() !== null && root.getClient() === overseer.getClient(), "root and overseer share the client");
      root.captureException(new Error("via root"));
      overseer.captureException(new Error("via overseer"));
      nextjs.captureException(new Error("via nextjs"));
      express.captureException(new Error("via express"));
      assert(await root.flush(), "flush");
      express.close();
    `);
    await until(() => messages().length === 4, "four errors");
    expect(messages()).toEqual(["via express", "via nextjs", "via overseer", "via root"]);
  });

  it("init through the root: /express captures into it", async () => {
    await child(format, `
      const express = await load("express"), root = await load("root");
      root.init(config);
      assert(express.getClient() === root.getClient() && root.getClient() !== null, "express sees the client");
      express.captureException(new Error("via express"));
      assert(await root.flush(), "flush");
      root.close();
    `);
    await until(() => messages().length === 1, "the error");
    expect(messages()).toEqual(["via express"]);
  });

  it("a span through /tracing lands in a transaction of the same client", async () => {
    await child(format, `
      const express = await load("express"), tracing = await load("tracing");
      express.init(config);
      const tx = tracing.startTransaction({ op: "http.server", name: "GET /x" });
      assert(tx.sampled !== false, "sampled");
      const child = tracing.withActiveSpan(tx, () => tracing.startChildSpan({ op: "db", name: "query" }));
      assert(child !== null, "a child of the active span");
      child.end();
      tx.end();
      assert(await express.flush(), "flush");
      express.close();
    `);
    await until(() => server.transactions("/p").length === 1, "the transaction");
    const [tx] = server.transactions("/p");
    expect(tx.spans ?? tx.event?.spans).toHaveLength(1);
  });

  it("/feedback and /logs use the client /express started", async () => {
    await child(format, `
      const express = await load("express"), feedback = await load("feedback"), logs = await load("logs");
      express.init(config);
      const monitor = logs.createLogMonitor({ cloud: true });
      monitor.record({ level: "error", message: "payment failed for order 8812" });
      await monitor.flush();
      await monitor.stop();
      await feedback.sendFeedback("the page broke");
      assert(await express.flush(), "flush");
      express.close();
    `);
    await settle();
    expect(server.received.some((r) => r.path.startsWith("/p/feedback"))).toBe(true);
    expect(server.events("/p").some((e) => String(e.event?.message).includes("payment failed"))).toBe(true);
  });

  it("close through one ends the client the others use", async () => {
    await child(format, `
      const express = await load("express"), root = await load("root"), overseer = await load("overseer");
      express.init(config);
      const client = overseer.getClient();
      assert(client !== null && express.getClient() === client && root.getClient() === client, "one client");
      let closes = 0;
      const close = client.close.bind(client);
      client.close = () => { closes += 1; close(); };
      root.close();
      assert(closes === 1, "root.close ended the client the other entries use");
      overseer.close();
      assert(closes === 2, "and /overseer closes the same one");
    `);
  });
});

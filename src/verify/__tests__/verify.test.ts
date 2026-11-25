/**
 * `verify()` says success only when the server took its event, says in one sentence why not otherwise, and leaves nothing
 * behind. A server on 127.0.0.1 answers what each case asks for. The dist case needs `npm run build` first; it skips without one.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as overseer from "../../overseer/index";
import { printVerifyResult, quickVerify, verify } from "../index";

interface Hit {
  path: string;
  key: string | undefined;
  body: { events?: Array<Record<string, any>> };
}
let server: Server;
let url = "";
let hits: Hit[] = [];
let answer: { status: number; body?: string; delayMs?: number; never?: boolean } = { status: 200, body: '{"received":true}' };
let sockets: Set<import("node:net").Socket>;

beforeEach(async () => {
  hits = [];
  answer = { status: 200, body: '{"received":true}' };
  sockets = new Set();
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // kept empty
      }
      hits.push({ path: req.url ?? "", key: req.headers["x-overseer-key"] as string | undefined, body });
      if (answer.never) return;
      setTimeout(() => res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body ?? ""), answer.delayMs ?? 0);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const KEY = "osk_verifysecret0123456789";
const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
/**
 * The timers of `delay` milliseconds created while `during` runs that neither fired nor were cleared. (An unref'd timer is
 * not in `getActiveResourcesInfo()`, so a timer left behind has to be found at the call.)
 */
async function leftOver(delay: number, during: () => Promise<unknown>): Promise<number> {
  const open = new Set<unknown>();
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle: unknown = set(
      (...a: unknown[]) => {
        open.delete(handle);
        fn(...a);
      },
      ms,
      ...rest,
    );
    if (ms === delay) open.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    open.delete(handle);
    clear(handle);
  }) as typeof clearTimeout;
  try {
    await during();
  } finally {
    globalThis.setTimeout = set;
    globalThis.clearTimeout = clear;
  }
  const left = open.size;
  for (const handle of open) clear(handle as Parameters<typeof clearTimeout>[0]);
  return left;
}
const sentence = (r: { error?: string }): string => r.error ?? "";

describe("it fails, in one sentence, when", () => {
  it("there is no key: it names the option and sends nothing", async () => {
    const r = await verify({ dsn: `${url}/v` });
    expect(r.success).toBe(false);
    expect(sentence(r)).toMatch(/clientKey/);
    expect(sentence(r)).toMatch(/no environment variable/);
    expect(r.steps.at(-1)).toMatchObject({ step: "init", status: "failed", message: r.error });
    expect(hits).toHaveLength(0);
  });

  it("there is no key and no dsn", async () => {
    expect((await verify({})).success).toBe(false);
  });

  it.each([
    [401, /refused the client key \(status 401\)/],
    [403, /refused the client key \(status 403\)/],
    [402, /has no balance \(status 402\)/],
    [404, /nothing at the ingest address \(status 404\)/],
    [429, /limiting requests \(status 429\)/],
    [418, /refused the event \(status 418\)/],
    [500, /failed to take the event \(status 500\)/],
    [503, /failed to take the event \(status 503\)/],
  ])("the server answers %i", async (status, words) => {
    answer = { status, body: `{"secretbody":"hunter2"}` };
    const r = await verify({ dsn: `${url}/v?token=SECRETQUERY`, clientKey: KEY });
    expect(r.success).toBe(false);
    expect(sentence(r)).toMatch(words);
    expect(sentence(r)).toContain(url);
    expect(r.steps.at(-1)).toMatchObject({ status: "failed", message: r.error });
    for (const text of [JSON.stringify(r), printVerifyResult(r)]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("SECRETQUERY");
      expect(text).not.toContain("hunter2");
    }
    expect(printVerifyResult(r)).toContain(`[FAIL] ${r.error}`);
    expect(hits).toHaveLength(1); // no retry
  });

  it("the host can not be reached", async () => {
    const dead = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const r = await verify({ dsn: `${dead}/v`, clientKey: KEY });
    expect(r.success).toBe(false);
    expect(sentence(r)).toBe(`Could not reach ${dead}.`);
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  it("there is no answer within the timeout: it ends by itself and leaves no timer", async () => {
    answer = { status: 200, never: true };
    const before = timers();
    const start = Date.now();
    const r = await verify({ dsn: `${url}/v`, clientKey: KEY, timeout: 150 });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.success).toBe(false);
    expect(sentence(r)).toBe(`No answer from ${url} within 150ms.`);
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it.each([
    ["enabled is false", { enabled: false }],
    ["sampleRate is 0", { sampleRate: 0 }],
    ["beforeSend returned null", { beforeSend: () => null }],
  ])("the config drops the event: %s", async (why, extra) => {
    const r = await verify({ dsn: `${url}/v`, clientKey: KEY, ...extra });
    expect(r.success).toBe(false);
    expect(sentence(r)).toBe(`The event was not sent: ${why}.`);
    expect(hits).toHaveLength(0);
  });

  it("beforeSend throws: it never rejects", async () => {
    const r = await verify({ dsn: `${url}/v`, clientKey: KEY, beforeSend: () => { throw new Error("x"); } });
    expect(r.success).toBe(false);
    expect(sentence(r)).toBe("The event could not be sent.");
    expect(hits).toHaveLength(0);
  });

  // A key the server does not know is answered 200, with the event dropped.
  it.each([
    ["no_project_key", "does not know this client key (no_project_key)."],
    ["payment_required", "has no card on file for this project (payment_required)."],
    ["insufficient_credits", "has no balance left for this project (insufficient_credits)."],
    ["unsupported_type", "does not store messages, so the key could not be checked (unsupported_type)."],
    ["store_failed", "answered 200 but dropped the event (store_failed)."],
    ["constructor", "answered 200 but dropped the event (constructor)."],
    ["Bearer osk_secret", "answered 200 but dropped the event."],
  ])("the answer says the event was dropped: %s", async (reason, words) => {
    answer = { status: 200, body: JSON.stringify({ received: true, processed: 1, droppedEvents: [{ index: 0, reason, type: "message" }] }) };
    const r = await verify({ dsn: `${url}/v`, clientKey: KEY });
    expect(r.success).toBe(false);
    expect(sentence(r)).toBe(`${url} ${words}`);
  });

  it.each([["a page", "<!doctype html><title>Hello</title>"], ["a word", '"ok"'], ["null", "null"], ["half of it", '{"received":tr']])("the answer is %s", async (_what, body) => {
    answer = { status: 200, body };
    const r = await verify({ dsn: `${url}/v`, clientKey: KEY });
    expect(r.success).toBe(false);
    expect(sentence(r)).toBe(`${url} answered 200, but not the way the ingest address does.`);
  });

  it("the dsn is not a web address", async () => {
    const r = await verify({ dsn: "ftp://example.test/x", clientKey: KEY });
    expect(r.success).toBe(false);
    expect(sentence(r)).toMatch(/not a web address/);
  });
});

describe("it succeeds when the server took the event", () => {
  it("2xx: one message event, with the key, and nothing left behind", async () => {
    const before = timers();
    const seen: string[] = [];
    let r!: Awaited<ReturnType<typeof verify>>;
    expect(await leftOver(10000, async () => (r = await verify({ dsn: `${url}/v`, clientKey: KEY, onProgress: (s) => seen.push(`${s.step}:${s.status}`) })))).toBe(0);
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([["init", "success"], ["send", "success"], ["flush", "success"], ["confirm", "success"]]);
    expect(seen.length).toBeGreaterThan(4);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("/v/ingest");
    expect(hits[0].key).toBe(KEY);
    const [wire] = hits[0].body.events!;
    expect(wire.type).toBe("message");
    expect(wire).toMatchObject({ id: r.eventId, message: "Codmir SDK setup verified", tags: { source: "sdk-verify" } });
    expect(timers()).toBeLessThanOrEqual(before);
    expect(printVerifyResult(r)).toContain("[OK]   Connection verified");
  });

  it.each([["the real one", '{"received":true,"processed":1,"breakdown":{"errors":0}}'], ["an empty one", ""], ["an empty list", '{"droppedEvents":[]}']])("2xx with %s", async (_what, body) => {
    answer = { status: 200, body };
    expect(await verify({ dsn: `${url}/v`, clientKey: KEY })).toMatchObject({ success: true });
  });

  it("two at once are two requests and two answers", async () => {
    answer = { status: 200, body: "{}", delayMs: 50 };
    const [a, b] = await Promise.all([verify({ dsn: `${url}/v`, clientKey: KEY }), verify({ dsn: `${url}/v`, clientKey: KEY })]);
    expect([a.success, b.success]).toEqual([true, true]);
    expect(a.eventId).not.toBe(b.eventId);
    expect(hits).toHaveLength(2);
  });

  it("quickVerify follows", async () => {
    expect(await quickVerify(`${url}/v`)).toBe(false); // a dsn alone has no key
    expect(await quickVerify(KEY, { dsn: `${url}/v` })).toBe(true);
    answer = { status: 401 };
    expect(await quickVerify(KEY, { dsn: `${url}/v` })).toBe(false);
  });
});

describe("the app's client is left alone", () => {
  afterEach(() => overseer.close());

  it("same client, tags, user, queue and breadcrumbs before and after", async () => {
    overseer.init({ dsn: `${url}/app`, clientKey: "osk_app", initialTags: { team: "a" }, initialUser: { id: "u1" } });
    overseer.addBreadcrumb({ message: "before" });
    const client = overseer.getClient()!;
    const tagsBefore = client.getTags();
    overseer.captureException(new Error("app error")); // queued, flush timer pending
    const r = await verify({ dsn: `${url}/v`, clientKey: KEY });
    expect(r.success).toBe(true);
    expect(overseer.getClient()).toBe(client);
    expect(client.getTags()).toEqual(tagsBefore);
    expect(hits.filter((h) => h.path.startsWith("/app"))).toHaveLength(0); // the app's queue was not flushed by it
    expect(await overseer.flush()).toBe(true);
    const app = hits.filter((h) => h.path === "/app/ingest").flatMap((h) => h.body.events!);
    expect(app).toHaveLength(1);
    expect(app[0].event).toMatchObject({ message: "app error", user: { id: "u1" }, tags: { team: "a" } });
    expect(app[0].event.tags).not.toHaveProperty("source");
    expect(app[0].event.breadcrumbs.map((b: { message: string }) => b.message)).toEqual(["before"]);
    const verifyEvents = hits.filter((h) => h.path === "/v/ingest").flatMap((h) => h.body.events!);
    expect(verifyEvents).toHaveLength(1);
    expect(verifyEvents[0].user).toBeUndefined();
    expect(verifyEvents[0].breadcrumbs ?? []).toEqual([]);
    expect(verifyEvents[0].tags).toEqual({ source: "sdk-verify" });
    expect(verifyEvents[0].sdk).toMatchObject({ name: expect.any(String), version: expect.any(String) });
  });

  it("the app's client slot is as it was", async () => {
    const before = overseer.getClient();
    await verify({ dsn: `${url}/v`, clientKey: KEY });
    expect(overseer.getClient()).toBe(before);
  });
});

describe("flush(timeout)", () => {
  const make = (): overseer.OverseerClient => {
    const c = new overseer.OverseerClient({ dsn: `${url}/f`, clientKey: KEY });
    c.init();
    return c;
  };

  it("0 and 50 give false while the answer is slow, and no argument waits for it", async () => {
    answer = { status: 200, body: "{}", delayMs: 300 };
    const c = make();
    c.captureMessage("a");
    expect(await c.flush(0)).toBe(false);
    expect(await c.flush(50)).toBe(false);
    expect(await c.flush()).toBe(true);
    expect(await c.flush(0)).toBe(true); // nothing left queued
    c.close();
  });

  it("two callers with different timeouts each get their own answer", async () => {
    answer = { status: 200, body: "{}", delayMs: 200 };
    const c = make();
    c.captureMessage("a");
    expect(await Promise.all([c.flush(20), c.flush(5000), c.flush()])).toEqual([false, true, true]);
    c.close();
  });

  it("a refused batch counts as sent, a retried one does not", async () => {
    const c = make();
    answer = { status: 401 };
    c.captureMessage("a");
    expect(await c.flush(2000)).toBe(true);
    answer = { status: 500 };
    c.captureMessage("b");
    expect(await c.flush(2000)).toBe(false);
    c.close();
  });

  it("leaves no timer, and a late answer is no unhandled rejection", async () => {
    answer = { status: 200, body: "{}", delayMs: 100 };
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): void => void rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const c = make();
      const before = timers();
      c.captureMessage("a");
      expect(await c.flush(10)).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      c.captureMessage("b");
      expect(await leftOver(5000, async () => expect(await c.flush(5000)).toBe(true))).toBe(0);
      expect(timers()).toBeLessThanOrEqual(before);
      c.close();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

const dist = fileURLToPath(new URL("../../../dist/", import.meta.url));
describe.skipIf(!existsSync(`${dist}verify/index.cjs`))("the built dist", () => {
  it.each([["cjs", "--input-type=commonjs", 'require(DIST + "verify/index.cjs")'], ["esm", "--input-type=module", 'import(DIST_URL + "verify/index.js")']] as const)(
    "%s: a server that never answers does not keep the process alive",
    async (_format, flag, load) => {
      answer = { status: 200, never: true };
      const script = `const DIST = process.env.DIST; const DIST_URL = "file://" + DIST;
        Promise.resolve(${load}).then((m) => m.verify({ dsn: process.env.SERVER + "/v", clientKey: "osk_x", timeout: 300 })).then((r) => { console.log(JSON.stringify(r.error)); });`;
      const { stdout } = await promisify(execFile)(process.execPath, [flag, "-e", script], { env: { ...process.env, DIST: dist, SERVER: url }, timeout: 15_000 });
      expect(JSON.parse(stdout)).toBe(`No answer from ${url} within 300ms.`);
    },
    20_000,
  );
});

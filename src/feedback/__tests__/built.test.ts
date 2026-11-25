/**
 * The built files (`dist/feedback`, `dist/overseer`) against a real local HTTP server that enforces the door's contract:
 * in Node as ESM and as CommonJS, and as the browser bundle esbuild makes, run with a page's `location` and `localStorage`.
 * Skips without a build; CI runs this file after one.
 */
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import vm from "node:vm";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FeedbackResult } from "../index";
import { KEY, createDoor, type Door, type DoorAnswer } from "./door";
import { REPLAY_ID, fakeLocalStorage } from "./harness";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const hasDist = existsSync(`${root}dist/feedback/index.js`) && existsSync(`${root}dist/feedback/index.cjs`);

let server: Server;
let base: string;
let door: Door;

beforeAll(async () => {
  if (!hasDist) return;
  door = createDoor();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const answer: DoorAnswer = door.handle(req.method ?? "GET", req.url ?? "/", headers, Buffer.concat(chunks).toString("utf8"));
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/overseer`;
});

afterAll(async () => {
  if (hasDist) await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Api {
  init(config: Record<string, unknown>): void;
  close(): void;
  addBreadcrumb(crumb: Record<string, unknown>): void;
  captureException(error: Error): string;
  setReplayHook(hook: { getReplayId(): string | null; onError(id: string): void }): void;
  sendFeedback(input: string | Record<string, unknown>): Promise<FeedbackResult>;
  deleteFeedback(id: string, token?: string): Promise<{ ok: boolean; reason?: string }>;
  listFeedback(): Array<{ id: string; at: string }>;
}

const CONFIG = () => ({
  dsn: base,
  clientKey: KEY,
  environment: "production",
  release: "1.2.3",
  initialUser: { id: "u-1", email: "ann@example.com", username: "ann" },
  tracePropagationTargets: ["https://api.shop.example"],
});

/** The whole story against the server, through any build of the two entries. */
async function story(api: Api, label: string): Promise<void> {
  const before = door.accepted.length;
  api.init(CONFIG());
  api.setReplayHook({ getReplayId: () => REPLAY_ID, onError: () => undefined });
  const eventId = api.captureException(new Error(`${label}: save failed for ann@example.com`));
  api.addBreadcrumb({ category: "fetch", message: "POST", data: { method: "post", url: "https://api.shop.example/v2/orders?token=SECRET", status: 500 } });
  api.addBreadcrumb({ category: "fetch", message: "POST", data: { method: "POST", url: `${base}/replay`, status: 500 } });

  const result = await api.sendFeedback({ text: `${label}: the save button does nothing`, replyWhenFixed: true });
  expect(result).toMatchObject({ ok: true, known: false });
  const accepted = door.accepted[before] as Record<string, unknown>;
  expect(accepted).toMatchObject({
    replayId: REPLAY_ID,
    eventId,
    failed: { method: "POST", path: "/v2/orders", status: 500 },
    environment: "production",
    release: "1.2.3",
    userId: "u-1",
    replyWhenFixed: true,
    sdk: { name: "@codmir/sdk" },
  });
  expect(accepted).not.toHaveProperty("pagePath");
  const raw = door.requests[door.requests.length - 1].raw;
  for (const secret of ["ann@example.com", "SECRET", "api.shop.example", "ann"]) expect(raw, secret).not.toContain(secret);

  const id = (result as { id: string }).id;
  expect(api.listFeedback().map((r) => r.id)).toContain(id);
  expect(await api.deleteFeedback(id)).toEqual({ ok: true });
  expect(api.listFeedback().map((r) => r.id)).not.toContain(id);
  expect(door.stored.has(id)).toBe(false);

  // the door's refusals, through a real socket
  const refused = async (answer: DoorAnswer): Promise<FeedbackResult> => {
    door.queue.push(answer);
    return api.sendFeedback(`${label}: again ${Math.random()}`);
  };
  expect(await refused({ status: 402, body: "{}" })).toEqual({ ok: false, reason: "payment_required", status: 402 });
  expect(await refused({ status: 429, headers: { "retry-after": "12" }, body: "{}" })).toEqual({ ok: false, reason: "rate_limited", status: 429, retryAfterMs: 12000 });
  expect(await refused({ status: 200, headers: { "content-type": "text/html" }, body: "<html>hotel wifi</html>" })).toMatchObject({ ok: false, reason: "unavailable" });
  expect(await refused({ status: 503, body: "" })).toEqual({ ok: false, reason: "unavailable", status: 503 });

  api.close();
  api.init({ ...CONFIG(), clientKey: "osk_wrong" });
  expect(await api.sendFeedback("wrong key")).toEqual({ ok: false, reason: "unauthorized", status: 401 });
  api.init({ ...CONFIG(), dsn: "http://127.0.0.1:1/api/overseer" });
  expect(await api.sendFeedback("nobody home")).toEqual({ ok: false, reason: "unavailable" });
  api.init({ ...CONFIG(), enabled: false });
  expect(await api.sendFeedback("off")).toEqual({ ok: false, reason: "not_configured" });
  api.close();
}

describe.skipIf(!hasDist)("the built files against a server that enforces the door's contract", () => {
  // `story` is a visitor's: a page has a document. Without one the same files are a server's (the last test).
  const page = () => vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  afterEach(() => vi.unstubAllGlobals());

  it("ESM, in Node", async () => {
    page();
    const overseer = await import(pathToFileURL(`${root}dist/overseer/index.js`).href);
    const feedback = await import(pathToFileURL(`${root}dist/feedback/index.js`).href);
    expect(Object.keys(feedback).sort()).toEqual(["deleteFeedback", "listFeedback", "sendFeedback"]);
    await story(
      {
        ...overseer,
        setReplayHook: (hook) => overseer.getClient().setReplayHook(hook),
        sendFeedback: feedback.sendFeedback,
        deleteFeedback: feedback.deleteFeedback,
        listFeedback: feedback.listFeedback,
      },
      "esm",
    );
  });

  it("CommonJS, in Node: each entry has its own copy of the code, and still one client", async () => {
    page();
    const require = createRequire(import.meta.url);
    const overseer = require(`${root}dist/overseer/index.cjs`);
    const feedback = require(`${root}dist/feedback/index.cjs`);
    expect(Object.keys(feedback).sort()).toEqual(["deleteFeedback", "listFeedback", "sendFeedback"]);
    await story(
      {
        ...overseer,
        setReplayHook: (hook) => overseer.getClient().setReplayHook(hook),
        sendFeedback: feedback.sendFeedback,
        deleteFeedback: feedback.deleteFeedback,
        listFeedback: feedback.listFeedback,
      },
      "cjs",
    );
  });

  it("the browser bundle, run with a page's location and localStorage", async () => {
    const result = await build({
      stdin: {
        contents: `
          import * as o from ${JSON.stringify(`${root}dist/overseer/index.js`)};
          import * as f from ${JSON.stringify(`${root}dist/feedback/index.js`)};
          globalThis.__api = { ...o, setReplayHook: (hook) => o.getClient().setReplayHook(hook), sendFeedback: f.sendFeedback, deleteFeedback: f.deleteFeedback, listFeedback: f.listFeedback };
        `,
        resolveDir: root,
        loader: "js",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      minify: true,
      logLevel: "silent",
    });
    const ls = fakeLocalStorage();
    const address = new URL("https://app.example/checkout?email=ann%40example.com&token=SECRET#access_token=Z");
    const sandbox: Record<string, unknown> = {
      fetch: (input: string, init?: RequestInit) => fetch(input, init),
      URL,
      Headers,
      AbortController,
      Response,
      setTimeout,
      clearTimeout,
      crypto: globalThis.crypto,
      console,
      location: address,
      localStorage: ls,
      document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    };
    const context = vm.createContext(sandbox);
    // The bundle's globals are the page's: no process, no require, no Buffer.
    expect(vm.runInContext("typeof process + typeof require + typeof Buffer + typeof window", context)).toBe("undefinedundefinedundefinedundefined");
    vm.runInContext(result.outputFiles[0].text, context);
    const api = (context as { __api: Api }).__api;

    const before = door.accepted.length;
    api.init(CONFIG());
    const eventId = api.captureException(new Error("browser bundle"));
    const sent = await api.sendFeedback("from the bundle");
    expect(sent).toMatchObject({ ok: true });
    expect(door.accepted[before]).toMatchObject({ pagePath: "/checkout", eventId, userId: "u-1", environment: "production" });
    const raw = door.requests[door.requests.length - 1].raw;
    for (const secret of ["SECRET", "ann@example.com", "access_token", "app.example"]) expect(raw, secret).not.toContain(secret);
    expect(JSON.parse(ls.map.get("codmir:feedback")!)).toEqual({ [KEY]: [{ id: (sent as { id: string }).id, token: expect.any(String), at: expect.any(String) }] });
    expect(ls.map.get("codmir:feedback")).not.toContain("from the bundle");
    expect(await api.deleteFeedback((sent as { id: string }).id)).toEqual({ ok: true });
    api.close();
  });

  it("on a server, in Node: nothing of the shared client but the environment and the release", async () => {
    const overseer = await import(pathToFileURL(`${root}dist/overseer/index.js`).href);
    const feedback = await import(pathToFileURL(`${root}dist/feedback/index.js`).href);
    const before = door.accepted.length;
    overseer.init(CONFIG());
    overseer.getClient().setReplayHook({ getReplayId: () => REPLAY_ID, onError: () => undefined });
    overseer.captureException(new Error("another visitor's"));
    const sent = await feedback.sendFeedback("from a server");
    expect(sent).toMatchObject({ ok: true });
    expect(Object.keys(door.accepted[before] as object).sort()).toEqual(["at", "environment", "release", "sdk", "text"]);
    expect(feedback.listFeedback()).toEqual([]);
    expect(await feedback.deleteFeedback(sent.id)).toEqual({ ok: false, reason: "not_found" });
    expect(await feedback.deleteFeedback(sent.id, sent.reporterToken)).toEqual({ ok: true });
    overseer.close();
  });
});

/** CSL-5593: Express and the other server wrappers share one async context strategy, installed once. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../context", async (importActual) => {
  const actual = await importActual<typeof import("../context")>();
  return { ...actual, setContextStrategy: vi.fn(actual.setContextStrategy) };
});

import * as Codmir from "../../express/index";
import { codmirTracing } from "../../hono/index";
import { setContextStrategy } from "../context";
import { instrumentFetch } from "../index";
import { sentTransactions, type FetchCall } from "./helpers";

const INGEST = "https://ingest.example.test/api/overseer";
let calls: FetchCall[];
let restoreFetch: () => void;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
      return new Response("{}", { status: 200 });
    }),
  );
  restoreFetch = instrumentFetch({ breadcrumbs: false });
  Codmir.init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 1 });
});
afterEach(async () => {
  await Codmir.close();
  restoreFetch();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeReq(path: string): any {
  return { method: "GET", url: path, originalUrl: path, path, baseUrl: "", params: {}, query: {}, headers: {} };
}
function fakeRes(): any {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    statusCode: 200,
    on(event: string, fn: () => void) { (handlers[event] ??= []).push(fn); return this; },
    emit(event: string) { (handlers[event] ?? []).forEach((f) => f()); },
  };
}

/** One Express request that makes a downstream call after a delay, so requests interleave. */
async function expressRequest(mw: ReturnType<typeof Codmir.tracingHandler>, path: string, delayMs: number): Promise<void> {
  const res = fakeRes();
  await new Promise<void>((resolve) => {
    mw(fakeReq(path), res, () => {
      void sleep(delayMs).then(async () => {
        await fetch(`https://api.example.test${path}`);
        resolve();
      });
    });
  });
  res.emit("finish");
}

describe("one context strategy for every server wrapper", () => {
  it("installs it once, however many wrappers and requests, and parents each fetch to its own root", async () => {
    const mw = Codmir.tracingHandler();
    const mw2 = Codmir.tracingHandler(); // a second mount must not install again either
    const app = new Hono();
    app.use(codmirTracing());
    app.get("/h/:id", async (c) => {
      await sleep(c.req.param("id") === "1" ? 15 : 3);
      await fetch(`https://api.example.test/h/${c.req.param("id")}`);
      return c.text("ok");
    });

    await Promise.all([
      expressRequest(mw, "/e/1", 12),
      expressRequest(mw2, "/e/2", 2),
      app.request("/h/1"),
      app.request("/h/2"),
    ]);
    await Codmir.flush();

    const txs = sentTransactions(calls);
    expect(txs).toHaveLength(4);
    for (const tx of txs) {
      const path = tx.name.split(" ")[1].replace(/:id/, "");
      expect(tx.spans, tx.name).toHaveLength(1);
      expect(tx.spans[0]).toMatchObject({ op: "http.client", parent_span_id: tx.span_id });
      if (tx.name.includes("/e/")) expect(tx.spans[0].description, tx.name).toContain(path);
    }
    const hono = txs.filter((t) => t.name.startsWith("GET /h/"));
    expect(hono.map((t) => t.spans[0].description).sort()).toEqual([
      expect.stringContaining("/h/1"),
      expect.stringContaining("/h/2"),
    ]);
    expect(vi.mocked(setContextStrategy)).toHaveBeenCalledTimes(1);
  });
});

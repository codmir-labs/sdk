/** `tracesSampler` decides every trace root and wins over `tracesSampleRate`; without one the old rule holds. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Codmir from "../../express/index";
import type { OverseerConfig, TracesSamplerContext } from "../../overseer/index";
import { flush, init, close } from "../../overseer/index";
import { formatTraceparent, generateSpanId, generateTraceId, getActiveSpan, parseTraceparent, startTransaction } from "../index";
import { sentTransactions, type FetchCall } from "./helpers";

const INGEST = "https://ingest.example.test/api/overseer";
let calls: FetchCall[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
      return new Response("{}", { status: 200 });
    }),
  );
});
afterEach(() => {
  close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(config: Partial<OverseerConfig> = {}): void {
  init({ dsn: INGEST, clientKey: "osk_test", ...config });
}

async function sent(): Promise<any[]> {
  await flush();
  return sentTransactions(calls);
}

function fakeReq(path: string, headers: Record<string, string> = {}): any {
  return { method: "GET", url: path, originalUrl: path, path: path.split("?")[0], baseUrl: "", params: {}, query: {}, headers: { host: "shop.example.test", ...headers } };
}
function fakeRes(): any {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    statusCode: 200,
    on(event: string, fn: () => void) { (handlers[event] ??= []).push(fn); return this; },
    emit(event: string) { (handlers[event] ?? []).forEach((f) => f()); },
  };
}

/** Serves one request through the Express tracing handler; returns the `traceparent` the handler's code would send out. */
function serve(path: string, headers: Record<string, string> = {}): string | undefined {
  const res = fakeRes();
  let outgoing: string | undefined;
  Codmir.tracingHandler()(fakeReq(path, headers), res, () => {
    outgoing = getActiveSpan()?.toTraceparent();
  });
  res.emit("finish");
  return outgoing;
}

describe("tracesSampler: sampling by route", () => {
  it("keeps the checkout root and drops the health check, whose traceparent says unsampled", async () => {
    start({ tracesSampler: ({ name }) => !name.includes("/health") });
    const kept = startTransaction({ op: "http.server", name: "GET /checkout" });
    const dropped = startTransaction({ op: "http.server", name: "GET /health" });
    expect(parseTraceparent(kept.toTraceparent())?.sampled).toBe(true);
    expect(parseTraceparent(dropped.toTraceparent())?.sampled).toBe(false);
    kept.end();
    dropped.end();
    const txs = await sent();
    expect(txs.map((t) => t.name)).toEqual(["GET /checkout"]);
  });

  it("does the same through the Express handler", async () => {
    start({ tracesSampler: ({ request }) => request?.url.endsWith("/checkout") ?? false });
    const health = serve("/health");
    const checkout = serve("/checkout?cart=7");
    expect(parseTraceparent(health)?.sampled).toBe(false);
    expect(parseTraceparent(checkout)?.sampled).toBe(true);
    const txs = await sent();
    expect(txs.map((t) => t.name)).toEqual(["GET /checkout"]);
  });

  it("calls the sampler for a root only, never for a child span", async () => {
    const sampler = vi.fn(() => true);
    start({ tracesSampler: sampler });
    const root = startTransaction({ op: "http.server", name: "GET /a" });
    root.startChild({ op: "db", name: "select" }).end();
    root.startChild({ op: "db", name: "select 2" }).end();
    root.end();
    expect(sampler).toHaveBeenCalledTimes(1);
    expect((await sent())[0].spans).toHaveLength(2);
  });
});

describe("tracesSampler: precedence over tracesSampleRate", () => {
  it("sends nothing with rate 1 and a sampler answering false", async () => {
    start({ tracesSampleRate: 1, tracesSampler: () => false });
    startTransaction({ op: "x", name: "a" }).end();
    expect(await sent()).toHaveLength(0);
  });

  it("sends the transaction with rate 0 and a sampler answering true", async () => {
    start({ tracesSampleRate: 0, tracesSampler: () => true });
    startTransaction({ op: "x", name: "a" }).end();
    expect(await sent()).toHaveLength(1);
  });

  it("sends nothing when the SDK is disabled, and never calls the sampler", async () => {
    const sampler = vi.fn(() => true);
    start({ enabled: false, tracesSampler: sampler });
    startTransaction({ op: "x", name: "a" }).end();
    expect(sampler).not.toHaveBeenCalled();
    expect(await sent()).toHaveLength(0);
  });
});

describe("without a sampler: the incoming flag decides (today's rule)", () => {
  it("samples an incoming flag of 1 at rate 0.5, and not a flag of 0", async () => {
    start({ tracesSampleRate: 0.5 });
    for (let i = 0; i < 20; i++) {
      expect(startTransaction({ op: "x", name: "a", traceparent: formatTraceparent(generateTraceId(), generateSpanId(), true) }).sampled).toBe(true);
      expect(startTransaction({ op: "x", name: "a", traceparent: formatTraceparent(generateTraceId(), generateSpanId(), false) }).sampled).toBe(false);
    }
  });

  it("records nothing at rate 0, even under a sampled flag", () => {
    start({ tracesSampleRate: 0 });
    expect(startTransaction({ op: "x", name: "a", traceparent: formatTraceparent(generateTraceId(), generateSpanId(), true) }).sampled).toBe(false);
  });
});

describe("tracesSampler: the context", () => {
  it("gets name, op and an undefined parentSampled for a fresh root, with no request key", () => {
    const seen: TracesSamplerContext[] = [];
    start({ tracesSampler: (c) => (seen.push(c), 1) });
    startTransaction({ op: "queue.process", name: "job" });
    expect(seen).toEqual([{ name: "job", op: "queue.process" }]);
    expect("parentSampled" in seen[0]).toBe(false);
  });

  it("gets the incoming flag as parentSampled, and may follow it", () => {
    const seen: Array<boolean | undefined> = [];
    start({ tracesSampler: ({ parentSampled }) => (seen.push(parentSampled), parentSampled ?? false) });
    const yes = startTransaction({ op: "x", name: "a", traceparent: formatTraceparent(generateTraceId(), generateSpanId(), true) });
    const no = startTransaction({ op: "x", name: "a", traceparent: formatTraceparent(generateTraceId(), generateSpanId(), false) });
    const none = startTransaction({ op: "x", name: "a" });
    expect(seen).toEqual([true, false, undefined]);
    expect([yes.sampled, no.sampled, none.sampled]).toEqual([true, false, false]);
  });

  it("gets the request method and its URL without the query string from the Express handler", () => {
    const seen: TracesSamplerContext[] = [];
    start({ tracesSampler: (c) => (seen.push(c), 1) });
    const traceId = generateTraceId();
    serve("/users/42?token=secret#frag", { traceparent: formatTraceparent(traceId, generateSpanId(), true) });
    expect(seen).toEqual([
      { name: "GET /users/42", op: "http.server", parentSampled: true, request: { method: "GET", url: "http://shop.example.test/users/42" } },
    ]);
    expect(JSON.stringify(seen)).not.toContain("secret");
  });
});

describe("tracesSampler: a throwing sampler", () => {
  it("counts as 0, sends nothing, never throws, and answers the request", async () => {
    start({ tracesSampler: () => { throw new Error("boom"); } });
    let answered = false;
    const res = fakeRes();
    expect(() => {
      Codmir.tracingHandler()(fakeReq("/a"), res, () => { answered = true; });
      res.emit("finish");
    }).not.toThrow();
    expect(answered).toBe(true);
    expect(await sent()).toHaveLength(0);
  });

  it("is reported once with debug on, and not at all with debug off", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lines = () => [...log.mock.calls, ...warn.mock.calls, ...err.mock.calls].filter((c) => c.some((a) => String(a).includes("tracesSampler")));
    start({ debug: true, tracesSampler: () => { throw new Error("boom"); } });
    startTransaction({ op: "x", name: "a" });
    startTransaction({ op: "x", name: "b" });
    expect(lines()).toHaveLength(1);
    close();
    log.mockClear(); warn.mockClear(); err.mockClear();
    start({ tracesSampler: () => { throw new Error("boom"); } });
    startTransaction({ op: "x", name: "a" });
    expect(lines()).toHaveLength(0);
  });
});

describe("tracesSampler: answers that are not a probability", () => {
  it.each([
    ["NaN", Number.NaN, false],
    ["-1", -1, false],
    ["a string", "1", false],
    ["null", null, false],
    ["2", 2, true],
    ["true", true, true],
    ["false", false, false],
    ["0", 0, false],
    ["1", 1, true],
  ])("%s", (_label, answer, sampled) => {
    start({ tracesSampler: () => answer as number });
    for (let i = 0; i < 20; i++) expect(startTransaction({ op: "x", name: "a" }).sampled).toBe(sampled);
  });

  it("treats 0.5 as a probability", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.4).mockReturnValueOnce(0.6);
    start({ tracesSampler: () => 0.5 });
    expect(startTransaction({ op: "x", name: "a" }).sampled).toBe(true);
    expect(startTransaction({ op: "x", name: "a" }).sampled).toBe(false);
  });
});

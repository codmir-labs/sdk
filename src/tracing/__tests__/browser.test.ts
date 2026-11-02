// @vitest-environment jsdom
/** CSL-5584: pageload and navigation root transactions in the browser. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, flush, init } from "../../overseer/index";
import { getActiveSpan, instrumentFetch, startSpan } from "../index";
import { startBrowserTracing } from "../browser";
import { TransactionEventSchema, sentTransactions, type FetchCall } from "./helpers";

const INGEST = "https://ingest.example.test/api/overseer";
let calls: FetchCall[];
let teardown: Array<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  teardown = [];
  window.history.replaceState(null, "", "/start");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function start(rate: number, options: Parameters<typeof startBrowserTracing>[0] = {}): void {
  init({ dsn: INGEST, clientKey: "osk_test", environment: "production", release: "1.2.3", tracesSampleRate: rate });
  teardown.push(instrumentFetch({ breadcrumbs: false }));
  teardown.push(startBrowserTracing(options));
}

async function sent(): Promise<any[]> {
  await flush();
  return sentTransactions(calls);
}

describe("pageload transaction", () => {
  it("yields one pageload transaction, named by the path, with fetches as its children", async () => {
    start(1);
    expect(getActiveSpan()?.op).toBe("pageload");
    await fetch("/api/orders");
    await fetch("/api/orders2");
    await vi.advanceTimersByTimeAsync(1000);

    const txs = await sent();
    expect(txs).toHaveLength(1);
    const [tx] = txs;
    expect(tx.op).toBe("pageload");
    expect(tx.name).toBe("/start");
    expect(tx.spans).toHaveLength(2);
    for (const span of tx.spans) {
      expect(span.op).toBe("http.client");
      expect(span.parent_span_id).toBe(tx.span_id);
    }
    // Every request carried a traceparent in the same trace as the transaction.
    const headers = calls.filter((c) => c.url.includes("/api/o") && !c.url.includes("ingest")).map((c) => new Headers(c.init?.headers).get("traceparent"));
    expect(headers).toHaveLength(2);
    for (const h of headers) expect(h?.split("-")[1]).toBe(tx.trace_id);
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
    expect(getActiveSpan()).toBeUndefined();
  });

  it("starts at performance.timeOrigin", async () => {
    start(1);
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect(Date.parse(tx.start_timestamp)).toBe(Math.floor(performance.timeOrigin));
  });

  it("uses the routeName callback and calls onPageloadEnd before ending", async () => {
    const seen: boolean[] = [];
    start(1, {
      routeName: (path, kind) => (kind === "pageload" ? path.replace("/start", "/:page") : undefined),
      onPageloadEnd: (tx) => seen.push(tx.isEnded),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect(tx.name).toBe("/:page");
    expect(seen).toEqual([false]);
  });

  it("sends nothing when tracesSampleRate is 0", async () => {
    start(0);
    await fetch("/api/orders");
    await vi.advanceTimersByTimeAsync(31000);
    expect(await sent()).toEqual([]);
  });
});

describe("navigation transactions", () => {
  it("finishes the pageload and starts a navigation named by the new path on pushState", async () => {
    start(1);
    await fetch("/api/first");
    window.history.pushState(null, "", "/orders/42");
    expect(getActiveSpan()?.op).toBe("navigation");
    await fetch("/api/second");
    await vi.advanceTimersByTimeAsync(1000);

    const txs = await sent();
    expect(txs.map((t) => [t.op, t.name])).toEqual([
      ["pageload", "/start"],
      ["navigation", "/orders/42"],
    ]);
    expect(txs[0].spans.map((s: any) => s.description)).toEqual(["GET /api/first"]);
    expect(txs[1].spans.map((s: any) => s.description)).toEqual(["GET /api/second"]);
    expect(txs[0].trace_id).not.toBe(txs[1].trace_id);
    for (const tx of txs) expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
  });

  it("ignores replaceState to the same path, and follows replaceState to a new one", async () => {
    start(1);
    window.history.replaceState(null, "", "/start?tab=2");
    expect(getActiveSpan()?.op).toBe("pageload");
    window.history.replaceState(null, "", "/moved");
    expect(getActiveSpan()?.op).toBe("navigation");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await sent()).map((t) => [t.op, t.name])).toEqual([
      ["pageload", "/start"],
      ["navigation", "/moved"],
    ]);
  });

  it("starts a navigation on popstate", async () => {
    start(1);
    window.history.pushState(null, "", "/a");
    window.history.pushState(null, "", "/b");
    window.history.back();
    await vi.advanceTimersByTimeAsync(10); // jsdom traverses history on a timer
    await vi.advanceTimersByTimeAsync(1000);
    const names = (await sent()).map((t) => t.name);
    expect(names).toEqual(["/start", "/a", "/b", "/a"]);
  });
});

describe("history patching", () => {
  it("does not double-wrap when started twice, and restores history on teardown", async () => {
    const originalPush = window.history.pushState;
    const originalReplace = window.history.replaceState;
    init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 1 });
    const stop = startBrowserTracing();
    const patched = window.history.pushState;
    expect(patched).not.toBe(originalPush);
    const second = startBrowserTracing();
    expect(window.history.pushState).toBe(patched);
    second(); // the second caller's teardown must not undo the first's patch
    expect(window.history.pushState).toBe(patched);

    window.history.pushState(null, "", "/once");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await sent()).filter((t) => t.op === "navigation")).toHaveLength(1);

    stop();
    expect(window.history.pushState).toBe(originalPush);
    expect(window.history.replaceState).toBe(originalReplace);
  });
});

describe("history patching across module copies", () => {
  it("does not wrap an already-patched history again", async () => {
    init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 1 });
    const stop = startBrowserTracing();
    const patched = window.history.pushState;
    vi.resetModules(); // a second bundled copy of the SDK has its own module state
    const copy = await import("../browser");
    const stopCopy = copy.startBrowserTracing();
    expect(window.history.pushState).toBe(patched);
    stopCopy();
    stop();
  });
});

describe("idle and final timeouts", () => {
  it("ends a transaction with no open spans after idleTimeout, at the last activity", async () => {
    start(1, { idleTimeout: 500 });
    await vi.advanceTimersByTimeAsync(499);
    expect(getActiveSpan()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(getActiveSpan()).toBeUndefined();
    expect(await sent()).toHaveLength(1);
  });

  it("keeps a transaction open while a span is open, then ends it idleTimeout after the span", async () => {
    start(1, { idleTimeout: 500 });
    // A manual child, not startSpan: the browser's stack context keeps a never-settled startSpan on the stack.
    const slow = getActiveSpan()!.startChild({ op: "function", name: "slow" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(getActiveSpan()?.op).toBe("pageload");
    slow.end();
    await vi.advanceTimersByTimeAsync(499);
    expect(getActiveSpan()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    const [tx] = await sent();
    expect(tx.spans.map((s: any) => [s.description, s.status])).toEqual([["slow", "ok"]]);
  });

  it("ends a transaction with a hung span at finalTimeout, cancelling the span", async () => {
    start(1, { idleTimeout: 500, finalTimeout: 10000 });
    getActiveSpan()!.startChild({ op: "function", name: "hung" });
    await vi.advanceTimersByTimeAsync(9999);
    expect(getActiveSpan()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(getActiveSpan()).toBeUndefined();

    const [tx] = await sent();
    expect(tx.spans.map((s: any) => [s.description, s.status])).toEqual([["hung", "cancelled"]]);
    expect(Date.parse(tx.end_timestamp) - Date.parse(tx.start_timestamp)).toBeGreaterThanOrEqual(10000);
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
  });
});

describe("a startSpan that never settles (CSL-5592)", () => {
  it("does not stay active after a navigation replaces its root", async () => {
    start(1);
    void startSpan({ op: "function", name: "hung" }, () => new Promise<void>(() => {}));
    window.history.pushState(null, "", "/next");
    expect(getActiveSpan()?.op).toBe("navigation");
    await fetch("/api/after");
    await vi.advanceTimersByTimeAsync(1000);

    const txs = await sent();
    const nav = txs.find((t) => t.op === "navigation");
    const pageload = txs.find((t) => t.op === "pageload");
    expect(nav.spans.map((s: any) => s.description)).toEqual(["GET /api/after"]);
    expect(nav.spans[0].parent_span_id).toBe(nav.span_id);
    expect(pageload.spans.map((s: any) => s.description)).toEqual(["hung"]);
  });

  it("is ended with a non-ok status when its root ends, however deeply it is nested", async () => {
    start(1);
    void startSpan({ op: "function", name: "outer" }, () => {
      void startSpan({ op: "function", name: "inner" }, () => new Promise<void>(() => {}));
      return new Promise<void>(() => {});
    });
    window.history.pushState(null, "", "/next");
    await vi.advanceTimersByTimeAsync(1000);

    const pageload = (await sent()).find((t) => t.op === "pageload");
    const byName = Object.fromEntries(pageload.spans.map((s: any) => [s.description, s]));
    expect(byName.outer.status).toBe("cancelled");
    expect(byName.inner.status).toBe("cancelled");
  });

  it("leaves the stack clean when the root ends on the final timeout", async () => {
    start(1, { finalTimeout: 2000 });
    void startSpan({ op: "function", name: "hung" }, () => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(2000);
    expect(getActiveSpan()).toBeUndefined();
  });
});

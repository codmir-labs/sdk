// @vitest-environment jsdom
/** CSL-5587: LCP, CLS and INP on the pageload transaction. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, flush, init } from "../../overseer/index";
import { startBrowserTracing } from "../browser";
import { TransactionEventSchema, sentTransactions, type FetchCall } from "./helpers";

const INGEST = "https://ingest.example.test/api/overseer";
let calls: FetchCall[];
let teardown: Array<() => void>;
let callbacks: Array<{ cb: (list: { getEntries(): any[] }) => void; types: string[] }>;

/** A PerformanceObserver that delivers `feed(type, entries)` to every observer of that type, like the browser's buffered replay. */
function stubObserver(types: string[]): void {
  callbacks = [];
  class FakeObserver {
    private mine: string[] = [];
    constructor(private cb: (list: { getEntries(): any[] }) => void) {}
    observe(opts: { type: string }): void {
      this.mine.push(opts.type);
      callbacks.push({ cb: this.cb, types: this.mine });
    }
    takeRecords(): any[] {
      return [];
    }
    disconnect(): void {}
    static supportedEntryTypes = types;
  }
  vi.stubGlobal("PerformanceObserver", FakeObserver);
}
function feed(type: string, entries: any[]): void {
  for (const c of callbacks) if (c.types.includes(type)) c.cb({ getEntries: () => entries.map((e) => ({ entryType: type, ...e })) });
}

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

function start(): void {
  init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 1 });
  teardown.push(startBrowserTracing());
}
async function sent(): Promise<any[]> {
  await flush();
  return sentTransactions(calls);
}
const ALL = ["largest-contentful-paint", "layout-shift", "event", "first-input"];

describe("web vitals on the pageload transaction", () => {
  it("records LCP as the last entry, CLS as the worst session window and INP as the slowest interaction", async () => {
    stubObserver(ALL);
    start();
    feed("largest-contentful-paint", [{ startTime: 800 }, { startTime: 1200 }]);
    feed("layout-shift", [
      { startTime: 100, value: 0.1 },
      { startTime: 400, value: 0.05 }, // window 1: 0.15
      { startTime: 3000, value: 0.2 }, // 2.6 s gap: window 2: 0.2
      { startTime: 3200, value: 0.3, hadRecentInput: true }, // excluded
    ]);
    feed("event", [
      { interactionId: 1, duration: 64 },
      { interactionId: 1, duration: 120 },
      { interactionId: 2, duration: 80 },
      { interactionId: 0, duration: 500 }, // not an interaction
      { interactionId: 3, duration: 24 }, // under the threshold
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect(tx.op).toBe("pageload");
    expect(tx.measurements).toEqual({ lcp: 1200, cls: 0.2, inp: 120 });
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
  });

  it("splits a CLS window at 5 s even with no gap", async () => {
    stubObserver(ALL);
    start();
    const shifts = Array.from({ length: 12 }, (_, i) => ({ startTime: i * 600, value: 0.01 }));
    feed("layout-shift", shifts);
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    // Shifts at 0..4800 ms fill window 1 (9 shifts); 5400 ms is over 5 s from its start, so it opens window 2 (4 shifts).
    expect(tx.measurements.cls).toBeCloseTo(0.09, 10);
  });

  it("stops updating LCP after the first input", async () => {
    stubObserver(ALL);
    start();
    feed("largest-contentful-paint", [{ startTime: 900 }]);
    document.dispatchEvent(new Event("click"));
    feed("largest-contentful-paint", [{ startTime: 5000 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect(tx.measurements.lcp).toBe(900);
  });

  it("uses the p98 interaction past 50 interactions", async () => {
    stubObserver(ALL);
    start();
    feed("event", Array.from({ length: 100 }, (_, i) => ({ interactionId: i + 1, duration: 100 + i })));
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect(tx.measurements.inp).toBe(197); // 100 interactions: skip the two worst
  });

  it("omits measurements when nothing was observed", async () => {
    stubObserver(ALL);
    start();
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect("measurements" in tx).toBe(false);
  });

  it("does not throw and records nothing without PerformanceObserver", async () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    start();
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect("measurements" in tx).toBe(false);
  });

  it("skips entry types the browser does not list", async () => {
    stubObserver(["largest-contentful-paint"]);
    start();
    feed("largest-contentful-paint", [{ startTime: 700 }]);
    feed("layout-shift", [{ startTime: 1, value: 0.5 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect(tx.measurements).toEqual({ lcp: 700 });
  });

  it("gives a navigation transaction no web vitals", async () => {
    stubObserver(ALL);
    start();
    feed("largest-contentful-paint", [{ startTime: 700 }]);
    window.history.pushState(null, "", "/next");
    feed("largest-contentful-paint", [{ startTime: 900 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const txs = await sent();
    const nav = txs.find((t) => t.op === "navigation");
    expect(nav).toBeDefined();
    expect("measurements" in nav).toBe(false);
    expect(txs.find((t) => t.op === "pageload").measurements).toEqual({ lcp: 700 });
  });

  it("the schema copy accepts the flat shape and rejects value/unit objects and unknown names", async () => {
    stubObserver(ALL);
    start();
    feed("largest-contentful-paint", [{ startTime: 700 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const [tx] = await sent();
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
    expect(TransactionEventSchema.safeParse({ ...tx, measurements: { lcp: { value: 700, unit: "millisecond" } } }).success).toBe(false);
    expect(TransactionEventSchema.safeParse({ ...tx, measurements: { lcp: 700, tbt: 1 } }).success).toBe(false);
  });
});

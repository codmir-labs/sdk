/** CSL-5575: spans, sampling, traceparent propagation and fetch instrumentation. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, flush, init } from "../../overseer/index";
import { formatTraceparent, generateSpanId, generateTraceId, instrumentFetch, parseTraceparent, startSpan, startTransaction } from "../index";
import { TransactionEventSchema, sentTransactions, type FetchCall } from "./helpers";

const INGEST = "https://ingest.example.test/api/overseer";
let calls: FetchCall[];
let uninstall: () => void;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  uninstall?.();
  close();
  vi.unstubAllGlobals();
});

function start(rate: number, extra: Record<string, unknown> = {}): void {
  init({ dsn: INGEST, clientKey: "osk_test", environment: "production", release: "1.2.3", tracesSampleRate: rate, ...extra });
  uninstall = instrumentFetch({ breadcrumbs: false });
}

describe("traceparent", () => {
  it("round-trips and rejects malformed or all-zero values", () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    expect(parseTraceparent(formatTraceparent(traceId, spanId, true))).toEqual({ traceId, spanId, sampled: true });
    expect(parseTraceparent(formatTraceparent(traceId, spanId, false))?.sampled).toBe(false);
    expect(parseTraceparent("00-" + "0".repeat(32) + "-" + spanId + "-01")).toBeNull();
    expect(parseTraceparent("00-" + traceId + "-" + "0".repeat(16) + "-01")).toBeNull();
    expect(parseTraceparent("nonsense")).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it("generates ids of the right shape from random bytes, never all zero", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementationOnce((a) => a as never);
    // First draw is all zeros (the mock leaves the buffer untouched); the generator must draw again.
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(generateSpanId()).not.toBe("0".repeat(16));
    spy.mockRestore();
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("transaction wire shape", () => {
  it("serializes a finished root with nested sync and async spans exactly as the server schema reads it", async () => {
    start(1);
    await startSpan({ op: "function", name: "checkout" }, async () => {
      startSpan({ op: "db", name: "select cart" }, () => 1);
      await startSpan({ op: "payment", name: "charge" }, async () => {
        await Promise.resolve();
      });
    });
    await flush();

    const [tx] = sentTransactions(calls);
    const parsed = TransactionEventSchema.safeParse(tx);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    expect(tx).toMatchObject({ type: "transaction", op: "function", name: "checkout", status: "ok", environment: "production", release: "1.2.3" });
    expect(tx.spans.map((s: any) => s.op).sort()).toEqual(["db", "payment"]);
    for (const s of tx.spans) expect(s.parent_span_id).toBe(tx.span_id);
  });

  it("marks a span error when its callback throws or rejects, and rethrows", async () => {
    start(1);
    await expect(
      startSpan({ op: "function", name: "root" }, async () => {
        expect(() => startSpan({ op: "x", name: "sync" }, () => { throw new Error("boom"); })).toThrow("boom");
        await expect(startSpan({ op: "y", name: "async" }, async () => { throw new Error("late"); })).rejects.toThrow("late");
      }),
    ).resolves.toBeUndefined();
    await flush();
    const [tx] = sentTransactions(calls);
    expect(tx.spans.map((s: any) => s.status)).toEqual(["error", "error"]);
    expect(tx.status).toBe("ok");
  });
});

describe("sampling", () => {
  it("sends nothing at tracesSampleRate 0, even for a caller-sampled traceparent", async () => {
    start(0);
    const tx = startTransaction({ op: "http.server", name: "GET /", traceparent: formatTraceparent(generateTraceId(), generateSpanId(), true) });
    tx.end();
    await startSpan({ op: "function", name: "root" }, () => undefined);
    await flush();
    expect(sentTransactions(calls)).toHaveLength(0);
  });

  it("sends exactly one transaction per root at tracesSampleRate 1", async () => {
    start(1);
    await startSpan({ op: "function", name: "root" }, () => undefined);
    await flush();
    expect(sentTransactions(calls)).toHaveLength(1);
  });

  it("decides once per trace and inherits the caller's flag: sampled continues, unsampled stays silent", async () => {
    start(0.5);
    const traceId = generateTraceId();
    const parent = generateSpanId();
    startTransaction({ op: "http.server", name: "in", traceparent: formatTraceparent(traceId, parent, true) }).end();
    startTransaction({ op: "http.server", name: "out", traceparent: formatTraceparent(generateTraceId(), parent, false) }).end();
    await flush();
    const sent = sentTransactions(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ trace_id: traceId, parent_span_id: parent, name: "in" });
  });

  it("records nothing when a root span is outside any client", async () => {
    // No init(): no client, rate 0.
    expect(await startSpan({ op: "function", name: "x" }, async () => 7)).toBe(7);
    expect(calls).toHaveLength(0);
  });
});

describe("fetch instrumentation", () => {
  it("makes an http.client child of the active span and sends it a traceparent for a propagation target", async () => {
    start(1, { tracePropagationTargets: [/^https:\/\/api\.example\.test\//] });
    let rootIds: { traceId: string; spanId: string } | undefined;
    await startSpan({ op: "function", name: "root" }, async (root) => {
      rootIds = { traceId: root.traceId, spanId: root.spanId };
      await fetch("https://api.example.test/users/42?token=secret");
    });
    await flush();

    const outgoing = calls.find((c) => c.url.startsWith("https://api.example.test"))!;
    const header = new Headers(outgoing.init?.headers).get("traceparent");
    const sent = parseTraceparent(header)!;
    expect(sent).toMatchObject({ traceId: rootIds!.traceId, sampled: true });

    const [tx] = sentTransactions(calls);
    const span = tx.spans.find((s: any) => s.op === "http.client");
    expect(span).toMatchObject({ description: "GET /users/42", parent_span_id: rootIds!.spanId, status: "ok" });
    expect(span.span_id).toBe(sent.spanId);
    expect(tx.trace_id).toBe(rootIds!.traceId);
    expect(span.data["http.response.status_code"]).toBe(200);
    // The query string (here a token) never reaches the span.
    expect(JSON.stringify(span)).not.toContain("secret");
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
  });

  it("does not add traceparent to a cross-origin URL that is not a target", async () => {
    start(1, { tracePropagationTargets: ["https://api.example.test"] });
    await startSpan({ op: "function", name: "root" }, async () => {
      await fetch("https://third-party.example.test/pixel");
    });
    expect(new Headers(calls[0].init?.headers).has("traceparent")).toBe(false);
  });

  it("never touches the Codmir ingest URL: no header, no span", async () => {
    start(1, { tracePropagationTargets: [INGEST, /example\.test/] });
    await startSpan({ op: "function", name: "root" }, async () => {
      await fetch(`${INGEST}/ingest`, { method: "POST", body: "{}" });
    });
    await flush();
    const ingestCalls = calls.filter((c) => c.url === `${INGEST}/ingest`);
    expect(ingestCalls.length).toBeGreaterThan(0);
    for (const c of ingestCalls) expect(new Headers(c.init?.headers).has("traceparent")).toBe(false);
    const [tx] = sentTransactions(calls);
    expect(tx.spans.filter((s: any) => s.op === "http.client")).toHaveLength(0);
  });

  it("marks a failed request error, keeps the rejection, and keeps the fetch breadcrumb", async () => {
    uninstall?.();
    init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 1, tracePropagationTargets: ["https://api.example.test"] });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    uninstall = instrumentFetch(); // breadcrumbs on by default
    await startSpan({ op: "function", name: "root" }, async () => {
      await expect(fetch("https://api.example.test/x")).rejects.toThrow("network down");
    });
    const { getClient } = await import("../../overseer/index");
    const crumbs = (getClient() as any).breadcrumbs;
    expect(crumbs.some((b: any) => b.category === "fetch" && b.level === "error" && b.data.error === "network down")).toBe(true);
  });

  it("is idempotent and restores the previous fetch", () => {
    start(1);
    const wrapped = globalThis.fetch;
    const again = instrumentFetch();
    expect(globalThis.fetch).toBe(wrapped);
    again();
    expect(globalThis.fetch).toBe(wrapped);
    uninstall();
    expect(globalThis.fetch).not.toBe(wrapped);
  });
});

// @vitest-environment jsdom
/** CSL-5585: XHR requests become http.client spans like fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, flush, getClient, init } from "../../overseer/index";
import { instrumentXhr, parseTraceparent, startSpan } from "../index";
import { TransactionEventSchema, sentTransactions, type FetchCall } from "./helpers";

const INGEST = "https://ingest.example.test/api/overseer";
type Outcome = { status: number; event: "load" | "error" | "abort" | "timeout" };

let calls: FetchCall[];
let sentHeaders: Array<{ url: string; headers: Record<string, string> }>;
let outcome: Outcome;
let restore: Array<() => void>;
const realProto = {
  open: XMLHttpRequest.prototype.open,
  send: XMLHttpRequest.prototype.send,
  setRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
};

beforeEach(() => {
  calls = [];
  sentHeaders = [];
  restore = [];
  outcome = { status: 200, event: "load" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
  // jsdom would hit the network: replace the transport under the instrumentation with one that settles at once.
  const proto = XMLHttpRequest.prototype;
  const urls = new WeakMap<XMLHttpRequest, { url: string; headers: Record<string, string> }>();
  proto.open = function (this: XMLHttpRequest, _method: string, url: string | URL) {
    urls.set(this, { url: new URL(String(url), window.location.href).href, headers: {} });
  } as typeof proto.open;
  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    urls.get(this)!.headers[name.toLowerCase()] = value;
  };
  proto.send = function (this: XMLHttpRequest) {
    const rec = urls.get(this)!;
    sentHeaders.push(rec);
    Object.defineProperty(this, "status", { value: outcome.status, configurable: true });
    queueMicrotask(() => {
      this.dispatchEvent(new Event(outcome.event));
      this.dispatchEvent(new Event("loadend"));
    });
  };
});

afterEach(() => {
  for (const fn of restore.reverse()) fn();
  close();
  Object.assign(XMLHttpRequest.prototype, realProto);
  vi.unstubAllGlobals();
});

function start(rate: number, extra: Record<string, unknown> = {}, breadcrumbs = false): void {
  init({ dsn: INGEST, clientKey: "osk_test", environment: "production", release: "1.2.3", tracesSampleRate: rate, ...extra });
  restore.push(instrumentXhr({ breadcrumbs }));
}

function xhr(url: string, method = "GET"): Promise<XMLHttpRequest> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.addEventListener("loadend", () => resolve(x));
    x.open(method, url);
    x.send();
  });
}

describe("xhr http.client spans", () => {
  it("makes an http.client child of the active span and sends a traceparent for a propagation target", async () => {
    start(1, { tracePropagationTargets: [/^https:\/\/api\.example\.test\//] });
    let root: { traceId: string; spanId: string } | undefined;
    await startSpan({ op: "function", name: "root" }, async (r) => {
      root = { traceId: r.traceId, spanId: r.spanId };
      await xhr("https://api.example.test/users/42?token=secret", "post");
    });
    await flush();

    const sent = parseTraceparent(sentHeaders[0].headers.traceparent)!;
    expect(sent).toMatchObject({ traceId: root!.traceId, sampled: true });
    const [tx] = sentTransactions(calls);
    const span = tx.spans.find((s: any) => s.op === "http.client");
    expect(span).toMatchObject({ description: "POST /users/42", parent_span_id: root!.spanId, status: "ok" });
    expect(span.span_id).toBe(sent.spanId);
    expect(span.data["http.response.status_code"]).toBe(200);
    expect(JSON.stringify(span)).not.toContain("secret");
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
  });

  it("propagates to a same-origin URL without any target", async () => {
    start(1);
    await startSpan({ op: "function", name: "root" }, async () => {
      await xhr("/api/orders");
    });
    expect(parseTraceparent(sentHeaders[0].headers.traceparent)).not.toBeNull();
  });

  it("does not add traceparent to a cross-origin URL that is not a target", async () => {
    start(1, { tracePropagationTargets: ["https://api.example.test"] });
    await startSpan({ op: "function", name: "root" }, async () => {
      await xhr("https://third-party.example.test/pixel");
    });
    expect(sentHeaders[0].headers.traceparent).toBeUndefined();
  });

  it("keeps a traceparent the caller set", async () => {
    start(1);
    await startSpan({ op: "function", name: "root" }, async () => {
      await new Promise<void>((resolve) => {
        const x = new XMLHttpRequest();
        x.addEventListener("loadend", () => resolve());
        x.open("GET", "/api/mine");
        x.setRequestHeader("traceparent", "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01");
        x.send();
      });
    });
    expect(sentHeaders[0].headers.traceparent).toBe("00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01");
  });

  it("never touches the Codmir ingest URL: no header, no span", async () => {
    start(1, { tracePropagationTargets: [INGEST, /example\.test/] });
    await startSpan({ op: "function", name: "root" }, async () => {
      await xhr(`${INGEST}/ingest`, "POST");
    });
    await flush();
    expect(sentHeaders[0].headers.traceparent).toBeUndefined();
    const [tx] = sentTransactions(calls);
    expect(tx.spans.filter((s: any) => s.op === "http.client")).toHaveLength(0);
  });

  it.each<[string, Outcome]>([
    ["an HTTP 500", { status: 500, event: "load" }],
    ["a network error", { status: 0, event: "error" }],
    ["an abort", { status: 0, event: "abort" }],
    ["a timeout", { status: 0, event: "timeout" }],
  ])("ends the span with status error on %s", async (_name, o) => {
    start(1);
    outcome = o;
    await startSpan({ op: "function", name: "root" }, async () => {
      await xhr("/api/fail");
    });
    await flush();
    const [tx] = sentTransactions(calls);
    const span = tx.spans.find((s: any) => s.op === "http.client");
    expect(span.status).toBe("error");
    if (o.status > 0) expect(span.data["http.response.status_code"]).toBe(o.status);
    else expect(span.data["http.response.status_code"]).toBeUndefined();
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
  });

  it("sends nothing to ingest and marks the traceparent unsampled when tracesSampleRate is 0, and still records the breadcrumb", async () => {
    start(0, {}, true);
    await startSpan({ op: "function", name: "root" }, async () => {
      await xhr("/api/quiet");
    });
    // Same as fetch: the header still carries the trace, flagged not sampled.
    expect(parseTraceparent(sentHeaders[0].headers.traceparent)?.sampled).toBe(false);
    await flush();
    expect(sentTransactions(calls)).toHaveLength(0);
    const crumbs = (getClient() as any).breadcrumbs;
    expect(crumbs.some((b: any) => b.category === "xhr" && b.message === "GET /api/quiet")).toBe(true);
  });
});

describe("xhr patching", () => {
  it("records the xhr breadcrumb with method, url, status and duration", async () => {
    start(1, {}, true);
    outcome = { status: 404, event: "load" };
    await xhr("/api/missing", "get");
    const crumb = (getClient() as any).breadcrumbs.find((b: any) => b.category === "xhr");
    expect(crumb).toMatchObject({ message: "get /api/missing", level: "error", data: { method: "get", url: "/api/missing", status: 404 } });
    expect(typeof crumb.data.duration).toBe("number");
  });

  it("is idempotent when called twice, and restores the previous methods", async () => {
    start(1, {}, true);
    const patched = XMLHttpRequest.prototype.send;
    const again = instrumentXhr();
    again();
    expect(XMLHttpRequest.prototype.send).toBe(patched);
    restore.push(instrumentXhr({ breadcrumbs: true })); // what a second browser init() does
    expect(XMLHttpRequest.prototype.send).toBe(patched);
    await startSpan({ op: "function", name: "root" }, async () => {
      await xhr("/api/once");
    });
    expect((getClient() as any).breadcrumbs.filter((b: any) => b.category === "xhr")).toHaveLength(1);
    restore[0]();
    expect(XMLHttpRequest.prototype.send).not.toBe(patched);
  });
});

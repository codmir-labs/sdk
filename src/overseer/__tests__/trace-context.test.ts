// @vitest-environment jsdom
/**
 * An error captured while a span is active carries that span's trace in `contexts.trace` (`trace_id` and `span_id`),
 * sampled or not; outside any span it carries none, and a capture context's own `contexts.trace` wins. Everything is read
 * from the body `fetch` was given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as express from "../../express/index";
import * as nextjs from "../../nextjs/index";
import { withCodmirTracing } from "../../nextjs/server";
import { startBrowserTracing } from "../../tracing/browser";
import { getActiveSpan, startSpan, startTransaction, withActiveSpan } from "../../tracing/index";
import { captureException, close, flush, init } from "../index";

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const INGEST = "https://ingest.example.test/api/overseer";

let bodies: any[];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, req: RequestInit) => {
      bodies.push(JSON.parse(String(req.body)));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  close();
  vi.unstubAllGlobals();
});

function start(rate: number): void {
  init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: rate, includeSourceContext: false, rateLimit: false });
}

/** Every error event sent so far, and every transaction. */
async function sent(): Promise<{ errors: any[]; transactions: any[] }> {
  await flush();
  const all: any[] = bodies.flatMap((b) => b.events ?? []);
  return {
    errors: all.filter((e) => e.type === "error").map((e) => e.event),
    transactions: all.filter((e) => e.type === "transaction"),
  };
}

describe("an error captured inside a span", () => {
  it("carries the transaction's trace_id and the active span's span_id", async () => {
    start(1);
    let ids: { traceId: string; spanId: string } | undefined;
    await startSpan({ op: "task", name: "checkout" }, async () => {
      const span = getActiveSpan()!;
      ids = { traceId: span.traceId, spanId: span.spanId };
      captureException(new Error("inside"));
    });
    const { errors, transactions } = await sent();
    expect(errors).toHaveLength(1);
    const trace = errors[0].contexts.trace;
    expect(trace.trace_id).toMatch(TRACE_ID);
    expect(trace.span_id).toMatch(SPAN_ID);
    expect(trace).toEqual({ trace_id: ids!.traceId, span_id: ids!.spanId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].trace_id).toBe(trace.trace_id);
    expect(transactions[0].span_id).toBe(trace.span_id);
  });

  it("in a child span carries the child's span_id and the shared trace_id", async () => {
    start(1);
    await startSpan({ op: "task", name: "outer" }, async () => {
      const outer = getActiveSpan()!;
      await startSpan({ op: "db", name: "inner" }, async () => {
        const inner = getActiveSpan()!;
        expect(inner.spanId).not.toBe(outer.spanId);
        captureException(new Error("deep"));
      });
    });
    const { errors, transactions } = await sent();
    const [tx] = transactions;
    const child = tx.spans[0];
    expect(errors[0].contexts.trace).toEqual({ trace_id: tx.trace_id, span_id: child.span_id });
    expect(child.span_id).not.toBe(tx.span_id);
  });

  it("is traced when the trace is not sampled, and no transaction is sent", async () => {
    start(0);
    await startSpan({ op: "task", name: "quiet" }, async () => {
      captureException(new Error("unsampled"));
    });
    const { errors, transactions } = await sent();
    expect(errors[0].contexts.trace.trace_id).toMatch(TRACE_ID);
    expect(errors[0].contexts.trace.span_id).toMatch(SPAN_ID);
    expect(transactions).toHaveLength(0);
  });

  it("is traced after an await, and not after the span has ended", async () => {
    start(1);
    await startSpan({ op: "task", name: "later" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      captureException(new Error("after await"));
    });
    captureException(new Error("after span"));
    const { errors } = await sent();
    const byMessage = Object.fromEntries(errors.map((e) => [e.message, e.contexts.trace]));
    expect(byMessage["after await"].trace_id).toMatch(TRACE_ID);
    expect(byMessage["after span"]).toBeUndefined();
  });
});

describe("an error captured outside any span", () => {
  it("carries no contexts.trace", async () => {
    start(1);
    captureException(new Error("outside"));
    const { errors } = await sent();
    expect(errors[0].contexts).not.toHaveProperty("trace");
  });

  it("carries none with tracing off", async () => {
    init({ dsn: INGEST, clientKey: "osk_test", includeSourceContext: false, rateLimit: false });
    captureException(new Error("untraced"));
    const { errors } = await sent();
    expect(errors[0].contexts).not.toHaveProperty("trace");
  });
});

describe("a capture context", () => {
  it("with its own contexts.trace wins over the active span", async () => {
    start(1);
    const own = { trace_id: "a".repeat(32), span_id: "b".repeat(16) };
    await startSpan({ op: "task", name: "mine" }, async () => {
      captureException(new Error("explicit"), { contexts: { trace: own } });
    });
    const { errors } = await sent();
    expect(errors[0].contexts.trace).toEqual(own);
  });

  it("with other contexts keeps the active span's trace", async () => {
    start(1);
    await startSpan({ op: "task", name: "mine" }, async () => {
      captureException(new Error("other"), { contexts: { cart: { items: 2 } } });
    });
    const { errors } = await sent();
    expect(errors[0].contexts.trace.trace_id).toMatch(TRACE_ID);
    expect(errors[0].contexts.cart).toEqual({ items: 2 });
  });
});

describe("the server integrations", () => {
  it("Express: an error in a handler carries the request's http.server trace", async () => {
    start(1);
    const handlers: Record<string, Array<() => void>> = {};
    const res: any = { statusCode: 200, on: (e: string, fn: () => void) => ((handlers[e] ??= []).push(fn), res) };
    const req: any = { method: "GET", url: "/users/42", originalUrl: "/users/42", path: "/users/42", baseUrl: "", params: {}, query: {}, headers: {} };
    let ids: { traceId: string; spanId: string } | undefined;
    await new Promise<void>((resolve) => {
      express.tracingHandler()(req, res, () => {
        setTimeout(() => {
          const span = getActiveSpan()!;
          ids = { traceId: span.traceId, spanId: span.spanId };
          express.captureException(new Error("in handler"));
          resolve();
        }, 2);
      });
    });
    (handlers.finish ?? []).forEach((f) => f());
    const { errors, transactions } = await sent();
    expect(errors[0].contexts.trace).toEqual({ trace_id: ids!.traceId, span_id: ids!.spanId });
    expect(transactions[0].trace_id).toBe(ids!.traceId);
    expect(transactions[0].op).toBe("http.server");
  });

  it("Next.js: captureRequestError inside withCodmirTracing carries the request's trace", async () => {
    start(1);
    const handler = withCodmirTracing(async (r: Request) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      nextjs.captureRequestError(new Error("in route") as any, { routePath: "/api/x" }, r);
      return Response.json({});
    });
    await handler(new Request("https://next.example.test/api/x", { method: "POST" }));
    const { errors, transactions } = await sent();
    expect(errors[0].contexts.trace.trace_id).toBe(transactions[0].trace_id);
    expect(errors[0].contexts.trace.span_id).toBe(transactions[0].span_id);
  });

  it("two requests in flight each carry their own trace", async () => {
    start(1);
    const handler = withCodmirTracing(async (r: Request) => {
      await new Promise((resolve) => setTimeout(resolve, r.url.endsWith("/a") ? 20 : 5));
      captureException(new Error(new URL(r.url).pathname));
      return Response.json({});
    });
    await Promise.all([handler(new Request("https://next.example.test/a")), handler(new Request("https://next.example.test/b"))]);
    const { errors, transactions } = await sent();
    expect(transactions).toHaveLength(2);
    for (const e of errors) {
      const tx = transactions.find((t) => t.name.endsWith(e.message));
      expect(e.contexts.trace.trace_id).toBe(tx.trace_id);
    }
    expect(errors[0].contexts.trace.trace_id).not.toBe(errors[1].contexts.trace.trace_id);
  });
});

describe("the browser", () => {
  it("an error captured on a page carries the pageload transaction's trace", async () => {
    window.history.replaceState(null, "", "/start");
    start(1);
    const stop = startBrowserTracing();
    try {
      const root = getActiveSpan()!;
      expect(root.op).toBe("pageload");
      captureException(new Error("on the page"));
      const { errors } = await sent();
      expect(errors[0].contexts.trace).toEqual({ trace_id: root.traceId, span_id: root.spanId });
    } finally {
      stop();
    }
  });

  it("a span started inside the page's transaction takes over, then the page's root again", async () => {
    window.history.replaceState(null, "", "/start");
    start(1);
    const stop = startBrowserTracing();
    try {
      const root = getActiveSpan()!;
      const tx = startTransaction({ op: "task", name: "manual" });
      withActiveSpan(tx, () => captureException(new Error("in task")));
      captureException(new Error("on the page"));
      const { errors } = await sent();
      const byMessage = Object.fromEntries(errors.map((e) => [e.message, e.contexts.trace]));
      expect(byMessage["in task"]).toEqual({ trace_id: tx.traceId, span_id: tx.spanId });
      expect(byMessage["on the page"]).toEqual({ trace_id: root.traceId, span_id: root.spanId });
    } finally {
      stop();
    }
  });
});

describe("two copies of the context module", () => {
  it("share the standing root and the default stack, so a copy's error capture sees the other's span", async () => {
    const first = await import("../../tracing/context");
    vi.resetModules();
    const second = await import("../../tracing/context");
    expect(second).not.toBe(first);
    const tx = startTransaction({ op: "task", name: "shared" });
    first.setStandingRoot(tx);
    try {
      expect(second.getActiveSpan()).toBe(tx);
      const child = tx.startChild({ op: "db", name: "q" });
      first.withActiveSpan(child, () => expect(second.getActiveSpan()).toBe(child));
    } finally {
      first.setStandingRoot(undefined);
    }
    expect(second.getActiveSpan()).toBeUndefined();
  });

  it("share the default stack: a span made active through one copy is active in the other, and its errors carry the trace", async () => {
    // Earlier tests in this file install AsyncLocalStorage, which would mask the default stack; run on the default.
    const slots = globalThis as Record<symbol, unknown>;
    const strategySlot = Symbol.for("codmir.tracing.strategy");
    const installed = slots[strategySlot];
    delete slots[strategySlot];
    try {
      vi.resetModules();
      const copy = await import("../../tracing/context");
      start(1);
      const tx = startTransaction({ op: "task", name: "stack" });
      expect(getActiveSpan()).toBeUndefined();
      copy.withActiveSpan(tx, () => {
        expect(getActiveSpan()).toBe(tx);
        captureException(new Error("through the other copy"));
      });
      expect(getActiveSpan()).toBeUndefined();
      const { errors } = await sent();
      expect(errors[0].contexts.trace).toEqual({ trace_id: tx.traceId, span_id: tx.spanId });
    } finally {
      if (installed) slots[strategySlot] = installed;
    }
  });
});

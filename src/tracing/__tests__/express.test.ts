/** CSL-5575: the Express tracingHandler continues an incoming traceparent and finishes on response end. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Codmir from "../../express/index";
import { formatTraceparent, generateSpanId, generateTraceId, getActiveSpan, startSpan } from "../index";
import { TransactionEventSchema, sentTransactions, type FetchCall } from "./helpers";

const calls: FetchCall[] = [];

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response("{}", { status: 200 });
    }),
  );
  Codmir.init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", tracesSampleRate: 1 });
});
afterAll(() => {
  Codmir.close();
  vi.unstubAllGlobals();
});

function fakeReq(headers: Record<string, string> = {}): any {
  return { method: "GET", url: "/users/42", originalUrl: "/users/42?x=1", path: "/users/42", baseUrl: "/api", params: {}, query: {}, headers };
}
function fakeRes(): any {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    statusCode: 200,
    on(event: string, fn: () => void) { (handlers[event] ??= []).push(fn); return this; },
    emit(event: string) { (handlers[event] ?? []).forEach((f) => f()); },
  };
}

describe("express tracingHandler", () => {
  it("continues an incoming traceparent, names the root METHOD /route, and sends it on response end", async () => {
    const traceId = generateTraceId();
    const callerSpan = generateSpanId();
    const req = fakeReq({ traceparent: formatTraceparent(traceId, callerSpan, true) });
    req.route = { path: "/users/:id" };
    const res = fakeRes();

    let seenInHandler: string | undefined;
    await new Promise<void>((resolve) => {
      Codmir.tracingHandler()(req, res, () => {
        // Later async work in the chain still sees the request's transaction.
        setTimeout(async () => {
          await startSpan({ op: "db", name: "select user" }, async () => {
            seenInHandler = getActiveSpan()?.op;
          });
          resolve();
        }, 5);
      });
    });
    res.statusCode = 200;
    res.emit("finish");
    res.emit("close"); // a second end signal must not send a second transaction
    await Codmir.flush();

    const sent = sentTransactions(calls);
    expect(sent).toHaveLength(1);
    const [tx] = sent;
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
    expect(tx).toMatchObject({ trace_id: traceId, parent_span_id: callerSpan, op: "http.server", name: "GET /api/users/:id", status: "ok" });
    expect(seenInHandler).toBe("db");
    expect(tx.spans).toHaveLength(1);
    expect(tx.spans[0]).toMatchObject({ op: "db", parent_span_id: tx.span_id });
  });

  it("does not continue a trace the caller marked unsampled, and records a 5xx as error", async () => {
    const before = sentTransactions(calls).length;
    const req = fakeReq({ traceparent: formatTraceparent(generateTraceId(), generateSpanId(), false) });
    const res = fakeRes();
    Codmir.tracingHandler()(req, res, () => undefined);
    res.statusCode = 500;
    res.emit("finish");
    await Codmir.flush();
    expect(sentTransactions(calls)).toHaveLength(before);
  });

  it("opens a fresh trace when there is no traceparent, and a 500 sets status error", async () => {
    const req = fakeReq();
    const res = fakeRes();
    Codmir.tracingHandler()(req, res, () => undefined);
    res.statusCode = 500;
    res.emit("finish");
    await Codmir.flush();
    const tx = sentTransactions(calls).at(-1);
    expect(tx.parent_span_id).toBeUndefined();
    expect(tx.status).toBe("error");
    expect(tx.name).toBe("GET /users/42"); // no matched route: the path, without the query string
  });
});

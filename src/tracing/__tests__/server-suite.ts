/** CSL-5586: the behaviour every server wrapper (Next.js, Hono, Remix) shares, run against each one's adapter. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, flush, init } from "../../overseer/index";
import { formatTraceparent, generateSpanId, generateTraceId, getActiveSpan, startSpan } from "../index";
import { TransactionEventSchema, sentTransactions, type FetchCall } from "./helpers";

export const INGEST = "https://ingest.example.test/api/overseer";

export type Behaviour = "ok" | "status500" | "throw" | "nested-span";

export interface Adapter {
  /** Invokes the framework's wrapper around a handler that behaves as asked, for `GET <path>`. */
  call(args: { path: string; headers: Record<string, string>; behaviour: Behaviour }): Promise<{ status?: number; thrown?: unknown }>;
  /** The transaction name expected for `path`, with the adapter's route option or matched route in effect. */
  nameFor(path: string): string;
  /** A path whose route pattern differs from the raw path (`/users/42` vs `/users/:id`), when the adapter supports it. */
  path: string;
}

let calls: FetchCall[];

export function startTracing(rate: number): void {
  init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: rate });
}

export function useTracingHarness(): { calls: () => FetchCall[] } {
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
    vi.unstubAllGlobals();
  });
  return { calls: () => calls };
}

export function serverTracingSuite(label: string, adapter: Adapter): void {
  describe(`${label}: server transaction`, () => {
    const harness = useTracingHarness();
    const sent = async () => {
      await flush();
      return sentTransactions(harness.calls());
    };

    it("continues an incoming traceparent and names the root http.server METHOD /route", async () => {
      startTracing(1);
      const traceId = generateTraceId();
      const callerSpan = generateSpanId();
      const res = await adapter.call({
        path: adapter.path,
        headers: { traceparent: formatTraceparent(traceId, callerSpan, true) },
        behaviour: "ok",
      });
      expect(res.status).toBe(200);
      const [tx, ...rest] = await sent();
      expect(rest).toHaveLength(0);
      expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
      expect(tx).toMatchObject({
        trace_id: traceId,
        parent_span_id: callerSpan,
        op: "http.server",
        name: adapter.nameFor(adapter.path),
        status: "ok",
      });
    });

    it("opens a fresh trace when there is no traceparent", async () => {
      startTracing(1);
      await adapter.call({ path: adapter.path, headers: {}, behaviour: "ok" });
      const [tx] = await sent();
      expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
      expect(tx.parent_span_id).toBeUndefined();
      expect(tx.trace_id).toMatch(/^[0-9a-f]{32}$/);
    });

    it("nests spans opened by the handler under the request transaction", async () => {
      startTracing(1);
      await adapter.call({ path: adapter.path, headers: {}, behaviour: "nested-span" });
      const [tx] = await sent();
      expect(tx.spans).toHaveLength(1);
      expect(tx.spans[0]).toMatchObject({ op: "db", parent_span_id: tx.span_id });
    });

    it("records a 5xx response as status error", async () => {
      startTracing(1);
      const res = await adapter.call({ path: adapter.path, headers: {}, behaviour: "status500" });
      expect(res.status).toBe(500);
      const [tx] = await sent();
      expect(tx.status).toBe("error");
      expect(tx.spans).toEqual([]);
    });

    it("records a thrown error as status error", async () => {
      startTracing(1);
      await adapter.call({ path: adapter.path, headers: {}, behaviour: "throw" });
      const [tx] = await sent();
      expect(tx.status).toBe("error");
    });

    it("sends nothing at tracesSampleRate 0, even for a sampled traceparent", async () => {
      startTracing(0);
      await adapter.call({
        path: adapter.path,
        headers: { traceparent: formatTraceparent(generateTraceId(), generateSpanId(), true) },
        behaviour: "ok",
      });
      expect(await sent()).toHaveLength(0);
    });

    it("does not continue a trace the caller marked unsampled", async () => {
      startTracing(1);
      await adapter.call({
        path: adapter.path,
        headers: { traceparent: formatTraceparent(generateTraceId(), generateSpanId(), false) },
        behaviour: "ok",
      });
      expect(await sent()).toHaveLength(0);
    });
  });
}

/** What a handler under test does for each behaviour; `respond` builds the framework's own 500. */
export async function runBehaviour<T>(behaviour: Behaviour, ok: () => T, status500: () => T): Promise<T> {
  switch (behaviour) {
    case "ok":
      return ok();
    case "status500":
      return status500();
    case "throw":
      throw new Error("boom");
    case "nested-span":
      await startSpan({ op: "db", name: "select" }, async () => {
        expect(getActiveSpan()?.op).toBe("db");
      });
      return ok();
  }
}

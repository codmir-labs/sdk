/** While the network is down the queue has a cap per type and a budget in bytes: transactions never push errors out. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient } from "../index";
import { MAX_QUEUED_TRANSACTIONS, MAX_QUEUE_BYTES, MAX_QUEUE_SIZE, utf8Bytes } from "../transport";

type Call = { url: string; body: any };
let calls: Call[];
let respond: () => Response | Promise<Response>;
const ok = () => new Response(JSON.stringify({ received: true }), { status: 200 });
const down = () => new Response("down", { status: 503 });

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  respond = () => ok();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return respond();
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tx = (id: string, name = "GET /api/orders") => ({
  type: "transaction" as const,
  event_id: id,
  trace_id: "a".repeat(32),
  span_id: "b".repeat(16),
  op: "http.server",
  name,
  status: "ok" as const,
  start_timestamp: new Date().toISOString(),
  end_timestamp: new Date().toISOString(),
  spans: [],
});

function client() {
  const onDropped = vi.fn();
  const c = new OverseerClient({ clientKey: "osk_test", rateLimit: false, onDropped });
  c.init();
  return { c, onDropped };
}

/** The events the network got once it is back, as wire events, and what was reported as dropped. */
async function backUp(c: OverseerClient, onDropped: ReturnType<typeof vi.fn>) {
  respond = ok;
  const before = calls.length;
  await c.flush();
  const wire: any[] = calls.slice(before).flatMap((x) => x.body.events);
  const errorIds = wire.filter((e) => e.type === "error").map((e) => e.event.id as string);
  const txIds = wire.filter((e) => e.type === "transaction").map((e) => e.event_id as string);
  const drops = onDropped.mock.calls.map(([d]) => d);
  expect(drops.every((d) => d.reason === "queue_full" && d.status === 0)).toBe(true);
  return {
    wire,
    errorIds,
    txIds,
    droppedEvents: drops.reduce((n: number, d) => n + d.events, 0) as number,
    droppedErrorIds: drops.flatMap((d) => d.eventIds ?? []) as string[],
  };
}

describe("a cap per type", () => {
  it("a 10-minute ingest outage on a traced server delivers every error, and only transactions are dropped", async () => {
    respond = down;
    const { c, onDropped } = client();
    const errorIds: string[] = [];
    for (let s = 0; s < 600; s++) {
      if (s % 60 === 0) errorIds.push(c.captureException(new Error(`payment provider down ${s}`)));
      c.captureTransaction(tx(`tx${s}a`));
      c.captureTransaction(tx(`tx${s}b`));
      await vi.advanceTimersByTimeAsync(1000);
    }
    const r = await backUp(c, onDropped);
    expect(errorIds).toHaveLength(10);
    expect(r.errorIds.sort()).toEqual([...errorIds].sort());
    expect(r.droppedErrorIds).toEqual([]);
    expect(r.droppedEvents).toBe(1200 - MAX_QUEUED_TRANSACTIONS);
    expect(r.txIds).toHaveLength(MAX_QUEUED_TRANSACTIONS);
    c.close();
  });

  it("250 transactions leave 200 queued, and the 50 oldest are reported as queue_full", async () => {
    respond = down;
    const { c, onDropped } = client();
    for (let i = 0; i < 250; i++) c.captureTransaction(tx(`tx${i}`));
    await vi.advanceTimersByTimeAsync(1100);
    const r = await backUp(c, onDropped);
    expect(r.droppedEvents).toBe(50);
    expect(r.errorIds).toEqual([]);
    expect(r.txIds).toEqual(Array.from({ length: 200 }, (_, i) => `tx${i + 50}`));
    c.close();
  });

  it("1,100 errors leave 1,000 queued, the 100 oldest errors are dropped, and no transaction is queued or dropped", async () => {
    respond = down;
    const { c, onDropped } = client();
    const ids: string[] = [];
    for (let i = 0; i < MAX_QUEUE_SIZE + 100; i++) ids.push(c.captureException(new Error(`e${i}`)));
    await vi.advanceTimersByTimeAsync(1100);
    const r = await backUp(c, onDropped);
    expect(new Set(r.droppedErrorIds)).toEqual(new Set(ids.slice(0, 100))); // as a set: the batch in flight when the cap was first hit comes back, and is dropped, later
    expect(r.droppedEvents).toBe(100);
    expect(r.errorIds).toEqual(ids.slice(100));
    expect(r.txIds).toEqual([]);
    c.close();
  });

  it("with 1,000 errors and 200 transactions queued, one more error drops the oldest error and one more transaction drops the oldest transaction", async () => {
    respond = down;
    const { c, onDropped } = client();
    const errors: string[] = [];
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) errors.push(c.captureException(new Error(`e${i}`)));
    for (let i = 0; i < MAX_QUEUED_TRANSACTIONS; i++) c.captureTransaction(tx(`tx${i}`));
    await vi.advanceTimersByTimeAsync(1100);
    expect(onDropped).not.toHaveBeenCalled();

    errors.push(c.captureException(new Error("one more error")));
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped.mock.calls[0][0]).toMatchObject({ events: 1, reason: "queue_full", eventIds: [errors[0]] });

    c.captureTransaction(tx("tx-new"));
    expect(onDropped).toHaveBeenCalledTimes(2);
    expect(onDropped.mock.calls[1][0]).toMatchObject({ events: 1, reason: "queue_full" });
    expect(onDropped.mock.calls[1][0].eventIds).toBeUndefined();

    const r = await backUp(c, onDropped);
    expect(r.errorIds).toEqual(errors.slice(1));
    expect(r.txIds).toEqual([...Array.from({ length: 199 }, (_, i) => `tx${i + 1}`), "tx-new"]);
    c.close();
  });
});

describe("a budget in bytes for the whole queue", () => {
  /** An error carrying about 100 KB of breadcrumbs. */
  function bigError(c: OverseerClient, label: string): string {
    for (let k = 0; k < 100; k++) c.addBreadcrumb({ category: "fetch", message: `GET /api/item/${label}/${k} failed `.padEnd(1000, "x") });
    return c.captureException(new Error(`offline ${label}`));
  }
  const bytesOf = (wire: any[]) => wire.reduce((n, e) => n + utf8Bytes(JSON.stringify(e)), 0) as number;

  it("1,000 errors of about 100 KB each leave a queue within MAX_QUEUE_BYTES, the newest kept, the rest reported as queue_full", async () => {
    respond = () => Promise.reject(new TypeError("Failed to fetch"));
    const { c, onDropped } = client();
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) ids.push(bigError(c, String(i)));
    await vi.advanceTimersByTimeAsync(1100);
    const r = await backUp(c, onDropped);
    expect(r.wire.length).toBeGreaterThan(10);
    expect(bytesOf(r.wire)).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(r.errorIds).toEqual(ids.slice(ids.length - r.errorIds.length));
    // reported in the order they were dropped, which is not the order they were captured: the batch in flight when the first limit was hit comes back later
    expect(new Set(r.droppedErrorIds)).toEqual(new Set(ids.slice(0, ids.length - r.errorIds.length)));
    expect(r.droppedEvents + r.errorIds.length).toBe(1000);
    c.close();
  });

  it("near the budget, a new large error drops transactions before any error", async () => {
    respond = down;
    const { c, onDropped } = client();
    const errors: string[] = [];
    for (let i = 0; i < 100; i++) errors.push(bigError(c, `a${i}`));
    for (let i = 0; i < 35; i++) c.captureTransaction(tx(`tx${i}`, "T".repeat(60_000)));
    await vi.advanceTimersByTimeAsync(1100);
    expect(onDropped).not.toHaveBeenCalled(); // a little under the budget: 100 errors of about 26 KB, 35 transactions of 60 KB

    // more errors until the budget is crossed
    for (let i = 0; i < 60 && onDropped.mock.calls.length === 0; i++) errors.push(bigError(c, `late${i}`));
    expect(onDropped).toHaveBeenCalled();
    const r = await backUp(c, onDropped);
    expect(r.droppedEvents).toBeGreaterThan(0);
    expect(r.droppedErrorIds).toEqual([]);
    expect(new Set(r.errorIds)).toEqual(new Set(errors));
    // the oldest transactions are the ones that went
    expect(r.txIds).toEqual(Array.from({ length: r.txIds.length }, (_, i) => `tx${35 - r.txIds.length + i}`));
    expect(r.txIds.length).toBe(35 - r.droppedEvents);
    expect(bytesOf(r.wire)).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    c.close();
  });
});

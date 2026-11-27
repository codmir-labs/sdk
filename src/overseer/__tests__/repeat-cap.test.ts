/** The repeat cap: `rateLimit` holds back copies of one error, and what it drops is reported, never lost. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient, type OverseerConfig } from "../index";

type DroppedCall = { events: number; status: number; reason?: string; eventIds?: string[] };

let bodies: Array<{ events: Array<{ type: string; message?: string; event?: { message?: string } }> }>;
let dropped: Array<DroppedCall & { at: number }>;

beforeEach(() => {
  vi.useFakeTimers();
  bodies = [];
  dropped = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client(config: Partial<OverseerConfig> = {}) {
  const c = new OverseerClient({
    clientKey: "osk_test",
    environment: "production",
    onDropped: (d) => dropped.push({ ...d, at: Date.now() }),
    ...config,
  });
  c.init();
  return c;
}

const sentCount = () => bodies.reduce((n, b) => n + b.events.length, 0);
const rateLimited = () => dropped.filter((d) => d.reason === "rate_limited");
const droppedTotal = () => rateLimited().reduce((n, d) => n + d.events, 0);

/** Throws the same error from the same place `n` times, spread over `spanMs`. */
async function repeat(c: OverseerClient, n: number, spanMs = 0, make = () => new Error("poll failed")) {
  for (let i = 0; i < n; i++) {
    c.captureException(make());
    if (spanMs) await vi.advanceTimersByTimeAsync(spanMs / n);
  }
}

describe("repeat cap", () => {
  it("sends at most 10 of 1000 identical errors in one second and reports the other 990 as rate_limited", async () => {
    const c = client();
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) ids.push(c.captureException(new Error("poll failed")));
    await vi.advanceTimersByTimeAsync(1000);
    await c.flush();

    expect(sentCount()).toBeLessThanOrEqual(10);
    expect(sentCount()).toBe(10);
    expect(droppedTotal()).toBe(990);
    expect(rateLimited().length).toBeLessThanOrEqual(1);
    for (const d of rateLimited()) expect(d.status).toBe(0);
    // The ids reported are the ones captureException handed back and that were not sent.
    const reported = rateLimited().flatMap((d) => d.eventIds ?? []);
    expect(reported).toEqual(ids.slice(10));
  });

  it("calls onDropped at most once a second while the storm goes on, and loses none", async () => {
    const c = client();
    await repeat(c, 3000, 5000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(droppedTotal()).toBe(3000 - sentCount());
    const seconds = rateLimited().map((d) => Math.floor(d.at / 1000));
    expect(new Set(seconds).size).toBe(seconds.length);
  });

  it("sends 10 distinct errors in one second, all of them", async () => {
    const c = client();
    for (let i = 0; i < 10; i++) c.captureException(new Error(`failure kind ${String.fromCharCode(97 + i)}`));
    await c.flush();

    expect(sentCount()).toBe(10);
    expect(dropped).toEqual([]);
  });

  it("sends the same group again after 60 s", async () => {
    const c = client();
    await repeat(c, 30);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentCount()).toBe(10);

    await vi.advanceTimersByTimeAsync(60_000);
    await repeat(c, 30);
    await c.flush();
    expect(sentCount()).toBe(20);
  });

  it("holds the event's own fingerprint as its group", async () => {
    const c = client({ beforeSend: (e) => ({ ...e, fingerprint: ["one-group"] }) });
    for (let i = 0; i < 30; i++) c.captureException(new Error(`different message ${String.fromCharCode(97 + (i % 26))}${"x".repeat(i)}`));
    await c.flush();
    await vi.advanceTimersByTimeAsync(1000);

    expect(sentCount()).toBe(10);
    expect(droppedTotal()).toBe(20);
  });

  it("sends 100 of 150 distinct errors in one minute and reports 50", async () => {
    const c = client();
    for (let i = 0; i < 150; i++) {
      c.captureException(new Error(`kind ${i.toString(36)}-x`.replace(/\d/g, (d) => "abcdefghij"[+d])));
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(1000);
    await c.flush();

    expect(sentCount()).toBe(100);
    expect(droppedTotal()).toBe(50);
  });

  it("sends all 1000 with rateLimit false", async () => {
    const c = client({ rateLimit: false });
    await repeat(c, 1000);
    await c.flush();

    expect(sentCount()).toBe(1000);
    expect(dropped).toEqual([]);
  });

  it("never caps transactions", async () => {
    const c = client();
    for (let i = 0; i < 300; i++) c.captureTransaction({ id: `t${i}`, type: "transaction", name: "GET /x" } as never);
    await c.flush();

    expect(sentCount()).toBe(300);
    expect(dropped).toEqual([]);
  });

  it("reports what it dropped on close() at once", async () => {
    const c = client();
    await repeat(c, 15);
    expect(dropped).toEqual([]);
    c.close();

    expect(droppedTotal()).toBe(5);
  });

  it("honours custom limits", async () => {
    const c = client({ rateLimit: { perGroupPerMinute: 2, perMinute: 3 } });
    await repeat(c, 5);
    for (let i = 0; i < 5; i++) c.captureMessage(`other ${"abcde"[i]}`);
    await c.flush();
    await vi.advanceTimersByTimeAsync(1000);

    expect(sentCount()).toBe(3);
    expect(droppedTotal()).toBe(7);
  });

  it("does not make an event dropped by the cap the last error feedback links to", async () => {
    const c = client({ rateLimit: { perGroupPerMinute: 1 } });
    const capture = () => c.captureException(new Error("same"));
    const first = capture();
    await vi.advanceTimersByTimeAsync(5000);
    const second = capture();

    expect(second).not.toBe(first);
    expect(c.feedbackContext().lastError?.id).toBe(first);
  });

  it("does not count an event beforeSend dropped", async () => {
    let drop = true;
    const c = client({ rateLimit: { perGroupPerMinute: 1 }, beforeSend: (e) => (drop ? null : e) });
    for (let i = 0; i < 5; i++) c.captureException(new Error("same"));
    drop = false;
    c.captureException(new Error("same"));
    await c.flush();

    expect(sentCount()).toBe(1);
    expect(dropped).toEqual([]);
  });
});

/**
 * Under steady load events still leave: the flush timer is started by the first unsent capture and never pushed
 * back, and a full batch is sent at once. The repeat cap is off here so only the timing is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient } from "../index";

type Sent = { at: number; events: Array<{ type: string; message?: string }> };

let sent: Sent[];

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push({ at: Date.now(), events: JSON.parse(String(init.body)).events });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const onDropped = vi.fn();
  const c = new OverseerClient({ clientKey: "osk_test", environment: "production", onDropped, rateLimit: false });
  c.init();
  return { c, onDropped };
}

const total = () => sent.reduce((n, r) => n + r.events.length, 0);
const transaction = (i: number) => ({ id: `t${i}`, type: "transaction", name: `tx ${i}`, timestamp: new Date().toISOString() }) as never;

describe("steady load", () => {
  it("sends while a message is captured every 500 ms for 10 s, and drops nothing", async () => {
    const { c, onDropped } = client();
    const start = Date.now();
    for (let i = 0; i < 20; i++) {
      c.captureMessage(`m${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    // Everything has been sent by the end of the stream, not only after it stops.
    expect(Date.now() - start).toBe(10_000);
    expect(sent.length).toBeGreaterThanOrEqual(9);
    expect(total()).toBeGreaterThanOrEqual(18);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("sends 250 events captured at once in requests that start before 1 s has passed", async () => {
    const { c, onDropped } = client();
    const start = Date.now();
    for (let i = 0; i < 250; i++) c.captureMessage(`m${i}`);
    await vi.advanceTimersByTimeAsync(999);

    expect(total()).toBe(250);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const r of sent) expect(r.at - start).toBeLessThan(1000);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("sends 10,000 transactions captured every 100 ms, with none lost to a full queue", async () => {
    const { c, onDropped } = client();
    const start = Date.now();
    let firstAt = -1;
    for (let i = 0; i < 10_000; i++) {
      c.captureTransaction(transaction(i));
      await vi.advanceTimersByTimeAsync(100);
      if (firstAt < 0 && sent.length > 0) firstAt = sent[0].at - start;
    }
    await c.flush();

    expect(total()).toBe(10_000);
    expect(onDropped).not.toHaveBeenCalled();
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(sent[0].at - start).toBeLessThanOrEqual(1000);
  });
});

/**
 * A request body over the ingest cap (256 KB) is refused whole with 413. Batches are therefore cut by bytes as well
 * as by count, one oversized event is trimmed, and a 413 splits the batch instead of dropping it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient } from "../index";
import { MAX_BATCH_BYTES } from "../transport";

const SERVER_CAP = 262_144;

let bodies: string[];
let answer413: (body: string) => boolean;
const bytesOf = (s: string) => new TextEncoder().encode(s).length;
const sentMessages = () => bodies.flatMap((b) => (JSON.parse(b).events as Array<{ message: string }>).map((e) => e.message));

beforeEach(() => {
  vi.useFakeTimers();
  bodies = [];
  answer413 = (body) => bytesOf(body) > SERVER_CAP;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      bodies.push(body);
      return new Response(JSON.stringify({ received: true }), { status: answer413(body) ? 413 : 200 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client(onDropped = vi.fn()) {
  const c = new OverseerClient({ clientKey: "osk_test", environment: "production", onDropped, rateLimit: false });
  c.init();
  return { c, onDropped };
}

/** Fills the breadcrumb buffer with `count` crumbs of `size` characters each. */
function crumbs(c: OverseerClient, count: number, size: number, char = "x") {
  for (let i = 0; i < count; i++) c.addBreadcrumb({ type: "log", message: `${i}:`.padEnd(size, char) });
}

describe("batches are cut by bytes", () => {
  it("sends 100 events of about 20 KB in requests under the cap, none dropped", async () => {
    const { c, onDropped } = client();
    crumbs(c, 10, 2000);
    for (let i = 0; i < 100; i++) c.captureMessage(`event-${i}`);
    expect(await c.flush()).toBe(true);

    expect(sentMessages().sort()).toEqual(Array.from({ length: 100 }, (_, i) => `event-${i}`).sort());
    expect(bodies.length).toBeGreaterThan(1);
    for (const b of bodies) expect(bytesOf(b)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("counts bytes, not characters: 20 KB of é per event stays under the cap", async () => {
    const { c, onDropped } = client();
    for (let i = 0; i < 30; i++) c.captureMessage(`${i}:`.padEnd(20_000, "é"));
    expect(await c.flush()).toBe(true);

    expect(sentMessages()).toHaveLength(30);
    for (const b of bodies) {
      expect(bytesOf(b)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(b.length).toBeLessThan(bytesOf(b));
    }
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("keeps small events in one request", async () => {
    const { c } = client();
    for (let i = 0; i < 3; i++) c.captureMessage(`small-${i}`);
    expect(await c.flush()).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).events).toHaveLength(3);
  });
});

describe("one event over the cap", () => {
  it("is sent with its oldest breadcrumbs cut, newest kept, and the caller's object untouched", async () => {
    const onDropped = vi.fn();
    const held: Array<{ breadcrumbs?: unknown[] }> = [];
    const c = new OverseerClient({
      clientKey: "osk_test",
      onDropped,
      beforeSend: (e) => {
        held.push(e as { breadcrumbs?: unknown[] });
        return e;
      },
    });
    c.init();
    crumbs(c, 20, 15000); // about 300 KB
    c.captureMessage("big");
    expect(await c.flush()).toBe(true);

    expect(bodies).toHaveLength(1);
    expect(bytesOf(bodies[0])).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    const [sent] = JSON.parse(bodies[0]).events;
    expect(sent.breadcrumbs.length).toBeGreaterThan(0);
    expect(sent.breadcrumbs.length).toBeLessThan(20);
    expect(sent.breadcrumbs.at(-1).message.startsWith("19:")).toBe(true);
    expect(held[0].breadcrumbs).toHaveLength(20);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("is dropped as too_large, never sent, when it cannot fit without breadcrumbs", async () => {
    const { c, onDropped } = client();
    c.captureMessage("y".repeat(300_000));
    expect(await c.flush()).toBe(true);

    expect(bodies).toHaveLength(0);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped.mock.calls[0][0]).toMatchObject({ events: 1, reason: "too_large" });
  });

  it("does not hold back the events behind it", async () => {
    const { c, onDropped } = client();
    c.captureMessage("y".repeat(300_000));
    c.captureMessage("fine");
    expect(await c.flush()).toBe(true);
    expect(sentMessages()).toEqual(["fine"]);
    expect(onDropped).toHaveBeenCalledTimes(1);
  });
});

describe("a 413 splits instead of dropping", () => {
  it("halves a batch the server refuses and gets every event through", async () => {
    answer413 = (body) => (JSON.parse(body).events as unknown[]).length > 10;
    const { c, onDropped } = client();
    for (let i = 0; i < 100; i++) c.captureMessage(`event-${i}`);
    expect(await c.flush()).toBe(true);

    const got = sentMessages();
    expect(new Set(got).size).toBe(100);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("trims a single refused event once, then drops it if refused again", async () => {
    answer413 = () => true;
    const { c, onDropped } = client();
    crumbs(c, 10, 100);
    c.captureMessage("stubborn");
    expect(await c.flush()).toBe(true);

    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]).events[0].breadcrumbs.length).toBeLessThan(10);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped.mock.calls[0][0]).toMatchObject({ events: 1, status: 413, reason: "too_large" });
  });

  it("sends a single refused event again when the trimmed copy is accepted", async () => {
    let first = true;
    answer413 = () => (first ? !(first = false) : false);
    const { c, onDropped } = client();
    crumbs(c, 10, 100);
    c.captureMessage("once");
    expect(await c.flush()).toBe(true);

    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]).events[0].message).toBe("once");
    expect(onDropped).not.toHaveBeenCalled();
  });
});

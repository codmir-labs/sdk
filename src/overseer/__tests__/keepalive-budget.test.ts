/**
 * The SDK's keepalive requests at page hide share one budget (a browser refuses them past 64 KiB of bodies in flight,
 * per page). Here the error transport's side: a batch that does not fit stays queued for the normal flush.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient } from "../index";
import { claimKeepalive, KEEPALIVE_MAX_BYTES, onHideFlush, runHideFlushes } from "../keepalive";

const bytesOf = (s: string) => new TextEncoder().encode(s).length;

type Call = { keepalive: boolean; bytes: number; messages: string[] };
let calls: Call[];
let respond: () => Response | Promise<Response>;
let win: EventTarget;
let doc: EventTarget & { visibilityState: string };

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  respond = () => new Response("{}", { status: 200 });
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const raw = String(init.body);
      calls.push({
        keepalive: (init as { keepalive?: boolean }).keepalive === true,
        bytes: bytesOf(raw),
        messages: (JSON.parse(raw).events as Array<{ event: { message: string } }>).map((e) => e.event.message.slice(0, 8)),
      });
      return respond();
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const c = new OverseerClient({ clientKey: "osk_test", environment: "production", rateLimit: false });
  c.init();
  return c;
}

/** An error whose request body is about `kb` KB: the message travels three times, plus about 2.7 KB of envelope. */
async function capture(c: OverseerClient, kb: number, tag: string) {
  c.captureException(new Error(`${tag}:${"e".repeat(Math.round((kb * 1000 - 2700) / 3))}`));
  await vi.advanceTimersByTimeAsync(0);
}

describe("the error transport at page hide", () => {
  it("two batches over 60 KB together: the first gets keepalive, the second stays queued and the normal flush sends it", async () => {
    const c = client();
    await capture(c, 36, "first");
    await capture(c, 36, "second");
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ keepalive: true, messages: ["first:ee"] });
    expect(calls[0].bytes).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);

    // The page is visible again: the queue's own flush sends the rest, without keepalive.
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ keepalive: false, messages: ["second:e"] });
    c.close();
  });

  it("the same with a visibilitychange to hidden", async () => {
    const c = client();
    await capture(c, 36, "first");
    await capture(c, 36, "second");
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((x) => x.keepalive)).toEqual([true]);
    doc.visibilityState = "visible";
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls.map((x) => x.keepalive)).toEqual([true, false]);
    c.close();
  });

  it("batches that fit together all get keepalive", async () => {
    const c = client();
    await capture(c, 20, "first");
    await capture(c, 20, "second");
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.every((x) => x.keepalive)).toBe(true);
    expect(calls.flatMap((x) => x.messages).sort()).toEqual(["first:ee", "second:e"].sort());
    c.close();
  });

  it("a batch that failed at hide gives its bytes back, and goes back to the queue", async () => {
    const c = client();
    respond = () => new Response("down", { status: 503 });
    await capture(c, 40, "first");
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    // Its bytes are free again: the whole budget is claimable.
    const release = claimKeepalive(KEEPALIVE_MAX_BYTES);
    expect(release).not.toBeNull();
    release?.();
    c.close();
  });

  it("close() takes the client's hide flush out of the budget's list", async () => {
    const c = client();
    await capture(c, 5, "queued");
    await c.close();
    const before = calls.length;
    runHideFlushes();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(before);
  });
});

describe("the keepalive budget", () => {
  it("lends bytes while the sum stays within 60,000, and takes them back on release", () => {
    const a = claimKeepalive(40_000);
    expect(a).not.toBeNull();
    expect(claimKeepalive(20_001)).toBeNull();
    const b = claimKeepalive(20_000);
    expect(b).not.toBeNull();
    expect(claimKeepalive(1)).toBeNull();
    a?.();
    a?.(); // a second release gives nothing back
    expect(claimKeepalive(40_001)).toBeNull();
    const c = claimKeepalive(40_000);
    expect(c).not.toBeNull();
    b?.();
    c?.();
    expect(claimKeepalive(KEEPALIVE_MAX_BYTES)).not.toBeNull();
  });

  it("runs the registered flushes, survives one that throws, and forgets one that unregistered", () => {
    const ran: string[] = [];
    const off = onHideFlush(() => ran.push("a"));
    const offBad = onHideFlush(() => {
      throw new Error("no");
    });
    const offB = onHideFlush(() => ran.push("b"));
    runHideFlushes();
    expect(ran).toEqual(["a", "b"]);
    off();
    offBad();
    runHideFlushes();
    expect(ran).toEqual(["a", "b", "b"]);
    offB();
  });
});

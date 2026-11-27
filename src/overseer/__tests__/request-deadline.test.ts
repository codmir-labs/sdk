/**
 * A request that is accepted and never answered is given up on after a deadline and retried, so it cannot stop
 * every later send. The signal is passed only where this runtime's fetch accepts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient } from "../index";

type Call = { at: number; init: RequestInit; messages: string[] };

let calls: Call[];
let hung: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  hung = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ at: Date.now(), init, messages: body.events.map((e: { message?: string }) => e.message) });
      if (!hung) return Promise.resolve(new Response(JSON.stringify({ received: true }), { status: 200 }));
      // Accepted and never answered, whatever the signal says: only the SDK's own deadline frees the queue.
      return new Promise<Response>(() => {});
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const onDropped = vi.fn();
  const c = new OverseerClient({ clientKey: "osk_test", onDropped, rateLimit: false });
  c.init();
  return { c, onDropped };
}

describe("request deadline", () => {
  it("(a) goes out again after the deadline and the backoff, and aborts the first request's signal", async () => {
    const { c } = client();
    c.captureMessage("first");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    const signal = calls[0].init.signal as AbortSignal;
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000); // the deadline under Node
    expect(signal.aborted).toBe(true);
    hung = false;
    await vi.advanceTimersByTimeAsync(1000); // the first backoff
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toEqual(["first"]);
  });

  it("(b) flush() settles after a hung request, and a later event is delivered", async () => {
    const { c } = client();
    c.captureMessage("first");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);

    // A flush started while the request hangs is not stuck behind it for ever.
    let flushed: boolean | undefined;
    void c.flush().then((r) => (flushed = r));
    await vi.advanceTimersByTimeAsync(5000);
    expect(flushed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(flushed).toBe(false);

    hung = false;
    c.captureMessage("later");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(c.flush()).resolves.toBe(true);
    expect(calls.slice(1).flatMap((x) => x.messages)).toEqual(expect.arrayContaining(["first", "later"]));
  });

  it("(c) flush(2000) resolves false at 2 s, drops nothing, and the events go on the retry", async () => {
    const { c, onDropped } = client();
    c.captureMessage("one");
    c.captureMessage("two");
    const start = Date.now();
    let result: boolean | undefined;
    void c.flush(2000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(1999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(Date.now() - start).toBe(2000);
    expect(onDropped).not.toHaveBeenCalled();

    hung = false;
    await vi.advanceTimersByTimeAsync(10_000 + 1000);
    expect(onDropped).not.toHaveBeenCalled();
    expect(calls.at(-1)?.messages).toEqual(["one", "two"]);
  });

  it("(d) the deadline timer is unref'd, so it never keeps a process alive", async () => {
    const unrefed: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const timer = realSetTimeout(fn, ms, ...rest) as unknown as { unref?: () => unknown };
      const unref = timer.unref;
      if (typeof unref === "function") {
        timer.unref = function (this: unknown) {
          unrefed.push(ms as number);
          return unref.call(this);
        };
      }
      return timer;
    }) as typeof setTimeout);
    const { c } = client();
    c.captureMessage("first");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(unrefed).toContain(10_000);
  });

  it("(e) a runtime whose Request refuses the signal still sends, without one, and still gives up at the deadline", async () => {
    // The realm mismatch: a signal from one realm handed to another realm's Request throws.
    const RealRequest = Request;
    vi.stubGlobal(
      "Request",
      class extends RealRequest {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          if (init?.signal) throw new TypeError("RequestInit: Expected signal (\"AbortSignal\") to be an instance of AbortSignal.");
          super(input, init);
        }
      },
    );
    const { c, onDropped } = client();
    c.captureMessage("first");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.signal).toBeUndefined();

    hung = false;
    await vi.advanceTimersByTimeAsync(10_000 + 1000);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toEqual(["first"]);
    expect(onDropped).not.toHaveBeenCalled();
  });
});

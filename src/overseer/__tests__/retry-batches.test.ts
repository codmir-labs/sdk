/**
 * A batch that failed is resent exactly as it was (the server keys a batch by its ids, so a retry of the same ids is not
 * charged twice), and a batch the server keeps answering with a 5xx ends instead of holding up everything behind it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient } from "../index";
import { claimKeepalive, KEEPALIVE_MAX_BYTES } from "../keepalive";

type Call = { ids: string[]; keepalive: boolean };
let calls: Call[];
let respond: (ids: string[], n: number) => Response;
let win: EventTarget;

const ok = () => new Response("{}", { status: 200 });

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  responses = [];
  respond = () => ok();
  win = new EventTarget();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const ids = (JSON.parse(String(init.body)).events as Array<{ id?: string; event?: { id: string } }>).map((e) => (e.event?.id ?? e.id) as string);
      calls.push({ ids, keepalive: (init as { keepalive?: boolean }).keepalive === true });
      return respond(ids, calls.length);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const onDropped = vi.fn();
  const c = new OverseerClient({ clientKey: "osk_test", environment: "production", rateLimit: false, onDropped });
  c.init();
  return { c, onDropped };
}

let responses: number[];
/** Ids of the requests the server answered with 200. */
const delivered = () => calls.filter((_, i) => responses[i] === 200).flatMap((x) => x.ids);

/** Records the status each request was answered with, so `delivered()` counts only what the server took. */
function answer(fn: (ids: string[], n: number) => Response) {
  respond = (ids, n) => {
    const res = fn(ids, n);
    responses[n - 1] = res.status;
    return res;
  };
}

describe("a retry resends the pending batch as it was", () => {
  it("carries exactly the ids of the first request, and events captured during the backoff go in a later request", async () => {
    answer((_ids, n) => {
      if (n === 1) throw new TypeError("connection lost");
      return ok();
    });
    const { c } = client();
    const a = c.captureException(new Error("a"));
    await vi.advanceTimersByTimeAsync(1100);
    const b = c.captureException(new Error("b"));
    const d = c.captureException(new Error("c"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.map((x) => x.ids)).toEqual([[a], [a], [b, d]]);
    c.close();
  });

  it("keeps the order and the ids of a batch of several across a 503", async () => {
    answer((_ids, n) => (n === 1 ? new Response("{}", { status: 503 }) : ok()));
    const { c } = client();
    const first = [c.captureMessage("one"), c.captureMessage("two"), c.captureMessage("three")];
    await vi.advanceTimersByTimeAsync(1100);
    const later = c.captureMessage("four");
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.map((x) => x.ids)).toEqual([first, first, [later]]);
    c.close();
  });

  it("a network error keeps the pending batch and retries it without a cap", async () => {
    answer((_ids, n) => {
      if (n <= 40) throw new TypeError("offline");
      return ok();
    });
    const { c, onDropped } = client();
    const a = c.captureException(new Error("a"));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls.length).toBeGreaterThan(40);
    expect(calls.slice(0, 41).every((x) => x.ids.length === 1 && x.ids[0] === a)).toBe(true);
    expect(delivered()).toEqual([a]);
    expect(onDropped).not.toHaveBeenCalled();
    c.close();
  });

  it("a 429 is retried without a cap too", async () => {
    answer((_ids, n) => (n <= 12 ? new Response("{}", { status: 429 }) : ok()));
    const { c, onDropped } = client();
    const a = c.captureException(new Error("a"));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(delivered()).toEqual([a]);
    expect(onDropped).not.toHaveBeenCalled();
    c.close();
  });
});

describe("a batch the server keeps answering with a 5xx", () => {
  it("a single bad event is dropped once, with its status and retry_exhausted; every other event is delivered within 10 minutes", async () => {
    let bad = "";
    answer((ids) => new Response("{}", { status: ids.includes(bad) ? 500 : 200 }));
    const { c, onDropped } = client();
    bad = c.captureMessage("poison");
    await vi.advanceTimersByTimeAsync(1100);
    const good: string[] = [];
    for (let i = 0; i < 20; i++) {
      good.push(c.captureMessage(`fine ${i}`));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(delivered().sort()).toEqual([...good].sort());
    expect(calls.filter((x) => x.ids.includes(bad))).toHaveLength(5);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith({ events: 1, status: 500, reason: "retry_exhausted", eventIds: [bad] });
    c.close();
  });

  it("a bad event inside a batch of several: the batch is split until the event is alone, and only it is lost", async () => {
    let bad = "";
    answer((ids) => new Response("{}", { status: ids.includes(bad) ? 502 : 200 }));
    const { c, onDropped } = client();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(c.captureMessage(`m${i}`));
    bad = ids[4];
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(delivered().sort()).toEqual(ids.filter((id) => id !== bad).sort());
    // The whole batch got 5 answers before it was split; every retry carried the batch as it was.
    expect(calls.slice(0, 5).every((x) => x.ids.join() === ids.join())).toBe(true);
    expect(calls[5].ids).toEqual(ids.slice(0, 4));
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith({ events: 1, status: 502, reason: "retry_exhausted", eventIds: [bad] });
    c.close();
  });
});

describe("old events", () => {
  it("an event still unsent after 24 hours is dropped and reported as expired", async () => {
    answer(() => {
      throw new TypeError("offline");
    });
    const { c, onDropped } = client();
    const a = c.captureException(new Error("a"));
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect(onDropped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith({ events: 1, status: 0, reason: "expired", eventIds: [a] });
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(before);
    c.close();
  });
});

describe("page hide", () => {
  it("sends the pending batch first, as one unit, with keepalive when it fits", async () => {
    answer((_ids, n) => {
      if (n === 1) throw new TypeError("offline");
      return ok();
    });
    const { c } = client();
    const a = c.captureException(new Error("a"));
    await vi.advanceTimersByTimeAsync(1100);
    const b = c.captureException(new Error("b"));
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(1)).toEqual([
      { ids: [a], keepalive: true },
      { ids: [b], keepalive: true },
    ]);
    c.close();
  });

  it("leaves it pending when it does not fit the budget, and the next flush sends it whole", async () => {
    answer((_ids, n) => {
      if (n === 1) throw new TypeError("offline");
      return ok();
    });
    const { c } = client();
    const a = c.captureException(new Error("a"));
    await vi.advanceTimersByTimeAsync(1100);
    const release = claimKeepalive(KEEPALIVE_MAX_BYTES - 100);
    expect(release).not.toBeNull();
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    release?.();
    const b = c.captureException(new Error("b"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.slice(1).map((x) => x.ids)).toEqual([[a], [b]]);
    expect(calls.slice(1).every((x) => !x.keepalive)).toBe(true);
    c.close();
  });

  it("a pending batch that fails at hide stays whole", async () => {
    answer((_ids, n) => {
      if (n === 1) throw new TypeError("offline");
      return n === 2 ? new Response("{}", { status: 503 }) : ok();
    });
    const { c } = client();
    const ids = [c.captureMessage("x"), c.captureMessage("y")];
    await vi.advanceTimersByTimeAsync(1100);
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.map((x) => x.ids)).toEqual([ids, ids, ids]);
    c.close();
  });
});

/**
 * A batch that failed is resent exactly as it was (the server keys a batch by its ids, so a retry of the same ids is not
 * charged twice), and a batch the server keeps refusing while it takes other requests ends instead of holding up
 * everything behind it. In an outage, when every request gets a 5xx, nothing ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient } from "../index";
import { claimKeepalive, KEEPALIVE_MAX_BYTES } from "../keepalive";

type Call = { ids: string[]; keepalive: boolean };
let calls: Call[];
/** Fake-clock time of each request, in ms from the start of the test. */
let times: number[];
let t0 = 0;
let respond: (ids: string[], n: number) => Response;
let win: EventTarget;

const ok = () => new Response("{}", { status: 200 });

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  times = [];
  t0 = Date.now();
  responses = [];
  respond = () => ok();
  win = new EventTarget();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const ids = (JSON.parse(String(init.body)).events as Array<{ id?: string; event?: { id: string } }>).map((e) => (e.event?.id ?? e.id) as string);
      times.push(Date.now() - t0);
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
    expect(calls.filter((x) => x.ids.includes(bad))).toHaveLength(6); // 5 answers of 5xx, then the sixth after the server took other requests
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
    await vi.advanceTimersByTimeAsync(1100);
    // The server takes this one, which shows that it is the batch it refuses.
    const witness = c.captureMessage("witness");
    const later: string[] = [];
    for (let ms = 0; ms < 10 * MIN; ms += 30_000) {
      if (ms < 5 * MIN) later.push(c.captureMessage(`later ${ms}`));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(delivered().sort()).toEqual([...ids.filter((id) => id !== bad), witness, ...later].sort());
    // The whole batch got 5 answers and was set aside; every try carried the batch as it was, and the split came after the 2xx.
    expect(calls.slice(0, 5).every((x) => x.ids.join() === ids.join())).toBe(true);
    expect(calls[5].ids).toContain(witness);
    expect(calls[6].ids).toEqual(ids);
    expect(calls.findIndex((x) => x.ids.join() === ids.slice(0, 4).join())).toBe(7);
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

const MIN = 60_000;

/** The budgets are what each scenario costs on the code before batches were kept whole (8, 15, 35 and 15 requests), plus 3: an outage is not to be hammered. */
describe("an outage: the server answers every request with a 5xx, then recovers", () => {
  const scenarios = [
    { name: "O1 3 minutes of 503, 20 errors at the start", minutes: 3, status: 503, steady: false, budget: 8 + 3 },
    { name: "O2 10 minutes of 502, 20 errors and one every 30 s", minutes: 10, status: 502, steady: true, budget: 15 + 3 },
    { name: "O3 30 minutes of 503, 20 errors at the start", minutes: 30, status: 503, steady: false, budget: 35 + 3 },
    { name: "O4 10 minutes of 500, 20 errors and one every 30 s", minutes: 10, status: 500, steady: true, budget: 15 + 3 },
  ];
  it.each(scenarios)("$name: nothing is lost, every batch is resent as it was, and the server is not hammered", async ({ minutes, status, steady, budget }) => {
    answer(() => new Response("{}", { status: Date.now() - t0 < minutes * MIN ? status : 200 }));
    const { c, onDropped } = client();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(c.captureMessage(`burst ${i}`));
    for (let ms = 0; ms < (minutes + 8) * MIN; ms += 30_000) {
      if (steady && ms > 0 && ms < minutes * MIN) ids.push(c.captureMessage(`steady ${ms}`));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(onDropped).not.toHaveBeenCalled();
    expect(delivered().sort()).toEqual([...ids].sort());
    // A batch that failed is resent with exactly its ids: a request that shares an id with an earlier one is the same batch.
    const first = new Map<string, string>();
    for (const x of calls) {
      const key = x.ids.join();
      for (const id of x.ids) {
        expect(first.get(id) ?? key).toBe(key);
        first.set(id, key);
      }
    }
    expect(times.filter((t) => t < minutes * MIN).length).toBeLessThanOrEqual(budget);
    c.close();
  });
});

describe("one bad event while the server takes everything else", () => {
  const spots = [
    { where: "first", at: 0 },
    { where: "in the middle", at: 10 },
    { where: "last", at: 19 },
  ];
  const cases = spots.flatMap((s) => [500, 504].map((status) => ({ ...s, status })));
  it.each(cases)("$status for the event that is $where of a burst of 20: it is dropped once, the rest is delivered within 10 minutes", async ({ at, status }) => {
    let bad = "";
    answer((ids) => new Response("{}", { status: bad && ids.includes(bad) ? status : 200 }));
    const { c, onDropped } = client();
    const good: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = c.captureMessage(`burst ${i}`);
      if (i === at) bad = id;
      else good.push(id);
    }
    for (let ms = 0; ms < 10 * MIN; ms += 30_000) {
      if (ms > 0 && ms < 5 * MIN) good.push(c.captureMessage(`later ${ms}`));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(delivered().sort()).toEqual([...good].sort());
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith({ events: 1, status, reason: "retry_exhausted", eventIds: [bad] });
    c.close();
  });

  it("two bad events, the first and the last of a burst of 20: each is dropped once, the rest is delivered within 15 minutes", async () => {
    let x = "";
    let y = "";
    answer((ids) => new Response("{}", { status: (x && ids.includes(x)) || (y && ids.includes(y)) ? 500 : 200 }));
    const { c, onDropped } = client();
    const good: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = c.captureMessage(`burst ${i}`);
      if (i === 0) x = id;
      else if (i === 19) y = id;
      else good.push(id);
    }
    for (let ms = 0; ms < 15 * MIN; ms += 30_000) {
      if (ms > 0 && ms < 5 * MIN) good.push(c.captureMessage(`later ${ms}`));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(delivered().sort()).toEqual([...good].sort());
    expect(onDropped).toHaveBeenCalledTimes(2);
    expect(onDropped).toHaveBeenCalledWith({ events: 1, status: 500, reason: "retry_exhausted", eventIds: [x] });
    expect(onDropped).toHaveBeenCalledWith({ events: 1, status: 500, reason: "retry_exhausted", eventIds: [y] });
    c.close();
  });
});

describe("a quiet app", () => {
  it("keeps one bad event for 2 hours without dropping it, a try a minute at most; a good event then ends it within 5 minutes", async () => {
    let bad = "";
    answer((ids) => new Response("{}", { status: bad && ids.includes(bad) ? 500 : 200 }));
    const { c, onDropped } = client();
    bad = c.captureMessage("poison");
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(onDropped).not.toHaveBeenCalled();
    expect(calls.every((x) => x.ids.length === 1 && x.ids[0] === bad)).toBe(true);
    // The delay doubles up to a minute: from the eighth try on, no two are closer than that.
    for (let i = 7; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(MIN - 1);
    expect(calls.length).toBeLessThanOrEqual(130);
    const good = c.captureMessage("fine");
    const at = Date.now() - t0;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(delivered()).toEqual([good]);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith({ events: 1, status: 500, reason: "retry_exhausted", eventIds: [bad] });
    expect(times.at(-1)! - at).toBeLessThan(5 * MIN);
    c.close();
  });
});

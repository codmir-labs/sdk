// @vitest-environment jsdom
/**
 * A busy server or an offline browser delays replay segments instead of losing them: a 429 waits out its
 * `Retry-After`, a failing upload goes into a small queue that drains in order, and only a queue that overflows counts
 * as a lost segment. `fetch` is stubbed, the clock is fake, rrweb is the real recorder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const REPLAY_URL = "https://ingest.example.test/api/overseer/replay";

type Call = { body: any; at: number; keepalive: boolean };
let calls: Call[];
let respond: (call: Call) => Response;
let online: boolean;

const ok = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
const status = (code: number, headers: Record<string, string> = {}) => () => new Response("{}", { status: code, headers });
const offlineError = (): never => {
  throw new TypeError("Failed to fetch");
};
const started: Array<{ stop: () => unknown }> = [];
const segmentsSent = () => calls.map((c) => c.body.segment);

beforeEach(() => {
  calls = [];
  online = true;
  respond = ok;
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const call = { body: JSON.parse(String(init.body)), at: Date.now(), keepalive: init.keepalive === true };
      calls.push(call);
      return respond(call);
    }),
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  document.head.innerHTML = "";
  document.body.innerHTML = "<p>a page</p>";
  vi.clearAllTimers();
});

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
});
afterAll(() => {
  vi.useRealTimers();
});
afterEach(() => {
  for (const recorder of started.splice(0)) recorder.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start(config: Record<string, unknown> = {}) {
  const replay = await import("../index");
  const recorder = new replay.ReplayRecorder({
    sessionSampleRate: 1,
    upload: { url: REPLAY_URL, key: "osk_test" },
    ...config,
  });
  started.push(recorder);
  recorder.start();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
  const { record } = await import("@rrweb/record");
  const snapshot = vi.spyOn(record, "takeFullSnapshot");
  return { replay, recorder, snapshot };
}

const click = () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const tick = (ms = 30_000) => vi.advanceTimersByTimeAsync(ms);

/** Advances in 1 s steps, so a timer that fires between two calls is seen at its own time. */
async function run(seconds: number) {
  for (let i = 0; i < seconds; i++) await tick(1000);
}

describe("Retry-After", () => {
  it("reads seconds and HTTP dates, clamped to 1 s .. 10 min, and nothing else", async () => {
    const { parseRetryAfter } = await import("../upload");
    const now = Date.UTC(2026, 0, 1);
    expect(parseRetryAfter("60", now)).toBe(60_000);
    expect(parseRetryAfter(" 7 ", now)).toBe(7000);
    expect(parseRetryAfter("0", now)).toBe(1000);
    expect(parseRetryAfter("99999", now)).toBe(600_000);
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(parseRetryAfter(new Date(now - 90_000).toUTCString(), now)).toBe(1000);
    expect(parseRetryAfter(new Date(now + 3_600_000).toUTCString(), now)).toBe(600_000);
    for (const bad of [null, undefined, "", "soon", "1.5", "-3"]) expect(parseRetryAfter(bad, now)).toBeNull();
  });
});

describe("postSegment", () => {
  const body = async () => {
    const { buildSegmentBody } = await import("../upload");
    return buildSegmentBody({}, { replayId: "r", sequenceNumber: 0, events: [{ type: 2, timestamp: 1 }], errorIds: [] });
  };
  const target = { url: REPLAY_URL, key: "osk_test" };

  it("answers a 429 with a delay and sends no second request", async () => {
    const { postSegment } = await import("../upload");
    respond = status(429, { "Retry-After": "30" });
    expect(await postSegment(target, await body())).toEqual({ outcome: "retry_later", delayMs: 30_000 });
    respond = status(429);
    expect(await postSegment(target, await body())).toEqual({ outcome: "retry_later", delayMs: 60_000 });
    expect(calls).toHaveLength(2);
  });

  it("retries a 5xx or a network error once, then asks to retry later with no delay of its own", async () => {
    const { postSegment } = await import("../upload");
    respond = status(503);
    const result = postSegment(target, await body());
    await tick(1500);
    expect(await result).toEqual({ outcome: "retry_later", delayMs: null });
    expect(calls).toHaveLength(2);
  });

  it("sends a hiding segment once and reports every failure as failed", async () => {
    const { postSegment } = await import("../upload");
    for (const code of [429, 503]) {
      calls.length = 0;
      respond = status(code, { "Retry-After": "5" });
      expect(await postSegment(target, await body(), true)).toBe("failed");
      expect(calls).toHaveLength(1);
    }
  });
});

describe("a busy server", () => {
  it("is waited out for its Retry-After, then the segment is stored and no recovery snapshot is taken", async () => {
    const { recorder, snapshot } = await start();
    let first = true;
    respond = () => {
      if (!first) return ok();
      first = false;
      return status(429, { "Retry-After": "60" })();
    };
    click();
    await tick(); // the 429 comes at this tick
    const answeredAt = calls[0].at;
    await run(70);

    expect(segmentsSent()).toEqual([0, 0]);
    const wait = calls[1].at - answeredAt;
    expect(wait).toBeGreaterThanOrEqual(40_000);
    expect(wait).toBeLessThanOrEqual(61_000);
    expect(snapshot).not.toHaveBeenCalled();
    expect(calls[1].body.events[0].type).toBe(4); // the same segment, with its Meta and FullSnapshot
    recorder.stop();
  });

  it("is waited out for 60 s when the 429 has no readable Retry-After", async () => {
    const { recorder, snapshot } = await start();
    let first = true;
    respond = () => {
      if (!first) return ok();
      first = false;
      return status(429, { "Retry-After": "tomorrow" })();
    };
    click();
    await tick();
    const answeredAt = calls[0].at;
    await run(59);
    expect(calls).toHaveLength(1);
    await run(2);
    expect(calls).toHaveLength(2);
    expect(calls[1].at - answeredAt).toBe(60_000);
    expect(snapshot).not.toHaveBeenCalled();
    recorder.stop();
  });

  it("never sends a new segment ahead of a queued one", async () => {
    const { recorder, snapshot } = await start();
    let limited = true;
    respond = () => (limited ? status(429, { "Retry-After": "120" })() : ok());
    click();
    await tick(); // segment 0 is limited, due again 120 s later
    limited = false;
    click();
    await tick(); // segment 1 is cut 30 s later: it waits behind 0
    click();
    await tick();
    expect(segmentsSent()).toEqual([0]);
    await run(70);
    expect(segmentsSent()).toEqual([0, 0, 1, 2]);
    expect(snapshot).not.toHaveBeenCalled();
    recorder.stop();
  });

  it("drops what waits behind a segment the server refuses for good, and takes a fresh snapshot", async () => {
    const { recorder, snapshot } = await start();
    respond = status(429, { "Retry-After": "120" });
    click();
    await tick();
    click();
    await tick(); // segment 1 waits behind 0
    respond = status(400);
    await run(100);
    expect(segmentsSent()).toEqual([0, 0]); // 0 failed for good, 1 was never sent
    expect(snapshot).toHaveBeenCalledTimes(1);
    respond = ok;
    click();
    await tick();
    expect(calls.at(-1)!.body.events[0].type).toBe(4);
    recorder.stop();
  });
});

describe("an offline browser", () => {
  it("queues up to 10 segments, sends them in order on the online event and loses none", async () => {
    const { recorder, snapshot } = await start();
    online = false;
    respond = offlineError;
    for (let i = 0; i < 10; i++) {
      click();
      await tick(); // segments 0 to 9
    }
    await tick(30_000);
    expect(segmentsSent()).toEqual([0, 0]); // 0 tried twice, 1 to 9 behind it, nothing sent while offline
    expect(snapshot).not.toHaveBeenCalled();

    online = true;
    respond = ok;
    window.dispatchEvent(new Event("online"));
    await run(5);
    expect(segmentsSent()).toEqual([0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(snapshot).not.toHaveBeenCalled();
    await run(400);
    expect(calls).toHaveLength(12); // all stored: nothing is sent again
    recorder.stop();
  });

  it("drops the queue once it would hold an 11th segment, and the recovery snapshot follows", async () => {
    const { recorder, snapshot } = await start();
    online = false;
    respond = offlineError;
    for (let i = 0; i < 11; i++) {
      click();
      await tick();
    }
    expect(snapshot).not.toHaveBeenCalled(); // offline: the snapshot waits for the page
    online = true;
    respond = ok;
    window.dispatchEvent(new Event("online"));
    await run(5);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(segmentsSent()).toEqual([0, 0]); // the dropped segments are never sent
    click();
    await tick();
    expect(segmentsSent()).toEqual([0, 0, 11]);
    expect(calls.at(-1)!.body.events.slice(0, 2).map((e: any) => e.type)).toEqual([4, 2]);
    recorder.stop();
  });

  it("drains after stop() once the browser is back online, although no online listener is left", async () => {
    const { recorder } = await start();
    online = false;
    respond = offlineError;
    click();
    await tick(32_000);
    expect(segmentsSent()).toEqual([0, 0]);
    recorder.stop();
    online = true;
    respond = ok;
    await run(30);
    expect(segmentsSent()).toEqual([0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the recovery snapshots capped through a long outage of the server", async () => {
    const { recorder, snapshot } = await start();
    respond = status(503);
    for (let i = 0; i < 24; i++) {
      click();
      await tick();
    }
    expect(snapshot.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.mock.calls.length).toBeLessThanOrEqual(3);
    recorder.stop();
  });
});

describe("a failing server", () => {
  it("retries once at once, then queues with a 5 s backoff that doubles, and gives the entry up after 6 attempts from the queue", async () => {
    const { recorder } = await start();
    respond = status(503);
    click();
    await tick();
    const t0 = calls[0].at;
    await run(400);
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    expect(gaps.slice(0, 7)).toEqual([1000, 5000, 10_000, 20_000, 40_000, 80_000, 160_000]);
    expect(calls.filter((c) => c.body.segment === 0)).toHaveLength(8); // 2 at first, 6 from the queue
    expect(calls[0].at).toBe(t0);
    recorder.stop();
  });

  it("starts the backoff over at 5 s after a stored segment", async () => {
    const { recorder } = await start();
    respond = status(503);
    click();
    await tick();
    await run(10); // tried at 1 s and again 5 s later: the next wait is 10 s
    respond = ok;
    await run(20);
    expect(calls.at(-1)!.body.segment).toBe(0); // stored
    const stored = calls.length;

    respond = status(503);
    click();
    await tick();
    const failedAt = calls.length; // segment 1, tried now and again 1 s later
    await run(10);
    expect(calls.slice(stored).map((c) => c.body.segment)).toEqual([1, 1, 1]);
    expect(calls[failedAt + 1].at - calls[failedAt].at).toBe(5000); // the backoff started over at 5 s
    recorder.stop();
  });
});

describe("a segment flushed as the page hides", () => {
  it("is sent once with keepalive and never queued", async () => {
    const { recorder } = await start();
    respond = status(429, { "Retry-After": "5" });
    click();
    window.dispatchEvent(new Event("pagehide"));
    await tick(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].keepalive).toBe(true);
    await run(120);
    // The page did not go away, so the recorder carries on: the lost segment's replacement is a later number.
    expect(calls.filter((c) => c.body.segment === 0)).toHaveLength(1);
    recorder.stop();
  });
});

describe("the queue's lifetime", () => {
  it("outlives stop(): the queued segments and the final one are sent after it, in order", async () => {
    const { recorder } = await start();
    respond = status(429, { "Retry-After": "60" });
    click();
    await tick(); // segment 0 is limited and waits
    click();
    recorder.stop(); // segment 1 is the final one, behind 0
    expect(segmentsSent()).toEqual([0]);
    respond = ok;
    await run(90);
    expect(segmentsSent()).toEqual([0, 0, 1]);
    await run(300);
    expect(calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends by itself against a server that never recovers: 6 attempts from the queue, then the entry is lost", async () => {
    const { recorder } = await start();
    respond = status(503);
    click();
    await tick(32_000); // segment 0: tried twice, queued
    click();
    await tick(); // segment 1 waits behind it
    recorder.stop();
    await run(1500);
    expect(calls.filter((c) => c.body.segment === 0)).toHaveLength(2 + 6);
    expect(vi.getTimerCount()).toBe(0);
    const sent = calls.length;
    await tick(30 * 60_000);
    expect(calls).toHaveLength(sent);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("in on-error mode, with the server asking to wait", () => {
    const cases: Array<[string, () => Response]> = [
      ["Retry-After: 60", status(429, { "Retry-After": "60" })],
      ["no readable header", status(429, { "Retry-After": "soon" })],
    ];
    for (const [name, limited] of cases) {
      it(`keeps the error's replay through the next buffer (${name})`, async () => {
        const { recorder, snapshot } = await start({ sessionSampleRate: 0, errorSampleRate: 1 });
        respond = limited;
        recorder.markError("0123456789abcdef");
        await tick(100); // the history goes up and is limited
        const errorReplay = calls[0].body.replay_id;
        click();
        await tick(30_000); // the post-error segment joins the queue; a new buffer starts under a new replay id
        expect(calls).toHaveLength(1);
        respond = ok;
        await tick(25_000);
        expect(calls).toHaveLength(1); // still waiting out the server's minute
        await tick(20_000);
        await run(5);
        const sent = calls.slice(1);
        expect(sent.length).toBeGreaterThanOrEqual(2);
        expect(sent.every((c) => c.body.replay_id === errorReplay)).toBe(true);
        expect(sent.map((c) => c.body.segment)).toEqual(sent.map((_, i) => i));
        await run(300);
        expect(calls).toHaveLength(1 + sent.length); // nothing of the new buffer is uploaded
        expect(snapshot).toHaveBeenCalledTimes(1); // the new buffer's own, none for recovery
        recorder.stop();
      });
    }
  });

  it("never lets an entry of a newer replay overtake one of the older replay", async () => {
    const { recorder } = await start({ sessionSampleRate: 0, errorSampleRate: 1 });
    respond = status(429, { "Retry-After": "60" });
    recorder.markError("0123456789abcdef");
    await tick(100);
    const first = calls[0].body.replay_id;
    click();
    await tick(30_000); // post-error segment queued; the second buffer starts
    click();
    recorder.markError("fedcba9876543210"); // its history joins the queue, as segment 0 of the new replay
    respond = ok;
    await run(70);
    const sent = calls.slice(1);
    const order = sent.map((c) => c.body.replay_id === first);
    expect(order.length).toBeGreaterThanOrEqual(3);
    expect(order).toEqual([...order].sort((a, b) => Number(b) - Number(a))); // all of the old replay, then the new one
    expect(sent.filter((c) => c.body.replay_id === first).map((c) => c.body.segment)).toEqual([0, 1]);
    recorder.stop();
  });
});

describe("the online event", () => {
  it("does not send before the server's time", async () => {
    const { recorder } = await start();
    respond = status(429, { "Retry-After": "40" });
    click();
    await tick();
    const limitedAt = calls[0].at;
    respond = ok;
    await tick(5000);
    window.dispatchEvent(new Event("online"));
    await tick(20_000);
    expect(calls).toHaveLength(1);
    await tick(20_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].at - limitedAt).toBeGreaterThanOrEqual(40_000);
    recorder.stop();
  });

  it("sends at once when the head is waiting out a backoff", async () => {
    const { recorder } = await start();
    respond = status(503);
    click();
    await tick(32_000); // tried twice, queued with a 5 s backoff
    expect(calls).toHaveLength(2);
    respond = ok;
    await tick(1000);
    window.dispatchEvent(new Event("online"));
    await tick(10);
    expect(calls).toHaveLength(3);
    recorder.stop();
  });
});

describe("a session whose uploads all succeed", () => {
  it("sends exactly one request per segment, in order", async () => {
    const { recorder, snapshot } = await start();
    for (let i = 0; i < 3; i++) {
      click();
      await tick();
    }
    await run(600);
    expect(segmentsSent()).toEqual([0, 1, 2]);
    expect(snapshot).not.toHaveBeenCalled();
    recorder.stop();
  });
});

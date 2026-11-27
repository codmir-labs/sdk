// @vitest-environment jsdom
/**
 * The on-error buffer and the segments are capped in bytes, an upload of one replay has at most two requests in flight,
 * and the session record stops growing. `fetch` is stubbed, the clock is fake, rrweb is the real recorder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as upload from "../upload";

/** The cap the buffer and the segments keep: 4 MiB of event JSON. */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** What an event adds to a body: its JSON bytes and a comma. */
const eventBytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event)) + 1;

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;
const META = 4;
const FULL_SNAPSHOT = 2;

type Call = { url: string; at: number; keepalive: boolean; raw: string; body: { segment: number; events: Array<{ type: number }> } };
let calls: Call[];
/** Requests to the replay endpoint that have not answered, oldest first; `hold` keeps them open until `release`. */
let open: Array<(response: Response) => void>;
let hold: boolean;
let inFlight: number;
let mostInFlight: number;

const ok = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const sequence = () => replayCalls().map((c) => c.body.segment);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  calls = [];
  open = [];
  hold = false;
  inFlight = 0;
  mostInFlight = 0;
  vi.resetModules();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("codmir.keepalive.budget")];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = String(init.body);
      calls.push({ url, at: Date.now(), keepalive: (init as { keepalive?: boolean }).keepalive === true, raw, body: JSON.parse(raw) });
      if (url !== REPLAY_URL || !hold) return ok();
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      const response = await new Promise<Response>((resolve) => open.push(resolve));
      inFlight--;
      return response;
    }),
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "<p>a page</p>";
  vi.clearAllTimers();
});

const started: Array<{ stop(): unknown }> = [];
afterEach(async () => {
  for (const one of started.splice(0)) one.stop();
  const replay = await import("../index");
  replay.stopReplay();
  (await import("../../overseer/index")).close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (navigator as unknown as Record<string, unknown>).onLine;
});

/** Answers the oldest open request, and lets what that starts run. */
async function release(response: Response = ok()) {
  open.shift()?.(response);
  await advance(0);
}

async function startRecorder(config: Record<string, unknown> = {}) {
  const replay = await import("../index");
  const recorder = new replay.ReplayRecorder(config);
  started.push(recorder);
  recorder.start();
  await vi.dynamicImportSettled();
  await advance(0);
  return { replay, recorder };
}

type Scenario = { name: string; everyMs: number; setup: () => void; tick: (n: number) => void };
const clock: Scenario = {
  name: "clock",
  everyMs: 1000,
  setup: () => {
    document.body.innerHTML = `<time id="c">0</time>`;
  },
  tick: (n) => {
    document.getElementById("c")!.textContent = `12:00:${n}`;
  },
};
const chat: Scenario = {
  name: "chat",
  everyMs: 500,
  setup: () => {
    document.body.innerHTML = `<div id="log"></div>`;
  },
  tick: (n) => {
    const message = document.createElement("div");
    message.textContent = `msg ${n} ${"x".repeat(300)}`;
    document.getElementById("log")!.appendChild(message);
  },
};
const table: Scenario = {
  name: "table",
  everyMs: 1000,
  setup: () => {
    document.body.innerHTML = `<table><tbody id="t"></tbody></table>`;
  },
  tick: (n) => {
    document.getElementById("t")!.innerHTML = Array.from({ length: 500 }, (_, i) => `<tr><td>${n}-${i}</td><td>value ${i * n}</td></tr>`).join("");
  },
};

type Held = { prevBuffer: unknown[]; curBuffer: unknown[] };
const heldBytes = (recorder: object) => {
  const { prevBuffer, curBuffer } = recorder as unknown as Held;
  return bytesOf(prevBuffer) + bytesOf(curBuffer);
};

/** Runs a page for `seconds`, one change per `everyMs`, and reads the buffer's JSON bytes at each of `at` (seconds). */
async function heldAt(scenario: Scenario, at: number[]) {
  scenario.setup();
  const { recorder } = await startRecorder({ sessionSampleRate: 0, errorSampleRate: 1 });
  const held: Record<number, number> = {};
  let n = 0;
  for (let t = scenario.everyMs; t <= Math.max(...at) * 1000; t += scenario.everyMs) {
    await advance(scenario.everyMs);
    scenario.tick(++n);
    await advance(0); // the MutationObserver delivers
    if (at.includes(t / 1000)) held[t / 1000] = heldBytes(recorder);
  }
  recorder.stop();
  return held;
}

describe("the on-error buffer is capped in bytes", () => {
  it("the cap is 4 MiB, and an event is measured as its JSON bytes plus a comma", () => {
    expect(upload.MAX_BUFFER_BYTES).toBe(MAX_BUFFER_BYTES);
    const event = { type: 5, timestamp: 1, data: { text: "é€😀" } };
    expect(upload.eventBytes(event)).toBe(eventBytes(event));
  });

  it("a table of 500 rows re-rendered every second holds at most MAX_BUFFER_BYTES at 30, 60, 120 and 300 s", async () => {
    const held = await heldAt(table, [30, 60, 120, 300]);
    console.log("[buffer-cap] table", JSON.stringify(held));
    for (const seconds of [30, 60, 120, 300]) {
      expect(held[seconds]).toBeGreaterThan(0);
      expect(held[seconds]).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
    }
  }, 180_000);

  it("a clock holds the bytes it held before the cap, which it never reached", async () => {
    const held = await heldAt(clock, [30, 60, 120, 300]);
    console.log("[buffer-cap] clock", JSON.stringify(held));
    expect(held).toEqual(CLOCK_BYTES);
  }, 180_000);

  it("a chat of 300-character messages holds the bytes it held before the cap, which it never reached", async () => {
    const held = await heldAt(chat, [30, 60, 120, 300]);
    console.log("[buffer-cap] chat", JSON.stringify(held));
    expect(held).toEqual(CHAT_BYTES);
  }, 180_000);

  it("the history at an error starts with a Meta event and a FullSnapshot, whenever the error comes", async () => {
    table.setup();
    const { recorder } = await startRecorder({ sessionSampleRate: 0, errorSampleRate: 1 });
    const history = recorder as unknown as Held;
    let n = 0;
    for (let second = 1; second <= 100; second++) {
      await advance(1000);
      table.tick(++n);
      await advance(0);
      const events = history.prevBuffer.concat(history.curBuffer) as Array<{ type: number }>;
      expect(events[0].type).toBe(META);
      expect(events[1].type).toBe(FULL_SNAPSHOT);
    }
  }, 120_000);

  it("the early checkout starts at half the cap: from 30 s to 120 s the table page holds between 40% and 100% of the cap, and always opens with a Meta and a FullSnapshot", async () => {
    table.setup();
    const { recorder } = await startRecorder({ sessionSampleRate: 0, errorSampleRate: 1 });
    const history = recorder as unknown as Held;
    const held: Record<number, number> = {};
    let n = 0;
    let rotations = 0;
    let generation = history.curBuffer;
    for (let second = 1; second <= 120; second++) {
      await advance(1000);
      table.tick(++n);
      await advance(0);
      if (history.curBuffer !== generation) rotations++;
      generation = history.curBuffer;
      if (second < 30) continue;
      held[second] = heldBytes(recorder);
      const events = history.prevBuffer.concat(history.curBuffer) as Array<{ type: number }>;
      expect(events[0].type).toBe(META);
      expect(events[1].type).toBe(FULL_SNAPSHOT);
    }
    const sampled = Object.values(held);
    console.log("[buffer-cap] table 30-120 s", JSON.stringify({ min: Math.min(...sampled), max: Math.max(...sampled), generationsIn120s: rotations }));
    for (const bytes of sampled) {
      expect(bytes).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
      expect(bytes).toBeGreaterThanOrEqual(MAX_BUFFER_BYTES * 0.4);
    }
  }, 120_000);

  it("a generation that reaches half the cap gets an early checkout, and the older one is dropped when the two pass the cap", async () => {
    const { recorder } = await startRecorder({ sessionSampleRate: 0, errorSampleRate: 1 });
    const { record } = await import("@rrweb/record");
    const checkout = vi.spyOn(record, "takeFullSnapshot");
    const held = recorder as unknown as Held;
    const first = held.curBuffer[0];
    // 1 MB custom events: five of them are over the cap with room to spare
    for (let i = 0; i < 6; i++) {
      recorder.addCustomEvent("bulk", { filler: "x".repeat(1_000_000), i });
      await advance(0);
    }
    expect(checkout).toHaveBeenCalledWith(true);
    expect(held.curBuffer[0]).not.toBe(first);
    expect((held.curBuffer[0] as { type: number }).type).toBe(META);
    expect(heldBytes(recorder)).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
  });
});

describe("an error sends two uploads at a time", () => {
  /** A table page at `seconds`, then one error with every replay request held open. */
  async function errorAfter(seconds: number) {
    const overseer = await import("../../overseer/index");
    const replay = await import("../index");
    table.setup();
    overseer.init({ dsn: DSN, clientKey: "osk_test", replaysOnErrorSampleRate: 1 });
    replay.startReplay();
    await vi.dynamicImportSettled();
    await advance(0);
    for (let n = 1; n <= seconds; n++) {
      await advance(1000);
      table.tick(n);
      await advance(0);
    }
    hold = true;
    const at = Date.now();
    overseer.captureException(new Error("boom"));
    await advance(0);
    return { at };
  }

  it("on the table page at 60 s: at most 2 requests are in flight, every chunk arrives in sequence order, and it opens with a Meta and a FullSnapshot", async () => {
    const { at } = await errorAfter(60);
    const atTheInstant = replayCalls().filter((c) => c.at === at);
    expect(atTheInstant.length).toBeGreaterThan(0);
    expect(atTheInstant.length).toBeLessThanOrEqual(2);

    while (open.length > 0) await release();
    await advance(0);
    const chunks = replayCalls();
    console.log("[buffer-cap] chunks", JSON.stringify({ count: chunks.length, bytes: chunks.map((c) => c.raw.length), mostInFlight }));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(mostInFlight).toBeLessThanOrEqual(2);
    expect(sequence()).toEqual(chunks.map((_, i) => i));
    const events = chunks.flatMap((c) => c.body.events as Array<{ type: number }>);
    expect(events[0].type).toBe(META);
    expect(events[1].type).toBe(FULL_SNAPSHOT);
    expect(bytesOf(events)).toBeLessThanOrEqual(MAX_BUFFER_BYTES + events.length);
  }, 120_000);

  for (const seconds of [31, 97]) {
    it(`on the table page at ${seconds} s the replay it sends opens with a Meta and a FullSnapshot`, async () => {
      await errorAfter(seconds);
      while (open.length > 0) await release();
      const events = replayCalls().flatMap((c) => c.body.events as Array<{ type: number }>);
      expect(events[0].type).toBe(META);
      expect(events[1].type).toBe(FULL_SNAPSHOT);
      expect(bytesOf(events)).toBeLessThanOrEqual(MAX_BUFFER_BYTES + events.length);
    }, 120_000);
  }

  it("with three chunks, the third starts when one of the first two settles, never before", async () => {
    await errorAfter(63); // 3.9 MB of history, just under the cap: three chunks of at most 1.8 MB
    const started = () => replayCalls().length;
    expect(started()).toBe(2);
    await advance(10_000); // nothing answers: nothing more starts
    expect(started()).toBe(2);
    await release();
    expect(started()).toBe(3);
    expect(mostInFlight).toBe(2);
    while (open.length > 0) await release();
    expect(replayCalls()).toHaveLength(3);
    expect(sequence()).toEqual([0, 1, 2]);
  }, 120_000);
});

describe("a session or post-error segment is cut by bytes", () => {
  it("no segment holds more than MAX_BUFFER_BYTES, and they go out before the 30 s cut", async () => {
    const { recorder } = await startRecorder({ sessionSampleRate: 1, upload: { url: REPLAY_URL, key: "osk_test" } });
    const emitted: number[] = [];
    const emit = (recorder as unknown as { emitSegment(events: Array<{ type: number; timestamp: number }>): void }).emitSegment;
    vi.spyOn(recorder as unknown as { emitSegment: typeof emit }, "emitSegment").mockImplementation(function (this: unknown, events) {
      emitted.push(events.reduce((sum, event) => sum + eventBytes(event), 0));
      return emit.call(this, events);
    });
    for (let i = 0; i < 26; i++) {
      recorder.addCustomEvent("bulk", { filler: "y".repeat(400_000), i });
      await advance(0);
      const held = (recorder as unknown as { events: unknown[] }).events;
      expect(bytesOf(held)).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
    }
    await advance(1000); // still well before the 30 s tick
    console.log("[buffer-cap] session segments", JSON.stringify(emitted));
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const bytes of emitted) expect(bytes).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
    const sent = replayCalls().flatMap((c) => c.body.events as Array<{ type: number; data?: { tag?: string } }>);
    expect(sent.filter((e) => e.data?.tag === "bulk").length).toBeGreaterThanOrEqual(10);
  }, 60_000);
});

describe("the session record is bounded", () => {
  it("20,000 markError calls hold the newest 500 ids", async () => {
    const { recorder } = await startRecorder({ sessionSampleRate: 0, errorSampleRate: 1 });
    for (let i = 0; i < 20_000; i++) recorder.markError(`e${i}`);
    const { session, pendingErrorIds } = recorder as unknown as { session: { errorIds: string[] }; pendingErrorIds: string[] };
    expect(session.errorIds).toHaveLength(500);
    expect(session.errorIds[0]).toBe("e19500");
    expect(session.errorIds[499]).toBe("e19999");
    expect(pendingErrorIds.length).toBeLessThanOrEqual(500);
    const stopped = recorder.stop();
    expect(stopped?.errorIds).toHaveLength(500);
  });

  it("600 emitted segments leave the newest 500 records", async () => {
    const { recorder } = await startRecorder({ sessionSampleRate: 1, maxSegmentEvents: 1 });
    for (let i = 0; i < 600; i++) {
      recorder.addCustomEvent("one", { i });
      await advance(0);
    }
    const { session, segments } = recorder as unknown as { session: { segments: Array<{ sequenceNumber: number; events: unknown[] }> }; segments: { next: number } };
    expect(segments.next).toBeGreaterThanOrEqual(600);
    expect(session.segments).toHaveLength(500);
    expect(session.segments.map((s) => s.sequenceNumber)).toEqual(Array.from({ length: 500 }, (_, i) => segments.next - 500 + i));
    expect(session.segments.every((s) => s.events.length === 0)).toBe(true);
  });
});

describe("segments waiting for a slot and the page hide", () => {
  /** One-event segments with every request held: two are out and the rest wait. */
  async function waitingSegments() {
    hold = true;
    const { recorder } = await startRecorder({ sessionSampleRate: 1, maxSegmentEvents: 1, upload: { url: REPLAY_URL, key: "osk_test" } });
    for (let i = 0; i < 6; i++) {
      recorder.addCustomEvent("one", { i });
      await advance(0);
    }
    return recorder;
  }

  it("a hide sends what waits once, oldest first, with keepalive while it fits, and nothing is sent twice", async () => {
    await waitingSegments();
    const before = sequence();
    expect(before).toEqual([0, 1]);
    window.dispatchEvent(new Event("pagehide"));
    await advance(0);
    const afterHide = replayCalls().slice(before.length);
    expect(afterHide.length).toBeGreaterThanOrEqual(6);
    expect(afterHide.map((c) => c.body.segment)).toEqual(afterHide.map((_, i) => i + 2));
    expect(afterHide.every((c) => c.keepalive)).toBe(true);
    // the answers change nothing: no segment goes out again
    while (open.length > 0) await release();
    await advance(60_000);
    const all = sequence();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(all.map((_, i) => i));
  });

  it("a hide while offline keeps what waits in the retry queue, and it goes out once when the page is back", async () => {
    await waitingSegments();
    let online = false;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
    window.dispatchEvent(new Event("pagehide"));
    await advance(0);
    expect(sequence()).toEqual([0, 1]);
    while (open.length > 0) await release();
    hold = false;
    online = true;
    window.dispatchEvent(new Event("online"));
    await advance(60_000);
    const all = sequence();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all).toEqual([...all].sort((a, b) => a - b));
  });

  it("a refusal while chunks wait: none of the waiting chunks is sent", async () => {
    await waitingSegments();
    expect(sequence()).toEqual([0, 1]);
    await release(new Response(JSON.stringify({ stored: false, reason: "payment_required" }), { status: 202 }));
    expect(sequence()).toEqual([0, 1]);
    await release();
    await advance(60_000);
    expect(sequence()).toEqual([0, 1]);
  });
});

describe("a request slot is freed on every path", () => {
  it("a request that rejects frees its slot: the next waiting segment is still sent", async () => {
    const real = await vi.importActual<typeof import("../upload")>("../upload");
    const postSegment = vi.fn(real.postSegment);
    vi.resetModules();
    vi.doMock("../upload", () => ({ ...real, postSegment }));
    try {
      postSegment.mockImplementationOnce(() => Promise.reject(new Error("rejected")));
      hold = true;
      const { recorder } = await startRecorder({ sessionSampleRate: 1, maxSegmentEvents: 1, upload: { url: REPLAY_URL, key: "osk_test" } });
      for (let i = 0; i < 6; i++) {
        recorder.addCustomEvent("one", { i });
        await advance(0);
      }
      // the first request rejected at once, so its slot was free for the third segment while the second is still open
      expect(postSegment.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(sequence().slice(0, 2)).toEqual([1, 2]);
      while (open.length > 0) await release();
      await advance(60_000);
      const sent = sequence();
      expect(sent.length).toBeGreaterThanOrEqual(5);
      expect(sent).toEqual(sent.map((_, i) => i + 1)); // none skipped but the rejected one
    } finally {
      vi.doUnmock("../upload");
    }
  });
});

describe("a snapshot too large for one request halts the replay", () => {
  it("none of the segments waiting for a slot is sent afterwards", async () => {
    hold = true;
    const { recorder } = await startRecorder({ sessionSampleRate: 1, maxSegmentEvents: 1, upload: { url: REPLAY_URL, key: "osk_test" } });
    for (let i = 0; i < 6; i++) {
      recorder.addCustomEvent("one", { i });
      await advance(0);
    }
    const held = recorder as unknown as { waiting: unknown[]; halted: boolean };
    expect(sequence()).toEqual([0, 1]);
    expect(held.waiting.length).toBeGreaterThanOrEqual(4);
    // a text node over the size of one request: the next full snapshot cannot be sent in pieces
    const big = document.createElement("p");
    big.textContent = "x".repeat(upload.TARGET_BODY_BYTES + 100_000);
    document.body.appendChild(big);
    const { record } = await import("@rrweb/record");
    record.takeFullSnapshot(true);
    await advance(1000);
    expect(held.halted).toBe(true);
    expect(held.waiting).toEqual([]);
    while (open.length > 0) await release();
    await advance(60_000);
    expect(sequence()).toEqual([0, 1]);
  });
});

/** JSON bytes the clock and the chat page held at 30, 60, 120 and 300 s before the cap (measured on 66d0439). */
const CLOCK_BYTES: Record<number, number> = { 30: 6823, 60: 13664, 120: 13347, 300: 12182 };
const CHAT_BYTES: Record<number, number> = { 30: 35929, 60: 96994, 120: 196346, 300: 494787 };

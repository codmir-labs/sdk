// @vitest-environment jsdom
/**
 * A replay stays playable after a lost segment: a session takes a full snapshot every few minutes, a lost segment is
 * followed by a fresh one, and a snapshot too big for one request ends the replay. `fetch` is stubbed, the clock is
 * fake, rrweb is the real recorder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const recordCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@rrweb/record", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rrweb/record")>();
  const record = new Proxy(real.record, {
    apply(target, self, args) {
      recordCalls.push(args[0] as Record<string, unknown>);
      return Reflect.apply(target, self, args);
    },
  });
  return { ...real, record };
});

const REPLAY_URL = "https://ingest.example.test/api/overseer/replay";
const META = 4;
const FULL_SNAPSHOT = 2;
const CUSTOM = 5;

type Call = { body: any };
let calls: Call[];
let respond: (call: Call) => Response;
let online: boolean;

const ok = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
const refused400 = () => new Response("", { status: 400 });
/** Eleven segments of an offline page: the first goes to the retry queue, and the eleventh is one too many, so the queue is dropped. */
async function loseSegmentsOffline() {
  online = false;
  respond = offlineError;
  for (let i = 0; i < 11; i++) {
    click();
    await tick();
  }
}
const offlineError = (): never => {
  throw new TypeError("Failed to fetch");
};
const types = (call: Call) => call.body.events.map((e: any) => e.type);
const hasMarker = (call: Call, name: string) => call.body.events.some((e: any) => e.type === CUSTOM && e.data?.tag === name);

beforeEach(() => {
  calls = [];
  recordCalls.length = 0;
  online = true;
  respond = ok;
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const call = { body: JSON.parse(String(init.body)) };
      calls.push(call);
      return respond(call);
    }),
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  document.head.innerHTML = "";
  document.body.innerHTML = "<p>a page</p>";
  vi.clearAllTimers();
});

// One fake clock for the whole file: rrweb keeps `Date.now` from the moment it is first loaded, so a clock replaced per
// test would leave it timestamping with a dead one, and its periodic checkout (which reads those timestamps) would never fire.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
});
afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
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
  const segments: unknown[] = [];
  recorder.onSegment((s) => segments.push(s));
  recorder.start();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
  const { record } = await import("@rrweb/record");
  const snapshot = vi.spyOn(record, "takeFullSnapshot");
  return { replay, recorder, segments, snapshot, record };
}

const click = () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const tick = (ms = 30_000) => vi.advanceTimersByTimeAsync(ms);

describe("a session takes a full snapshot every few minutes", () => {
  it("asks rrweb for a checkout every 5 minutes in session mode, and keeps the on-error buffer's own interval", async () => {
    const { replay, recorder } = await start();
    expect(replay.SESSION_CHECKOUT_MS).toBe(300_000);
    expect(recordCalls.at(-1)?.checkoutEveryNms).toBe(300_000);
    recorder.stop();

    recordCalls.length = 0;
    const buffered = await start({ sessionSampleRate: 0, errorSampleRate: 1 });
    expect(recordCalls.at(-1)?.checkoutEveryNms).toBe(30_000); // half of the default 60 s buffer
    buffered.recorder.stop();
  });
});

describe("a session whose uploads all succeed", () => {
  it("uploads the same contiguous segments, takes no extra snapshot and starts only the first with Meta and FullSnapshot", async () => {
    const { recorder, snapshot } = await start();
    for (let i = 0; i < 3; i++) {
      click();
      await tick();
    }
    expect(calls.map((c) => c.body.segment)).toEqual([0, 1, 2]);
    expect(types(calls[0]).slice(0, 2)).toEqual([META, FULL_SNAPSHOT]);
    for (const later of calls.slice(1)) expect(types(later)).not.toContain(FULL_SNAPSHOT);
    expect(snapshot).not.toHaveBeenCalled();
    recorder.stop();
  });
});

describe("a snapshot that cannot fit one request", () => {
  it("uploads nothing of that replay, stops the recorder and says why once", async () => {
    document.body.innerHTML = `<p>${"x".repeat(2_200_000)}</p>`;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { recorder, segments } = await start({ upload: { url: REPLAY_URL, key: "osk_test", debug: true } });
    click();
    await tick();
    await tick();

    expect(calls).toHaveLength(0);
    expect(segments).toHaveLength(0);
    expect(recorder.isActive()).toBe(false);
    const lines = log.mock.calls.filter((args) => String(args[0]).startsWith("[Overseer replay]"));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toMatch(/full snapshot.*cannot be played/);
  });

  it("does the same in on-error mode: the error uploads nothing and the buffer stops", async () => {
    document.body.innerHTML = `<p>${"x".repeat(2_200_000)}</p>`;
    const { recorder, segments } = await start({ sessionSampleRate: 0, errorSampleRate: 1 });
    recorder.markError("0123456789abcdef");
    await tick();
    expect(calls).toHaveLength(0);
    expect(segments).toHaveLength(0);
    expect(recorder.isActive()).toBe(false);
  });
});

describe("a lost segment is followed by a fresh full snapshot", () => {
  it("waits while offline, takes one snapshot on the online event, and no stored segment holds the lost state", async () => {
    const { recorder, snapshot } = await start();
    await loseSegmentsOffline(); // segment 0 goes out and fails, twice, 1 s apart; 1 to 10 queue behind it and are dropped
    expect(calls.map((c) => c.body.segment)).toEqual([0, 0]);
    expect(snapshot).not.toHaveBeenCalled();

    recorder.addCustomEvent("lost-state", 1);
    click();
    await tick();
    await tick();
    expect(snapshot).not.toHaveBeenCalled(); // offline stretch: no repeated serialisation
    expect(calls).toHaveLength(2); // and nothing sent that could not play

    online = true;
    respond = ok;
    window.dispatchEvent(new Event("online"));
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith(true);
    click();
    await tick();

    const stored = calls.slice(2);
    expect(stored.length).toBeGreaterThan(0);
    expect(types(stored[0]).slice(0, 2)).toEqual([META, FULL_SNAPSHOT]);
    expect(calls.some((c) => hasMarker(c, "lost-state"))).toBe(false);
    recorder.stop();
  });

  it("takes the snapshot at the first flush back online when no online event came", async () => {
    const { recorder, snapshot } = await start();
    await loseSegmentsOffline();
    expect(snapshot).not.toHaveBeenCalled();

    online = true;
    respond = ok;
    click();
    await tick();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(types(calls.at(-1)!).slice(0, 2)).toEqual([META, FULL_SNAPSHOT]);
    recorder.stop();
  });

  it("takes one snapshot for several segments lost together", async () => {
    const { recorder, snapshot } = await start({ maxSegmentEvents: 2 });
    respond = (call) => (call.body.segment <= 2 ? refused400() : ok());
    for (let i = 0; i < 5; i++) click();
    await tick(0);
    expect(new Set(calls.map((c) => c.body.segment)).size).toBeGreaterThanOrEqual(3);
    await tick(10); // every one of them is refused
    expect(snapshot).toHaveBeenCalledTimes(1);

    await tick();
    const stored = calls.filter((c) => c.body.segment > 2);
    expect(stored.length).toBeGreaterThan(0);
    expect(types(stored[0]).slice(0, 2)).toEqual([META, FULL_SNAPSHOT]);
    expect(snapshot).toHaveBeenCalledTimes(1);
    recorder.stop();
  });

  it("recovers from a single event the server refuses as too large", async () => {
    const { recorder, snapshot } = await start();
    recorder.addCustomEvent("too-big", 1);
    respond = (call) => (hasMarker(call, "too-big") ? new Response("", { status: 413 }) : ok());
    await tick();
    await tick(10);
    expect(snapshot).toHaveBeenCalledTimes(1);

    click();
    await tick();
    const last = calls.at(-1)!;
    expect(types(last).slice(0, 2)).toEqual([META, FULL_SNAPSHOT]);
    expect(hasMarker(last, "too-big")).toBe(false);
    recorder.stop();
  });

  it("recovers in the post-error window of on-error mode", async () => {
    const { recorder, snapshot } = await start({ sessionSampleRate: 0, errorSampleRate: 1 });
    respond = refused400;
    recorder.markError("0123456789abcdef");
    await tick(10); // the history segment failed
    expect(snapshot).toHaveBeenCalledTimes(1);
    recorder.stop();
  });

  it("takes no snapshot after stop, even when the page comes back online", async () => {
    const { recorder, snapshot } = await start();
    await loseSegmentsOffline();
    recorder.stop();
    online = true;
    window.dispatchEvent(new Event("online"));
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe("recovery is bounded", () => {
  const unauthorized = () => new Response(JSON.stringify({ error: "Invalid key" }), { status: 401 });

  it("takes 3 recovery snapshots for a server answering 401, then none, and resumes at the next checkout", async () => {
    const { recorder, snapshot } = await start({ maxSegmentEvents: 1000 });
    respond = unauthorized;
    for (let i = 0; i < 12; i++) {
      click();
      await tick(); // 12 ticks of 30 s, every segment answered 401
    }
    expect(snapshot).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 4; i++) {
      click();
      await tick();
    }
    expect(snapshot).toHaveBeenCalledTimes(3);
    const before = calls.length;

    // rrweb's periodic checkout arrives on its own with the next event past SESSION_CHECKOUT_MS
    respond = ok;
    await tick(300_000);
    click();
    await tick();
    const stored = calls.slice(before).filter((c) => c.body.events.length > 0);
    expect(stored.length).toBeGreaterThan(0);
    expect(types(stored[0]).slice(0, 2)).toEqual([META, FULL_SNAPSHOT]);
    expect(snapshot).toHaveBeenCalledTimes(3); // the checkout is rrweb's own, not a recovery

    // a stored segment reset the count: a later single loss recovers at once
    respond = unauthorized;
    click();
    await tick();
    expect(snapshot).toHaveBeenCalledTimes(4);
    recorder.stop();
  });
});

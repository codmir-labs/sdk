// @vitest-environment jsdom
/**
 * A replay session is a visit: its id, its draw and its segment numbers live in `sessionStorage`, so a page load
 * continues it, 15 minutes without input ends it, and the hour bound splits it instead of ending recording. Same
 * harness as the other replay tests: `fetch` stubbed, fake clock, rrweb loaded through the real dynamic import. A
 * page load is `vi.resetModules()` and a new `load()`; the old page is "unloaded" by stopping it and putting back what
 * it had stored, since `stop()` is a decision of the app and forgets the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;
const KEY = "codmir.replay.session";
const MIN = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the body is whatever the stub saw
type Call = { url: string; body: any };
type Sent = { event?: { id?: string; tags: { replay_id?: string } } };
let calls: Call[];

const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const ingestCalls = () => calls.filter((c) => c.url === `${DSN}/ingest`);
const ids = () => [...new Set(replayCalls().map((c) => c.body.replay_id as string))];
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const click = () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const random = (...values: number[]) => {
  const spy = vi.spyOn(Math, "random");
  values.forEach((v) => spy.mockReturnValueOnce(v));
  spy.mockReturnValue(values[values.length - 1]);
};

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.resetModules();
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ stored: true }), { status: 202 });
    }),
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "<p>a page</p>";
});

afterEach(async () => {
  const replay = await import("../index");
  replay.stopReplay();
  (await import("../../overseer/index")).close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

/** A page load: fresh modules, `init()` with the rates, `startReplay()`. */
async function load(config: Record<string, unknown> = {}) {
  vi.resetModules();
  const overseer = await import("../../overseer/index");
  const replay = await import("../index");
  overseer.init({ dsn: DSN, clientKey: "osk_test", environment: "production", rateLimit: false, ...config });
  const id = replay.startReplay();
  await vi.dynamicImportSettled();
  await advance(0);
  return { overseer, replay, id };
}

/** The page goes away: it hides, and what it stored stays, as a closed page leaves it. */
async function unload(replay: { stopReplay(): void }) {
  window.dispatchEvent(new Event("pagehide"));
  await advance(0);
  let kept: string | null = null;
  try {
    kept = window.sessionStorage.getItem(KEY);
  } catch {
    // a failing storage keeps nothing
  }
  replay.stopReplay();
  try {
    if (kept !== null) window.sessionStorage.setItem(KEY, kept);
  } catch {
    // as above
  }
  (await import("../../overseer/index")).close();
}

describe("across page loads", () => {
  it("two page loads share one replay id, and the second carries on the segment numbers, with a full snapshot first", async () => {
    const first = await load({ replaysSessionSampleRate: 1 });
    click();
    await advance(5000);
    await unload(first.replay);
    const before = replayCalls().map((c) => c.body.segment);
    expect(before.length).toBeGreaterThan(0);
    const next = Math.max(...before) + 1;
    const calledBefore = calls.length;

    await advance(MIN);
    const second = await load({ replaysSessionSampleRate: 1 });
    expect(second.id).toBe(first.id);
    click();
    await advance(5000);
    const after = replayCalls().slice(calledBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.body.replay_id === first.id)).toBe(true);
    expect(after[0].body.segment).toBe(next);
    const types: number[] = after[0].body.events.map((e: { type: number }) => e.type);
    expect(types.slice(0, 2)).toEqual([4, 2]); // Meta, then FullSnapshot
  });

  it("what is stored is ids, counters and times, never recorded content", async () => {
    document.body.innerHTML = "<p>secret words on the page</p>";
    const first = await load({ replaysSessionSampleRate: 1 });
    await advance(5000);
    await unload(first.replay);
    const raw = window.sessionStorage.getItem(KEY) as string;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["id", "lastActivity", "mode", "next", "startedAt"]);
    expect(raw).not.toContain("secret");
  });
});

describe("the draw is kept", () => {
  it("a draw that missed keeps the second load unsampled, even when its Math.random would hit", async () => {
    random(0.5);
    const first = await load({ replaysSessionSampleRate: 0.1, replaysOnErrorSampleRate: 0 });
    expect(first.id).toBeNull();
    await unload(first.replay);

    vi.restoreAllMocks();
    random(0.01);
    const second = await load({ replaysSessionSampleRate: 0.1, replaysOnErrorSampleRate: 0 });
    expect(second.id).toBeNull();
    await advance(MIN);
    expect(replayCalls()).toHaveLength(0);
  });

  it("a draw that hit keeps the second load recording, even when its Math.random would miss", async () => {
    random(0.01);
    const first = await load({ replaysSessionSampleRate: 0.1, replaysOnErrorSampleRate: 0 });
    expect(first.id).not.toBeNull();
    await advance(5000);
    await unload(first.replay);

    vi.restoreAllMocks();
    random(0.99);
    const second = await load({ replaysSessionSampleRate: 0.1, replaysOnErrorSampleRate: 0 });
    expect(second.id).toBe(first.id);
  });
});

describe("a stored session that is idle", () => {
  it("is not continued after 16 minutes: a new id, and a new draw", async () => {
    const first = await load({ replaysSessionSampleRate: 1 });
    await advance(5000);
    await unload(first.replay);

    await advance(16 * MIN);
    random(0.99); // the new draw misses
    const missed = await load({ replaysSessionSampleRate: 0.5, replaysOnErrorSampleRate: 0 });
    expect(missed.id).toBeNull();
    await unload(missed.replay);

    window.sessionStorage.setItem(KEY, JSON.stringify({ id: first.id, mode: "session", next: 3, startedAt: Date.now() - 20 * MIN, lastActivity: Date.now() - 16 * MIN }));
    vi.restoreAllMocks();
    random(0.01); // the new draw hits
    const hit = await load({ replaysSessionSampleRate: 0.5 });
    expect(hit.id).not.toBeNull();
    expect(hit.id).not.toBe(first.id);
    await advance(5000);
    expect(replayCalls().at(-1)?.body.segment).toBe(0);
  });
});

describe("idle in one page", () => {
  it("16 minutes with no input and then a click continue under a new id, with a full snapshot first", async () => {
    const { id } = await load({ replaysSessionSampleRate: 1 });
    click();
    await advance(5000);
    await advance(16 * MIN);
    expect(ids()).toEqual([id]);
    click();
    await advance(5000);
    await advance(30_000);
    expect(ids()).toHaveLength(2);
    const fresh = replayCalls().filter((c) => c.body.replay_id !== id);
    expect(fresh[0].body.segment).toBe(0);
    expect(fresh[0].body.events.slice(0, 2).map((e: { type: number }) => e.type)).toEqual([4, 2]);
    expect(JSON.parse(window.sessionStorage.getItem(KEY) as string).id).toBe(fresh[0].body.replay_id);
  });

  it("DOM mutations alone during those 16 minutes do not keep the old id", async () => {
    const { id } = await load({ replaysSessionSampleRate: 1 });
    await advance(5000);
    for (let i = 0; i < 16; i++) {
      const node = document.createElement("p");
      node.textContent = `update ${i}`;
      document.body.appendChild(node);
      await advance(MIN);
    }
    click();
    await advance(5000);
    await advance(30_000);
    expect(ids()).toHaveLength(2);
    expect(ids()[0]).toBe(id);
  });

  it("input within 15 minutes keeps the id", async () => {
    const { id } = await load({ replaysSessionSampleRate: 1 });
    for (let i = 0; i < 4; i++) {
      await advance(10 * MIN);
      click();
    }
    await advance(30_000);
    expect(ids()).toEqual([id]);
  });
});

describe("the maxSessionDuration bound", () => {
  it("an error captured at 61 minutes carries a replay id, and a segment with that id uploads", async () => {
    const { overseer } = await load({ replaysSessionSampleRate: 1 });
    for (let i = 0; i < 6; i++) {
      await advance(10 * MIN); // a visitor who is there, so only the bound splits the replay
      click();
    }
    await advance(MIN);
    const errorId = overseer.captureException(new Error("an hour later"));
    await advance(5000);
    const sent = ingestCalls().flatMap((c) => c.body.events).find((e: Sent) => e.event?.id === errorId);
    const replayId = sent.event.tags.replay_id as string;
    click(); // a segment holds events, and the page did something after the error
    expect(replayId).toMatch(/^[0-9a-f-]{36}$/);
    await advance(30_000);
    const carrying = replayCalls().filter((c) => c.body.replay_id === replayId);
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.some((c) => c.body.error_event_ids.includes(errorId))).toBe(true);
  });

  it("stop() describes the replay that is current", async () => {
    const first = await load({ replaysSessionSampleRate: 1 });
    const { ReplayRecorder } = first.replay;
    const recorder = new ReplayRecorder({ sessionSampleRate: 1, maxSessionDuration: 10 * MIN });
    const startedId = recorder.start();
    await vi.dynamicImportSettled();
    await advance(11 * MIN);
    const now = recorder.getReplayId();
    expect(now).not.toBe(startedId);
    const session = recorder.stop();
    expect(session?.id).toBe(now);
    expect(session?.segments.every((s) => s.sessionId === now)).toBe(true);
  });
});

describe("buffer mode", () => {
  it("keeps the decision across loads, and each load buffers under its own id", async () => {
    const first = await load({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 1 });
    expect(first.id).not.toBeNull();
    await unload(first.replay);
    expect(JSON.parse(window.sessionStorage.getItem(KEY) as string).mode).toBe("buffer");

    random(0.99); // a new draw would miss the buffer too (rate 0.5)
    const second = await load({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0.5 });
    expect(second.id).not.toBeNull();
    expect(second.id).not.toBe(first.id);

    const errorId = second.overseer.captureException(new Error("on the second page"));
    await advance(5000);
    const sent = ingestCalls().flatMap((c) => c.body.events).find((e: Sent) => e.event?.id === errorId);
    expect(sent.event.tags.replay_id).toBe(second.id);
    expect(replayCalls().every((c) => c.body.replay_id === second.id)).toBe(true);
  });
});

describe("storage that fails", () => {
  it("getItem and setItem that throw leave recording working page by page, with no throw into the app", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    const first = await load({ replaysSessionSampleRate: 1 });
    expect(first.id).not.toBeNull();
    click();
    await advance(5000);
    expect(replayCalls().length).toBeGreaterThan(0);
    await unload(first.replay);
    const second = await load({ replaysSessionSampleRate: 1 });
    expect(second.id).not.toBeNull();
    expect(second.id).not.toBe(first.id);
    await advance(5000);
    expect(ids()).toEqual([first.id, second.id]);
  });

  it.each([
    ["not JSON", "{not json"],
    ["a number", "42"],
    ["null", "null"],
    ["a wrong shape", JSON.stringify({ id: 7, mode: "session", next: 0, startedAt: 1, lastActivity: Date.now() })],
    ["an unknown mode", JSON.stringify({ id: "x", mode: "loud", next: 0, startedAt: 1, lastActivity: Date.now() })],
    ["a negative segment", JSON.stringify({ id: "x", mode: "session", next: -1, startedAt: 1, lastActivity: Date.now() })],
  ])("a stored value that is %s starts fresh", async (_name, value) => {
    window.sessionStorage.setItem(KEY, value);
    const { id } = await load({ replaysSessionSampleRate: 1 });
    expect(id).not.toBeNull();
    await advance(5000);
    expect(replayCalls()[0].body.segment).toBe(0);
    expect(replayCalls()[0].body.replay_id).toBe(id);
  });
});

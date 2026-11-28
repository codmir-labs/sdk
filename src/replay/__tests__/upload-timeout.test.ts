// @vitest-environment jsdom
/**
 * An upload request that never answers is given up on after UPLOAD_TIMEOUT_MS: its slot is freed and its segment goes
 * to the retry queue, so two hung requests cannot stall the rest. A page-hide keepalive request has no timeout, and the
 * segments waiting for a slot are bounded in bytes. `fetch` is stubbed, the clock is fake, rrweb is the real recorder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const REPLAY_URL = "https://ingest.example.test/api/overseer/replay";

type Call = { segment: number; replayId: string; at: number; keepalive: boolean; signal: AbortSignal | undefined };
let calls: Call[];
/** What the stub does with the nth request (0-based): `true` never answers, even to an abort. */
let hangs: (n: number) => boolean;

const ok = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
const sequence = () => calls.map((c) => c.segment);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const started: Array<{ stop: () => unknown }> = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  calls = [];
  hangs = () => false;
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      // the recorder's own session segment, cut at 30 s, is none of what these tests hand it: theirs are numbered from 100
      if (body.segment < 100 && body.replay_id !== "a" && body.replay_id !== "b") return ok();
      const n = calls.length;
      calls.push({ segment: body.segment, replayId: body.replay_id, at: Date.now(), keepalive: init.keepalive === true, signal: init.signal ?? undefined });
      if (hangs(n)) return new Promise<Response>(() => {});
      return ok();
    }),
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "<p>a page</p>";
  vi.clearAllTimers();
});

afterEach(() => {
  for (const recorder of started.splice(0)) recorder.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Internals = {
  upload(counter: { next: number }, replayId: string, sequenceNumber: number, events: unknown[], errorIds: string[], hiding: boolean, epoch: number): void;
  waiting: Array<{ replayId: string; sequenceNumber: number }>;
  queue: Array<{ replayId: string; sequenceNumber: number }>;
};
/** Only the segments these tests hand in; the recorder cuts a session segment of its own at 30 s. */
const mine = <T extends { replayId: string; sequenceNumber: number }>(list: T[]) =>
  list.filter((s) => s.sequenceNumber >= 100 || s.replayId === "a" || s.replayId === "b");

async function start() {
  const replay = await import("../index");
  const recorder = new replay.ReplayRecorder({
    sessionSampleRate: 1,
    firstSegmentDelay: 30_000,
    upload: { url: REPLAY_URL, key: "osk_test" },
  });
  started.push(recorder);
  recorder.start();
  await vi.dynamicImportSettled();
  await tick(0);
  const inner = recorder as unknown as Internals;
  const counter = { next: 100 };
  /** Hands the recorder a finished segment, as `emitSegment` does. `filler` bytes of event data make it large. */
  const give = (replayId: string, sequenceNumber: number, filler = 0) =>
    inner.upload(counter, replayId === "own" ? (recorder as unknown as { replayId: string }).replayId : replayId, sequenceNumber, [{ type: 2, timestamp: 1, data: { filler: "x".repeat(filler) } }], [], false, (recorder as unknown as { epoch: number }).epoch);
  return { replay, inner, give };
}

describe("an upload that never answers", () => {
  it("frees its slot after the timeout, so the next waiting segment is sent", async () => {
    hangs = (n) => n < 2;
    const { give } = await start();
    give("own", 100);
    give("own", 101);
    give("own", 102);
    await tick(0);
    expect(sequence()).toEqual([100, 101]); // two in flight, the third waits
    await tick(29_000);
    expect(sequence()).toEqual([100, 101]);
    await tick(1000); // the two requests time out
    await tick(10_000);
    expect(sequence()).toContain(102); // the third segment is sent
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].signal?.aborted).toBe(true);
  });

  it("is retried later through the retry queue, in sequence order", async () => {
    hangs = (n) => n < 2;
    const { give, inner } = await start();
    give("own", 100);
    give("own", 101);
    give("own", 102);
    await tick(30_000);
    // the timed-out segments are queued in order, and the one that waited joins them, as on arrival
    expect(mine(inner.queue).map((q) => q.sequenceNumber)).toEqual([100, 101, 102]);
    await tick(60_000);
    expect(sequence()).toEqual([100, 101, 100, 101, 102]);
    expect(mine(inner.queue)).toHaveLength(0);
    expect(mine(inner.waiting)).toHaveLength(0);
  });

  it("is not retried at once: a hung server does not hold the slot a second 30 s", async () => {
    hangs = (n) => n === 0;
    const { give } = await start();
    give("own", 100);
    await tick(30_000);
    expect(calls).toHaveLength(1);
    await tick(2000);
    expect(calls).toHaveLength(1); // the queue's own backoff (5 s) paces the next attempt
  });

  it("leaves no timer behind once the request answers", async () => {
    const { give } = await start();
    const before = vi.getTimerCount();
    give("own", 100);
    await tick(0);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
  });
});

describe("a keepalive request at page hide", () => {
  it("is never aborted", async () => {
    hangs = () => true;
    const { postSegment, buildSegmentBody } = await import("../upload");
    let settled = false;
    const body = buildSegmentBody({}, { replayId: "r", sequenceNumber: 100, events: [{ type: 2, timestamp: 1 }], errorIds: [] });
    void postSegment({ url: REPLAY_URL, key: "osk_test" }, body, true).then(() => (settled = true));
    await tick(10 * 60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].keepalive).toBe(true);
    expect(calls[0].signal).toBeUndefined();
    expect(settled).toBe(false);
  });
});

describe("the segments waiting for a slot", () => {
  it("are bounded in bytes: the oldest of a replay go, with everything of it behind, and the rest are sent", async () => {
    hangs = (n) => n < 2;
    const { give, inner } = await start();
    give("a", 0);
    give("a", 1); // both slots are taken
    give("a", 2, 2_000_000);
    give("a", 3, 2_000_000);
    give("b", 0, 100);
    expect(mine(inner.waiting).map((w) => `${w.replayId}${w.sequenceNumber}`)).toEqual(["a2", "a3", "b0"]);
    give("a", 4, 2_000_000); // 6 MB are waiting: over the 5 MiB bound
    expect(mine(inner.waiting).map((w) => `${w.replayId}${w.sequenceNumber}`)).toEqual(["b0"]);
    await tick(60_000);
    const sent = calls.map((c) => `${c.replayId}${c.segment}`);
    expect(sent).toContain("b0");
    for (const dropped of ["a2", "a3", "a4"]) expect(sent).not.toContain(dropped);
  });

  it("drop the replay of the oldest, not the newest: a large segment of another replay is kept and sent", async () => {
    hangs = (n) => n < 2;
    const { give, inner } = await start();
    const lose = vi.spyOn(inner as unknown as { lose(replayId: string, epoch: number): void }, "lose");
    give("c", 100);
    give("c", 101); // both slots are taken
    give("a", 0, 2_000_000);
    give("a", 1, 2_000_000);
    expect(mine(inner.waiting).map((w) => `${w.replayId}${w.sequenceNumber}`)).toEqual(["a0", "a1"]);
    give("b", 0, 2_000_000); // 6 MB are waiting: over the 5 MiB bound, and the newest is of another replay than the oldest
    expect(lose.mock.calls.map((c) => c[0])).toEqual(["a"]);
    expect(mine(inner.waiting).map((w) => `${w.replayId}${w.sequenceNumber}`)).toEqual(["b0"]);
    await tick(60_000);
    const sent = calls.map((c) => `${c.replayId}${c.segment}`);
    expect(sent).toContain("b0");
    for (const dropped of ["a0", "a1"]) expect(sent).not.toContain(dropped);
  });

  it("keep what fits", async () => {
    hangs = (n) => n < 2;
    const { give, inner } = await start();
    give("a", 0);
    give("a", 1);
    give("a", 2, 2_000_000);
    give("a", 3, 2_000_000);
    expect(mine(inner.waiting)).toHaveLength(2);
  });
});

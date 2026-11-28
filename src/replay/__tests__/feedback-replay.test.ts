// @vitest-environment jsdom
/**
 * Feedback names a replay only when one uploads. In on-error mode the feedback uploads the buffer under its replay id
 * and keeps recording for `postErrorDuration`, as an error does; in session mode it names the session's replay and sends
 * nothing extra. `flushReplay()` uploads what the recorder holds now. `fetch` is stubbed, the clock is fake, rrweb is the
 * real recorder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;

type Call = { url: string; init: RequestInit; body: any };
let calls: Call[];
/** The pay-as-you-go refusal: the server stores nothing and asks for no more. */
let refuse: boolean;

const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const feedbackBodies = () => calls.filter((c) => c.url.endsWith("/feedback")).map((c) => c.body);

beforeEach(() => {
  calls = [];
  refuse = false;
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/feedback")) return new Response(JSON.stringify({ id: "fb_1", reporterToken: "rt_1" }), { status: 201 });
      return new Response(JSON.stringify(refuse ? { stored: false, reason: "payment_required" } : { stored: true }), { status: 202 });
    }),
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(async () => {
  const replay = await import("../index");
  replay.stopReplay();
  const overseer = await import("../../overseer/index");
  overseer.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function load(config: Record<string, unknown> = {}) {
  const overseer = await import("../../overseer/index");
  const replay = await import("../index");
  const feedback = await import("../../feedback/index");
  overseer.init({ dsn: DSN, clientKey: "osk_test", environment: "production", release: "1.2.3", ...config });
  return { overseer, replay, feedback };
}

const useFakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });

const settle = async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
};

const click = () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

/** A recorder started on a page that has been up and clicked a little. */
async function recording(config: Record<string, unknown>) {
  useFakeClock();
  const loaded = await load(config);
  const id = loaded.replay.startReplay();
  await settle();
  click();
  await vi.advanceTimersByTimeAsync(1000);
  return { ...loaded, id };
}

/** A `fetch` whose replay uploads stay open until the test answers them; other URLs are answered at once. */
function holdUploads() {
  const open: Array<(response: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      if (url !== REPLAY_URL) return Promise.resolve(new Response("{}", { status: 201 }));
      return new Promise<Response>((resolve) => open.push(resolve));
    }),
  );
  const answer = (response: Response) => open.shift()?.(response);
  return { open, answer, stored: () => answer(new Response(JSON.stringify({ stored: true }), { status: 202 })) };
}

/** Whether a promise has settled, after the pending timers and microtasks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

// ---------------------------------------------------------------------------------------------------------------------
describe("feedback in on-error mode", () => {
  it("uploads the buffer under the id it names, with no error id, and records on for postErrorDuration", async () => {
    const { feedback, replay, id } = await recording({ replaysOnErrorSampleRate: 1 });
    expect(id).toBeTruthy();
    expect(replayCalls()).toHaveLength(0); // a buffer nobody asked for uploads nothing

    const result = await feedback.sendFeedback({ text: "the button does nothing" });
    expect(result).toMatchObject({ ok: true });
    expect(feedbackBodies()[0].replayId).toBe(id);

    const uploads = replayCalls().map((c) => c.body);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ replay_id: id, segment: 0, error_event_ids: [] });
    expect(uploads[0].events.length).toBeGreaterThan(0);

    // the window: still the same replay, and what happens in it is uploaded under it
    click();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(replayCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // the window ends: what followed is uploaded, then a new buffer
    const after = replayCalls().map((c) => c.body);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ replay_id: id, segment: 1, error_event_ids: [] });

    // back to buffering under a new id: what a flush now uploads is that replay's first segment
    await replay.flushReplay();
    const last = replayCalls().at(-1)!.body;
    expect(replayCalls()).toHaveLength(3);
    expect(last.replay_id).not.toBe(id);
    expect(last.segment).toBe(0);
  });

  it("a second feedback in the window names the same replay and uploads nothing more", async () => {
    const { feedback, id } = await recording({ replaysOnErrorSampleRate: 1 });
    await feedback.sendFeedback({ text: "one" });
    await feedback.sendFeedback({ text: "two" });
    expect(feedbackBodies().map((b) => b.replayId)).toEqual([id, id]);
    expect(replayCalls()).toHaveLength(1);
  });

  it("names no replay when the buffer is empty because rrweb has not loaded", async () => {
    useFakeClock();
    const { feedback, replay } = await load({ replaysOnErrorSampleRate: 1 });
    expect(replay.startReplay()).toBeTruthy();
    await feedback.sendFeedback({ text: "too early" }); // before the recorder's import has settled
    expect(feedbackBodies()[0]).not.toHaveProperty("replayId");
    expect(replayCalls()).toHaveLength(0);
  });

  it("names no replay when the server refused uploads", async () => {
    const { feedback, replay } = await recording({ replaysOnErrorSampleRate: 1 });
    refuse = true;
    await replay.flushReplay();
    await vi.advanceTimersByTimeAsync(0);
    await feedback.sendFeedback({ text: "after refusal" });
    expect(feedbackBodies().at(-1)).not.toHaveProperty("replayId");
  });

  it("names no replay when only the refusal stops it: the buffer holds events and the replay still records", async () => {
    useFakeClock();
    const { answer, open } = holdUploads();
    const recorder = (await import("../index")).createReplayRecorder({
      errorSampleRate: 1,
      sessionSampleRate: 0,
      postErrorDuration: 2000,
      upload: { url: REPLAY_URL, key: "osk_test" },
    });
    recorder.start();
    await settle();
    click();
    await vi.advanceTimersByTimeAsync(1000);
    recorder.markError("err_1"); // the buffer goes up and its request stays open
    expect(open).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000); // the window ends: a new buffer, while that request is still out
    click();
    await vi.advanceTimersByTimeAsync(1000);
    const uploadsBefore = replayCalls().length;

    answer(new Response(JSON.stringify({ stored: false, reason: "payment_required" }), { status: 202 }));
    // The refusal is in once the response is read; the recorder's own stop is a timer, which has not run yet.
    for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve)); // not faked, unlike setTimeout
    expect(recorder.markFeedback()).toBeNull();
    expect(replayCalls()).toHaveLength(uploadsBefore);
  });

  it("names no replay when sending the buffer halts the replay", async () => {
    useFakeClock();
    document.body.textContent = "x".repeat(2_500_000); // a full snapshot too big for one request
    const { feedback, replay } = await load({ replaysOnErrorSampleRate: 1 });
    replay.startReplay();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await feedback.sendFeedback({ text: "a page too big to replay" });
    expect(feedbackBodies()[0]).not.toHaveProperty("replayId");
    expect(replayCalls()).toHaveLength(0);
  });
});

describe("feedback in session mode", () => {
  it("names the session's replay and uploads nothing extra", async () => {
    const { feedback, id } = await recording({ replaysSessionSampleRate: 1 });
    const before = replayCalls().length;
    await feedback.sendFeedback({ text: "mine" });
    expect(feedbackBodies()[0].replayId).toBe(id);
    expect(replayCalls()).toHaveLength(before);
  });
});

describe("feedback with replayId: false", () => {
  it("attaches no replay and uploads nothing, in either mode", async () => {
    const buffer = await recording({ replaysOnErrorSampleRate: 1 });
    await buffer.feedback.sendFeedback({ text: "no replay", replayId: false });
    expect(feedbackBodies()[0]).not.toHaveProperty("replayId");
    expect(replayCalls()).toHaveLength(0);
    // and the buffer is still a buffer: a later feedback names it
    await buffer.feedback.sendFeedback({ text: "now with" });
    expect(feedbackBodies()[1].replayId).toBe(buffer.id);
    expect(replayCalls()).toHaveLength(1);
  });

  it("session mode: no replay id and no upload", async () => {
    const { feedback } = await recording({ replaysSessionSampleRate: 1 });
    const before = replayCalls().length;
    await feedback.sendFeedback({ text: "no replay", replayId: false });
    expect(feedbackBodies()[0]).not.toHaveProperty("replayId");
    expect(replayCalls()).toHaveLength(before);
  });
});

describe("feedback with no replay that uploads", () => {
  it("no replay started: no replayId", async () => {
    useFakeClock();
    const { feedback } = await load({ replaysOnErrorSampleRate: 1 });
    await feedback.sendFeedback({ text: "no recorder" });
    expect(feedbackBodies()[0]).not.toHaveProperty("replayId");
  });

  it("a visit unsampled for both modes: no replayId", async () => {
    useFakeClock();
    const { feedback, replay } = await load({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 });
    expect(replay.startReplay()).toBeNull();
    await feedback.sendFeedback({ text: "unsampled" });
    expect(feedbackBodies()[0]).not.toHaveProperty("replayId");
    expect(replayCalls()).toHaveLength(0);
  });

  it("a stopped replay: no replayId, in on-error and session mode", async () => {
    for (const config of [{ replaysOnErrorSampleRate: 1 }, { replaysSessionSampleRate: 1 }]) {
      calls = [];
      window.sessionStorage.clear();
      const { feedback, replay } = await recording(config);
      replay.stopReplay();
      const before = replayCalls().length;
      await feedback.sendFeedback({ text: "after stop" });
      expect(feedbackBodies()[0]).not.toHaveProperty("replayId");
      expect(replayCalls()).toHaveLength(before);
      (await import("../../overseer/index")).close();
      vi.resetModules();
    }
  });

  it("a recorder that stopped under a hook that is still set: no replayId", async () => {
    const recorder = (await import("../index")).createReplayRecorder({
      errorSampleRate: 1,
      sessionSampleRate: 0,
      upload: { url: REPLAY_URL, key: "osk_test" },
    });
    expect(recorder.markFeedback()).toBeNull(); // never started
    useFakeClock();
    recorder.start();
    await settle();
    recorder.stop();
    expect(recorder.markFeedback()).toBeNull();
  });
});

describe("flushReplay()", () => {
  it("in on-error mode uploads the buffer now, as an error would, and resolves when it is done", async () => {
    const { replay, id } = await recording({ replaysOnErrorSampleRate: 1 });
    expect(replayCalls()).toHaveLength(0);
    await replay.flushReplay();
    const uploads = replayCalls().map((c) => c.body);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ replay_id: id, segment: 0, error_event_ids: [] });
  });

  it("in session mode uploads the pending segment", async () => {
    const { replay, id } = await recording({ replaysSessionSampleRate: 1 });
    expect(replayCalls()).toHaveLength(0); // the first segment is cut at 5 s
    await replay.flushReplay();
    const uploads = replayCalls().map((c) => c.body);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ replay_id: id, segment: 0 });
    expect(uploads[0].events.length).toBeGreaterThan(0);
  });

  it("waits for the request it sent", async () => {
    const { replay } = await recording({ replaysOnErrorSampleRate: 1 });
    const uploads = holdUploads();
    const flushed = replay.flushReplay();
    expect(uploads.open).toHaveLength(1);
    expect(await settled(flushed)).toBe(false);
    uploads.stored();
    await expect(flushed).resolves.toBeUndefined();
  });

  it("waits for a segment that waits for a free upload slot", async () => {
    const { replay } = await recording({ replaysSessionSampleRate: 1 });
    const uploads = holdUploads();
    await vi.advanceTimersByTimeAsync(5000); // a segment is cut: one request out
    click();
    await vi.advanceTimersByTimeAsync(5000); // the next: two out, the limit
    click();
    const flushed = replay.flushReplay(); // the pending segment has no slot
    expect(uploads.open).toHaveLength(2);
    expect(await settled(flushed)).toBe(false);
    uploads.stored();
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled(flushed)).toBe(false); // the waiting segment's request is out now, and unanswered
    uploads.stored();
    uploads.stored();
    await expect(flushed).resolves.toBeUndefined();
  });

  it("with no replay resolves at once", async () => {
    useFakeClock();
    const { replay } = await load({ replaysOnErrorSampleRate: 1 });
    await expect(replay.flushReplay()).resolves.toBeUndefined();
    expect(replayCalls()).toHaveLength(0);
  });
});

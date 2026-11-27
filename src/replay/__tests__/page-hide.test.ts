// @vitest-environment jsdom
/**
 * A short visit keeps its replay, and a page hide sends what the SDK holds inside one keepalive budget shared with the
 * error transport: the first segment goes `firstSegmentDelay` after the start, the error queue gets its bytes before the
 * replay does, the replay's retry queue goes first and in order, and a hide send that fails waits instead of being
 * lost. `fetch` is stubbed, the clock is fake, rrweb is the real recorder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;
const INGEST_URL = `${DSN}/ingest`;
const BUDGET = 60_000;

type Call = { url: string; at: number; keepalive: boolean; bytes: number; body: any };
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;
let t0: number;

const ok = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
const status = (code: number, headers: Record<string, string> = {}) => () => new Response("{}", { status: code, headers });
const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const errorCalls = () => calls.filter((c) => c.url === INGEST_URL);
const segments = () => replayCalls().map((c) => c.body.segment);
const bytesOf = (text: string) => new TextEncoder().encode(text).length;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  calls = [];
  respond = ok;
  vi.resetModules();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("codmir.keepalive.budget")];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = String(init.body);
      const call = { url, at: Date.now() - t0, keepalive: (init as { keepalive?: boolean }).keepalive === true, bytes: bytesOf(raw), body: JSON.parse(raw) };
      calls.push(call);
      return respond(call);
    }),
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "<p>a page</p>";
  vi.clearAllTimers();
});

const started: Array<{ stop(): unknown }> = [];
afterEach(() => {
  for (const one of started.splice(0)) one.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

async function startRecorder(config: Record<string, unknown> = {}) {
  const replay = await import("../index");
  const recorder = new replay.ReplayRecorder({ sessionSampleRate: 1, upload: { url: REPLAY_URL, key: "osk_test" }, ...config });
  started.push(recorder);
  t0 = Date.now();
  recorder.start();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
  const { record } = await import("@rrweb/record");
  const snapshot = vi.spyOn(record, "takeFullSnapshot");
  return { replay, recorder, snapshot };
}

async function startClient() {
  const overseer = await import("../../overseer/index");
  const client = new overseer.OverseerClient({ dsn: DSN, clientKey: "osk_test", environment: "production", release: "1.2.3", rateLimit: false });
  client.init();
  started.push({ stop: () => client.close() });
  return client;
}

const click = () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const pagehide = async () => {
  window.dispatchEvent(new Event("pagehide"));
  await advance(0);
};
/** About `kb` KB of one custom event: a stand-in for a busy page. */
const bulk = (recorder: { addCustomEvent(name: string, payload: unknown): void }, kb: number, tag = "bulk") =>
  recorder.addCustomEvent(tag, { filler: "x".repeat(kb * 1000) });
/** An error whose request body is about `kb` KB: the message travels three times (message, exception value, group), plus about 2.7 KB of envelope. */
const bigError = (client: { captureException(error: Error): unknown }, kb: number, tag: string) => {
  const error = new Error(`${tag}:${"e".repeat(Math.round((kb * 1000 - 2700) / 3))}`);
  error.stack = `Error: ${tag}\n    at run (/srv/app/src/run.ts:1:1)`;
  client.captureException(error);
  return advance(0); // the event is queued after its (async) processing
};

describe("a short visit keeps its replay", () => {
  it("G: a 10-second visit to a page with 1,500 list items uploads segment 0 at about 5 s, and the rest at pagehide with keepalive", async () => {
    document.body.innerHTML = `<ul>${Array.from({ length: 1500 }, (_, i) => `<li class="item"><a href="/p/${i}">Product ${i}</a> <span>$${i}.99</span></li>`).join("")}</ul>`;
    const { recorder } = await startRecorder();
    click();
    await advance(5000);
    expect(replayCalls()).toHaveLength(1);
    const first = replayCalls()[0];
    expect(first.body.segment).toBe(0);
    expect(first.at).toBeGreaterThanOrEqual(5000);
    expect(first.at).toBeLessThan(6000);
    expect(first.bytes).toBeGreaterThan(BUDGET); // too big for keepalive, and sent by a normal request
    expect(first.keepalive).toBe(false);

    click();
    await advance(5000); // 10 s in
    await pagehide();
    expect(replayCalls().map((c) => c.body.segment)).toEqual([0, 1]);
    const atHide = replayCalls().slice(1);
    expect(atHide.every((c) => c.keepalive)).toBe(true);
    expect(atHide.some((c) => !c.keepalive)).toBe(false);
    recorder.stop();
  });

  it("a visit shorter than firstSegmentDelay is one send at pagehide, with keepalive when it fits", async () => {
    const { recorder } = await startRecorder();
    click();
    await advance(3000);
    expect(replayCalls()).toHaveLength(0);
    await pagehide();
    expect(replayCalls()).toHaveLength(1);
    expect(replayCalls()[0].body.segment).toBe(0);
    expect(replayCalls()[0].keepalive).toBe(true);
    recorder.stop();
  });
});

describe("firstSegmentDelay", () => {
  it("is 5 s by default, then segments follow the 30 s cadence", async () => {
    const { recorder } = await startRecorder();
    click();
    await advance(4900);
    expect(replayCalls()).toHaveLength(0);
    await advance(200);
    expect(segments()).toEqual([0]);
    click();
    await advance(25_000); // 30.1 s in
    expect(segments()).toEqual([0, 1]);
    recorder.stop();
  });

  it("is at least 1 s", async () => {
    const { recorder } = await startRecorder({ firstSegmentDelay: 10 });
    click();
    await advance(900);
    expect(replayCalls()).toHaveLength(0);
    await advance(200);
    expect(segments()).toEqual([0]);
    recorder.stop();
  });

  it("is at most segmentDuration", async () => {
    const { recorder } = await startRecorder({ firstSegmentDelay: 90_000, segmentDuration: 20_000 });
    click();
    await advance(19_000);
    expect(replayCalls()).toHaveLength(0);
    await advance(2000);
    expect(segments()).toEqual([0]);
    recorder.stop();
  });

  it("does not change the on-error buffer, which uploads nothing without an error", async () => {
    const { recorder } = await startRecorder({ sessionSampleRate: 0, errorSampleRate: 1 });
    click();
    await advance(40_000);
    expect(replayCalls()).toHaveLength(0);
    recorder.stop();
  });
});

describe("one keepalive budget for the error transport and the replay", () => {
  for (const order of ["error transport first", "replay first"] as const) {
    it(`an error queue of 50 KB gets keepalive and a replay tail of 30 KB does not (${order})`, async () => {
      let recorder: Awaited<ReturnType<typeof startRecorder>>["recorder"];
      let client: Awaited<ReturnType<typeof startClient>>;
      if (order === "error transport first") {
        client = await startClient();
        ({ recorder } = await startRecorder({ firstSegmentDelay: 30_000 }));
      } else {
        ({ recorder } = await startRecorder({ firstSegmentDelay: 30_000 }));
        client = await startClient();
      }
      await bigError(client, 52, "queued");
      bulk(recorder, 30);
      click();
      await advance(10);
      await pagehide();

      expect(errorCalls()).toHaveLength(1);
      expect(errorCalls()[0].keepalive).toBe(true);
      expect(errorCalls()[0].bytes).toBeGreaterThan(49_000);
      expect(replayCalls()).toHaveLength(1);
      expect(replayCalls()[0].bytes).toBeGreaterThan(30_000);
      expect(replayCalls()[0].keepalive).toBe(false);
      expect(errorCalls()[0].bytes + replayCalls()[0].bytes).toBeGreaterThan(BUDGET);
    });
  }

  it("visibilitychange to hidden shares the budget the same way", async () => {
    const client = await startClient();
    const { recorder } = await startRecorder({ firstSegmentDelay: 30_000 });
    await bigError(client, 52, "queued");
    bulk(recorder, 30);
    click();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(0);
    expect(errorCalls().map((c) => c.keepalive)).toEqual([true]);
    expect(replayCalls().map((c) => c.keepalive)).toEqual([false]);
  });

  it("the budget is released when the requests settle: a later hide has all of it again", async () => {
    const client = await startClient();
    const { recorder } = await startRecorder({ firstSegmentDelay: 30_000 });
    await bigError(client, 52, "first");
    bulk(recorder, 15);
    click();
    await pagehide();
    expect(errorCalls().map((c) => c.keepalive)).toEqual([true]);
    expect(replayCalls().map((c) => c.keepalive)).toEqual([false]);
    await advance(2000); // both requests settled

    calls.length = 0;
    await bigError(client, 52, "second");
    bulk(recorder, 15);
    click();
    await pagehide();
    expect(errorCalls().map((c) => c.keepalive)).toEqual([true]);
    expect(replayCalls().map((c) => c.keepalive)).toEqual([false]);

    // Without the error queue, the replay's tail has the whole budget.
    await advance(2000);
    calls.length = 0;
    bulk(recorder, 40);
    click();
    await pagehide();
    expect(replayCalls().map((c) => c.keepalive)).toEqual([true]);
  });
});

describe("the retry queue goes at pagehide, oldest first, then the new segment", () => {
  /** Three segments of the replay wait in the queue after a 429; the tail is the fourth. */
  async function queueThree(kb: number) {
    const { recorder, snapshot } = await startRecorder({ segmentDuration: 10_000, firstSegmentDelay: 10_000 });
    respond = status(429, { "Retry-After": "60" });
    for (let i = 0; i < 3; i++) {
      bulk(recorder, kb);
      click();
      await advance(10_000);
    }
    expect(segments()).toEqual([0]); // the first got the 429; the others wait behind it
    calls.length = 0;
    respond = ok;
    bulk(recorder, kb);
    click();
    return { recorder, snapshot };
  }

  it("sends all three before the tail, in sequence order, each with keepalive while it fits", async () => {
    const { recorder } = await queueThree(5);
    await pagehide();
    expect(segments()).toEqual([0, 1, 2, 3]);
    expect(replayCalls().map((c) => c.keepalive)).toEqual([true, true, true, true]);
    await advance(120_000);
    expect(segments()).toEqual([0, 1, 2, 3]); // all stored: nothing is sent again
    recorder.stop();
  });

  it("with a budget that fits only two, the third and the tail go without keepalive", async () => {
    const { recorder } = await queueThree(20);
    await pagehide();
    expect(segments()).toEqual([0, 1, 2, 3]);
    const sent = replayCalls();
    expect(sent[0].bytes + sent[1].bytes).toBeLessThanOrEqual(BUDGET);
    expect(sent[0].bytes + sent[1].bytes + sent[2].bytes).toBeGreaterThan(BUDGET);
    expect(sent.map((c) => c.keepalive)).toEqual([true, true, false, false]);
    recorder.stop();
  });

  it("a request still in flight from a hide is not sent again by the next hide event", async () => {
    const { recorder } = await queueThree(5);
    respond = () => new Promise<Response>(() => {}); // never answers
    await pagehide();
    expect(segments()).toEqual([0, 1, 2, 3]);
    await pagehide();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(0);
    expect(segments()).toEqual([0, 1, 2, 3]);
    recorder.stop();
  });
});

describe("nothing is lost for being sent at pagehide", () => {
  it("a hide send answered 503, for a page that comes back: the queue sends it after its backoff, and no recovery snapshot is taken", async () => {
    const { recorder, snapshot } = await startRecorder({ firstSegmentDelay: 30_000 });
    respond = status(503);
    click();
    await pagehide();
    expect(replayCalls()).toHaveLength(1);
    expect(replayCalls()[0].keepalive).toBe(true);
    respond = ok;
    await advance(4000);
    expect(replayCalls()).toHaveLength(1); // still backing off
    await advance(2000);
    expect(segments()).toEqual([0, 0]);
    expect(replayCalls()[1].body.events[0].type).toBe(4); // the same segment, with its Meta event and full snapshot
    expect(snapshot).not.toHaveBeenCalled();
    click();
    await advance(30_000);
    expect(segments()).toEqual([0, 0, 1]);
    expect(snapshot).not.toHaveBeenCalled();
    recorder.stop();
  });

  it("a network error at hide waits in the queue too", async () => {
    const { recorder, snapshot } = await startRecorder({ firstSegmentDelay: 30_000 });
    respond = () => {
      throw new TypeError("Failed to fetch");
    };
    click();
    await pagehide();
    respond = ok;
    await advance(6000);
    expect(segments()).toEqual([0, 0]);
    expect(snapshot).not.toHaveBeenCalled();
    recorder.stop();
  });

  it("a 429 at hide keeps the server's Retry-After", async () => {
    const { recorder, snapshot } = await startRecorder({ firstSegmentDelay: 30_000 });
    respond = status(429, { "Retry-After": "60" });
    click();
    await pagehide();
    respond = ok;
    await advance(50_000);
    expect(segments()).toEqual([0]);
    await advance(11_000);
    expect(segments()).toEqual([0, 0]);
    expect(snapshot).not.toHaveBeenCalled();
    recorder.stop();
  });

  it("a queued entry sent at hide that fails stays queued, and counts as one attempt", async () => {
    const { recorder } = await startRecorder({ segmentDuration: 10_000, firstSegmentDelay: 10_000 });
    respond = status(503);
    bulk(recorder, 1);
    click();
    await advance(12_000); // tried, retried after 1 s, then queued with a backoff
    const before = replayCalls().length;
    expect(before).toBe(2);
    respond = status(503);
    await pagehide(); // the entry is sent again, at hide
    expect(replayCalls().length).toBe(before + 1);
    respond = ok;
    await advance(300_000);
    expect(segments().filter((s) => s === 0).length).toBe(before + 2); // stored by the queue after the hide attempt
    recorder.stop();
  });

  it("an answer refused for good is still dropped", async () => {
    const { recorder } = await startRecorder({ firstSegmentDelay: 30_000 });
    respond = status(400);
    click();
    await pagehide();
    respond = ok;
    await advance(300_000);
    expect(segments().filter((s) => s === 0)).toHaveLength(1); // never sent again
    recorder.stop();
  });
});

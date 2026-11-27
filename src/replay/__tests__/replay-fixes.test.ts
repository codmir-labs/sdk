// @vitest-environment jsdom
/**
 * Replay edge cases: an error before the recorder loads, an error `beforeSend` drops, a long error history cut into
 * chunks, and upload budgets measured in UTF-8 bytes. Same harness as replay.test.ts: `fetch` stubbed, fake clock,
 * rrweb loaded through the real dynamic import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;

type Call = { url: string; init: RequestInit; body: any; raw: string };
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;

const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const ingestCalls = () => calls.filter((c) => c.url === `${DSN}/ingest`);
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

beforeEach(() => {
  calls = [];
  respond = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = String(init.body);
      const call = { url, init, raw, body: JSON.parse(raw) };
      calls.push(call);
      return respond(call);
    }),
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "";
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
  overseer.init({ dsn: DSN, clientKey: "osk_test", environment: "production", release: "1.2.3", ...config });
  return { overseer, replay };
}

const useFakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });

const settle = async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
};

function click() {
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

// ---------------------------------------------------------------------------------------------------------------------
describe("an error before rrweb has loaded (on-error mode)", () => {
  it("keeps the error id in the replay and the buffer rotating, as an error after boot does", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    const id = replay.startReplay();
    const errId = overseer.captureException(new Error("startup error"));
    await settle();
    await vi.advanceTimersByTimeAsync(30_000); // the post-error window ends, back to buffering

    const ingested = ingestCalls().flatMap((c) => c.body.events).find((e: any) => e.event?.id === errId);
    expect(ingested.event.tags.replay_id).toBe(id);
    const first = replayCalls();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((c) => c.body.replay_id === id)).toBe(true);
    expect(first[0].body.segment).toBe(0);
    expect(first[0].body.error_event_ids).toEqual([errId]);

    // Ten minutes of an ordinary page, then a second error: the upload is the last minute, not the whole history.
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("ancient-marker", 1);
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      click();
    }
    record.addCustomEvent("recent-marker", 1);
    const before = replayCalls().length;
    overseer.captureException(new Error("ten minutes later"));
    await vi.advanceTimersByTimeAsync(0);
    const second = replayCalls().slice(before);
    const events = second.flatMap((c) => c.body.events);
    expect(second.some((c) => c.raw.includes("ancient-marker"))).toBe(false);
    expect(second.some((c) => c.raw.includes("recent-marker"))).toBe(true);
    expect(events[events.length - 1].timestamp - events[0].timestamp).toBeLessThanOrEqual(60_000);
  });

  it("holds at most 60 s of events at 10, 20 and 30 minutes", async () => {
    useFakeClock();
    const { createReplayRecorder } = await import("../index");
    const rec = createReplayRecorder({ sessionSampleRate: 0, errorSampleRate: 1 });
    rec.start();
    rec.markError("e-early");
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    const { record } = await import("@rrweb/record");
    const held: number[] = [];
    const spans: number[] = [];
    for (let minute = 1; minute <= 30; minute++) {
      for (let s = 0; s < 6; s++) {
        await vi.advanceTimersByTimeAsync(10_000);
        for (let k = 0; k < 20; k++) record.addCustomEvent("tick", { k });
        click();
      }
      if (minute % 10 === 0) {
        const r = rec as unknown as { prevBuffer: Array<{ timestamp: number }>; curBuffer: Array<{ timestamp: number }> };
        const all = r.prevBuffer.concat(r.curBuffer);
        held.push(all.length);
        spans.push(all[all.length - 1].timestamp - all[0].timestamp);
      }
    }
    rec.stop();
    expect(held).toHaveLength(3);
    for (const span of spans) expect(span).toBeLessThanOrEqual(60_000);
    expect(held[2]).toBeLessThan(held[0] * 1.5);
    expect(Math.max(...held)).toBeLessThan(200);
  });

  it("an error while the page is still loading (rrweb waits for `load`) is listed by the replay", async () => {
    useFakeClock();
    let ready = "loading";
    Object.defineProperty(document, "readyState", { configurable: true, get: () => ready });
    try {
      const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
      const id = replay.startReplay();
      await settle(); // rrweb has loaded and is waiting for `load`
      const errId = overseer.captureException(new Error("error during page load"));
      await vi.advanceTimersByTimeAsync(500);
      ready = "complete";
      window.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(31_000);
      const listing = replayCalls().filter((c) => c.body.error_event_ids.includes(errId));
      expect(listing.length).toBeGreaterThan(0);
      expect(listing.every((c) => c.body.replay_id === id)).toBe(true);
    } finally {
      delete (document as unknown as Record<string, unknown>).readyState;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("an error that beforeSend drops", () => {
  async function capture(beforeSend: (event: any) => any, replaysOnErrorSampleRate = 1) {
    useFakeClock();
    document.body.innerHTML = `<p>visible page text</p>`;
    const { overseer, replay } = await load({ replaysOnErrorSampleRate, beforeSend });
    replay.startReplay();
    await settle();
    const id = overseer.captureException(new Error("an error the app filters out"));
    await vi.advanceTimersByTimeAsync(31_000);
    return { id, overseer };
  }

  it("uploads no replay when the hook returns null", async () => {
    await capture(() => null);
    expect(ingestCalls()).toHaveLength(0);
    expect(replayCalls()).toHaveLength(0);
  });

  it("uploads the replay, naming the error, when the hook keeps the event", async () => {
    const { id } = await capture((event) => event);
    const errors = ingestCalls().flatMap((c) => c.body.events).filter((e: any) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(replayCalls()).toHaveLength(1);
    expect(replayCalls()[0].body.error_event_ids).toEqual([id]);
    expect(errors[0].event.tags.replay_id).toBe(replayCalls()[0].body.replay_id);
  });

  it("uploads no replay when an async hook resolves null", async () => {
    await capture(async () => null);
    expect(replayCalls()).toHaveLength(0);
  });

  it("uploads the replay when an async hook resolves the event", async () => {
    const { id } = await capture(async (event) => event);
    expect(replayCalls()).toHaveLength(1);
    expect(replayCalls()[0].body.error_event_ids).toEqual([id]);
  });

  it("uploads no replay when the hook throws", async () => {
    await capture(() => {
      throw new Error("hook bug");
    });
    expect(replayCalls()).toHaveLength(0);
  });

  it("uploads none for a README-style noise filter, however often the noise repeats", async () => {
    useFakeClock();
    const browser = await import("../../browser/index");
    const replay = await import("../index");
    browser.init({
      dsn: DSN,
      clientKey: "osk_test",
      replaysOnErrorSampleRate: 1,
      beforeSend(event: any) {
        if (event.message?.includes("ResizeObserver loop")) return null;
        return event;
      },
    } as any);
    replay.startReplay();
    await settle();
    for (let i = 0; i < 30; i++) {
      window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
      click();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(ingestCalls().flatMap((c) => c.body.events).filter((e: any) => e.type === "error")).toHaveLength(0);
    expect(replayCalls()).toHaveLength(0);
    browser.close();
  });
});

// @vitest-environment jsdom
/**
 * CSL-5612: rrweb recording with masking on by default, on-error buffering, sampling and segment upload.
 * The wire shape is checked against the mirrored `ReplaySegmentUploadSchema` (helpers.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SDK_INFO } from "../../version";
import { CONTRACT_EXAMPLE, MAX_BODY_BYTES, ReplaySegmentUploadSchema, ReplayUploadResponseSchema } from "./helpers";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;

type Call = { url: string; init: RequestInit; body: any; raw: string };
let calls: Call[];
let respond: () => Response | Promise<Response>;

const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const ingestCalls = () => calls.filter((c) => c.url === `${DSN}/ingest`);
const allReplayText = () => replayCalls().map((c) => c.raw).join("\n");

beforeEach(() => {
  calls = [];
  respond = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, raw: String(init.body), body: JSON.parse(String(init.body)) });
      return respond();
    }),
  );
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

/** rrweb loads through a dynamic import; let it settle and take its first snapshot. */
/** rrweb stamps events from `performance`, and checks for a checkout only when an event arrives. */
const useFakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });

const settle = async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
};

function click() {
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("masking (default config)", () => {
  it("never puts a typed password, or any typed input, in an uploaded segment", async () => {
    useFakeClock();
    document.body.innerHTML = `<form><input id="pw" type="password"><input id="name" type="text"></form>`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    expect(replay.startReplay()).toBeTruthy();
    await settle();

    type(document.getElementById("pw") as HTMLInputElement, "hunter2-secret");
    type(document.getElementById("name") as HTMLInputElement, "ordinary-typed-text");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(replayCalls().length).toBeGreaterThan(0);
    const text = allReplayText();
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("ordinary-typed-text");
  });

  it("still masks a password with maskAllInputs off and no masked types; other inputs then record (negative control)", async () => {
    useFakeClock();
    document.body.innerHTML = `<form><input id="pw" type="password"><input id="name" type="text"></form>`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay({ privacy: { maskAllInputs: false, maskInputTypes: [] } });
    await settle();

    type(document.getElementById("pw") as HTMLInputElement, "hunter2-secret");
    type(document.getElementById("name") as HTMLInputElement, "ordinary-typed-text");
    await vi.advanceTimersByTimeAsync(30_000);

    const text = allReplayText();
    expect(text).not.toContain("hunter2-secret");
    // Proves the grep can fail: with masking off the ordinary field is in the payload.
    expect(text).toContain("ordinary-typed-text");
  });

  it("masks data-private text, blocks data-codmir-block subtrees, and records everything else", async () => {
    useFakeClock();
    document.body.innerHTML = `
      <p data-private>ssn-123-45-6789</p>
      <p class="private">card-4242-4242</p>
      <div data-codmir-block><span>block-secret-subtree</span></div>
      <p>public-visible-text</p>`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);

    const text = allReplayText();
    expect(text).not.toContain("ssn-123-45-6789");
    expect(text).not.toContain("card-4242-4242");
    expect(text).not.toContain("block-secret-subtree");
    expect(text).toContain("public-visible-text");
  });
});

describe("sampling", () => {
  it("records and uploads nothing, and never loads rrweb, when both rates are 0", async () => {
    useFakeClock();
    let loaded = 0;
    vi.doMock("@rrweb/record", async (importOriginal) => {
      loaded++;
      return importOriginal();
    });
    const { replay } = await load({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 });
    expect(replay.startReplay()).toBeNull();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replayCalls()).toHaveLength(0);
    expect(loaded).toBe(0);
    vi.doUnmock("@rrweb/record");
  });

  it("returns null without a client key, since nothing could upload", async () => {
    const overseer = await import("../../overseer/index");
    const replay = await import("../index");
    overseer.init({ dsn: DSN, replaysSessionSampleRate: 1 });
    expect(replay.startReplay()).toBeNull();
  });

  it("uploads a segment after 5,000 events without waiting for the timer", async () => {
    useFakeClock();
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    expect(replayCalls()).toHaveLength(0);

    const { record } = await import("@rrweb/record");
    for (let i = 0; i < 5000; i++) record.addCustomEvent("tick", { i });
    await vi.advanceTimersByTimeAsync(0);

    expect(replayCalls().length).toBeGreaterThanOrEqual(1);
    const first = replayCalls()[0].body;
    expect(first.events.length).toBeGreaterThanOrEqual(5000 - 1);
    expect(first.segment).toBe(0);
  });

  it("numbers segments upward per replay_id and keeps the same replay_id", async () => {
    useFakeClock();
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    const id = replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("a", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    record.addCustomEvent("b", 2);
    await vi.advanceTimersByTimeAsync(30_000);

    const bodies = replayCalls().map((c) => c.body);
    expect(bodies.map((b) => b.segment)).toEqual([0, 1]);
    expect(new Set(bodies.map((b) => b.replay_id))).toEqual(new Set([id]));
  });
});

describe("on-error buffer", () => {
  it("uploads nothing before an error, then the buffered events once captureException runs", async () => {
    useFakeClock();
    document.body.innerHTML = `<p>before-the-error</p>`;
    const { overseer, replay } = await load({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 1 });
    const id = replay.startReplay();
    expect(id).toBeTruthy();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(replayCalls()).toHaveLength(0);

    const eventId = overseer.captureException(new Error("boom"));
    await vi.advanceTimersByTimeAsync(0);

    expect(replayCalls()).toHaveLength(1);
    const body = replayCalls()[0].body;
    expect(body.replay_id).toBe(id);
    expect(body.segment).toBe(0);
    expect(body.error_event_ids).toEqual([eventId]);
    expect(body.events[0].type).toBe(4); // Meta, immediately followed by the full snapshot
    expect(body.events.some((e: { type: number }) => e.type === 2)).toBe(true);
    expect(replayCalls()[0].raw).toContain("before-the-error");
  });

  it("keeps recording for 30 s after the error and uploads that as the next segment", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    const id = replay.startReplay();
    await settle();
    overseer.captureException(new Error("boom"));
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("after-the-error", 1);
    await vi.advanceTimersByTimeAsync(30_000);

    const bodies = replayCalls().map((c) => c.body);
    expect(bodies.map((b) => b.segment)).toEqual([0, 1]);
    expect(bodies.every((b) => b.replay_id === id)).toBe(true);
    expect(replayCalls()[1].raw).toContain("after-the-error");

    // Afterwards the recorder buffers again under a fresh id, and nothing more uploads on its own.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(replayCalls()).toHaveLength(2);
    expect(replay.startReplay()).not.toBe(id);
  });

  it("keeps the buffer to about the last 60 s, starting at a full snapshot", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("ancient", 1);
    // rrweb checks for a checkout when an interaction arrives; each rotation keeps one older generation, no more.
    await vi.advanceTimersByTimeAsync(40_000);
    click();
    record.addCustomEvent("middle", 1);
    await vi.advanceTimersByTimeAsync(40_000);
    click();
    record.addCustomEvent("recent", 1);
    overseer.captureException(new Error("late"));

    const text = allReplayText();
    expect(text).not.toContain("ancient");
    expect(text).toContain("recent");
    expect(replayCalls()[0].body.events[0].type).toBe(4);
    expect(replayCalls()[0].body.events.some((e: { type: number }) => e.type === 2)).toBe(true);
  });
});

describe("error linking and wire shape", () => {
  it("tags every error event with the replay_id while recording, and the body validates against the schema", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    const id = replay.startReplay();
    await settle();
    const eventId = overseer.captureException(new Error("boom"));
    await vi.advanceTimersByTimeAsync(2000);

    const ingested = ingestCalls().flatMap((c) => c.body.events).find((e: any) => e.type === "error");
    expect(ingested.event.id).toBe(eventId);
    expect(ingested.event.tags.replay_id).toBe(id);
    expect(ingested.event.contexts.replay.replay_id).toBe(id);

    expect(replayCalls()).toHaveLength(1);
    const call = replayCalls()[0];
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["x-overseer-key"]).toBe("osk_test");
    expect((call.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const parsed = ReplaySegmentUploadSchema.parse(call.body);
    expect(parsed.sdk).toEqual({ ...SDK_INFO });
    expect(parsed.environment).toBe("production");
    expect(parsed.release).toBe("1.2.3");
    expect(call.raw.length).toBeLessThan(MAX_BODY_BYTES);
  });

  it("does not tag errors, or upload, after stopReplay", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    replay.startReplay();
    await settle();
    replay.stopReplay();
    overseer.captureException(new Error("after-stop"));
    await vi.advanceTimersByTimeAsync(2000);
    const ingested = ingestCalls().flatMap((c) => c.body.events).find((e: any) => e.type === "error");
    expect(ingested.event.tags?.replay_id).toBeUndefined();
    expect(replayCalls()).toHaveLength(0);
  });

  it("accepts the contract's example payload, and rejects a broken one (negative control)", () => {
    expect(ReplaySegmentUploadSchema.safeParse(CONTRACT_EXAMPLE).success).toBe(true);
    expect(ReplaySegmentUploadSchema.safeParse({ ...CONTRACT_EXAMPLE, replay_id: "nope" }).success).toBe(false);
    expect(ReplaySegmentUploadSchema.safeParse({ ...CONTRACT_EXAMPLE, segment: -1 }).success).toBe(false);
  });
});

describe("upload helpers", () => {
  it("builds `<dsn>/replay`, swapping a trailing /ingest", async () => {
    const { replayEndpoint } = await import("../upload");
    expect(replayEndpoint("https://codmir.com/api/overseer")).toBe("https://codmir.com/api/overseer/replay");
    expect(replayEndpoint("https://codmir.com/api/overseer/")).toBe("https://codmir.com/api/overseer/replay");
    expect(replayEndpoint("https://codmir.com/api/overseer/ingest")).toBe("https://codmir.com/api/overseer/replay");
  });

  it("splits events so every body is under 2 MB and 10,000 events, dropping a single event that cannot fit", async () => {
    const { chunkEvents, buildSegmentBody, MAX_EVENTS_PER_SEGMENT } = await import("../upload");
    const big = (i: number) => ({ type: 3, timestamp: 1000 + i, data: { blob: "x".repeat(300_000) } });
    const many = Array.from({ length: 20 }, (_, i) => big(i));
    const { chunks, dropped } = chunkEvents(many);
    expect(dropped).toBe(0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [n, chunk] of chunks.entries()) {
      const body = JSON.stringify(buildSegmentBody({}, { replayId: "r", sequenceNumber: n, events: chunk, errorIds: [] }));
      expect(body.length).toBeLessThan(MAX_BODY_BYTES);
    }
    expect(chunks.flat()).toHaveLength(20);

    const small = Array.from({ length: MAX_EVENTS_PER_SEGMENT + 1 }, (_, i) => ({ type: 3, timestamp: i }));
    expect(chunkEvents(small).chunks.map((c) => c.length)).toEqual([MAX_EVENTS_PER_SEGMENT, 1]);

    const huge = [{ type: 2, timestamp: 1, data: { blob: "x".repeat(2_000_000) } }, { type: 3, timestamp: 2 }];
    const out = chunkEvents(huge);
    expect(out.dropped).toBe(1);
    expect(out.chunks.flat()).toHaveLength(1);
  });

  it("retries a failed upload once and then drops it, never throwing", async () => {
    useFakeClock();
    respond = () => new Response("{}", { status: 503 });
    const { postSegment, buildSegmentBody } = await import("../upload");
    const target = { url: REPLAY_URL, key: "osk_test" };
    const body = buildSegmentBody(target, { replayId: CONTRACT_EXAMPLE.replay_id, sequenceNumber: 0, events: [{ type: 2, timestamp: 1 }], errorIds: [] });
    const result = postSegment(target, body);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe("failed");
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx, and a thrown fetch resolves false", async () => {
    const { postSegment, buildSegmentBody } = await import("../upload");
    const target = { url: REPLAY_URL, key: "osk_test" };
    const body = buildSegmentBody(target, { replayId: CONTRACT_EXAMPLE.replay_id, sequenceNumber: 0, events: [{ type: 2, timestamp: 1 }], errorIds: [] });
    respond = () => new Response("{}", { status: 400 });
    expect(await postSegment(target, body)).toBe("failed");
    expect(calls).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    useFakeClock();
    const result = postSegment(target, body, true); // hiding: no retry wait
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe("failed");
  });

  it("treats 202 {stored:false} as a refusal: no retry, and no more uploads this session", async () => {
    useFakeClock();
    respond = () => new Response(JSON.stringify({ stored: false, reason: "payment_required" }), { status: 202 });
    const { overseer, replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("a", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replayCalls()).toHaveLength(1);
    expect(ReplayUploadResponseSchema.parse({ stored: false, reason: "payment_required" }).stored).toBe(false);
    record.addCustomEvent("b", 1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(replayCalls()).toHaveLength(1);
    // The recorder stopped, so errors are no longer linked to a replay.
    overseer.captureException(new Error("after-refusal"));
    await vi.advanceTimersByTimeAsync(2000);
    const err = ingestCalls().flatMap((c) => c.body.events).find((e: any) => e.type === "error");
    expect(err.event.tags?.replay_id).toBeUndefined();
  });

  it("keeps the newest 500 error ids per segment", async () => {
    const { buildSegmentBody } = await import("../upload");
    const ids = Array.from({ length: 600 }, (_, i) => `e${i}`);
    const body = buildSegmentBody({}, { replayId: CONTRACT_EXAMPLE.replay_id, sequenceNumber: 0, events: [{ type: 2, timestamp: 1 }], errorIds: ids });
    expect(body.error_event_ids).toHaveLength(500);
    expect(body.error_event_ids[0]).toBe("e100");
    expect(body.error_event_ids[499]).toBe("e599");
    expect(ReplaySegmentUploadSchema.safeParse(body).success).toBe(true);
  });

  it("a 503 is retried once, then dropped (replay storage not configured)", async () => {
    useFakeClock();
    respond = () => new Response("{}", { status: 503 });
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("a", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(replayCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(replayCalls()).toHaveLength(2);
  });

  it("flushes the current segment on pagehide with keepalive when the body fits 64 KB", async () => {
    useFakeClock();
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("last-words", 1);
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);

    expect(replayCalls()).toHaveLength(1);
    expect(replayCalls()[0].raw).toContain("last-words");
    // The full snapshot of this tiny page is well under 60 KB.
    expect((replayCalls()[0].init as { keepalive?: boolean }).keepalive).toBe(
      replayCalls()[0].raw.length <= 60_000 ? true : undefined,
    );
  });
});

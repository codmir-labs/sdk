/**
 * CSL-5492: @codmir/sdk 2.0.1 posted flat events the deployed server silently dropped, never checked `res.ok`,
 * lost events on unload and defaulted its endpoint to the customer's own origin. These tests pin the fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OverseerClient } from "../index";
import { buildBody, retryDelayMs, sdkFingerprint, toWireEvent, MAX_QUEUE_SIZE, RETRY_MAX_MS } from "../transport";

// Copied from platform-v2 packages/types/src/api/overseer-ingest.ts (codmir-labs/platform-v2 #803,
// `OverseerWrapperErrorEventSchema`) and apps/api/src/lib/overseer/store-errors.ts (`IngestedError`), plus the
// envelope in packages/types/src/api/analytics.ts (`TelemetryIngestBodySchema`). Keep in sync by hand.
const WrapperErrorEventSchema = z.object({
  type: z.literal("error"),
  event: z
    .object({
      id: z.string().optional(),
      message: z.string().optional(),
      level: z.string().optional(),
      environment: z.string().optional(),
      service: z.string().optional(),
      release: z.string().optional(),
      fingerprint: z.array(z.string()).optional(),
      tags: z.record(z.string(), z.string()).optional(),
    })
    .passthrough()
    .optional(),
  group: z
    .object({
      id: z.string().optional(),
      fingerprint: z.union([z.array(z.string()), z.string()]).optional(),
      message: z.string().optional(),
      culprit: z.string().optional(),
      level: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
const TelemetryIngestBodySchema = z.object({
  sessionId: z.string().max(128).optional(),
  service: z.string().max(64).optional(),
  environment: z.string().max(32).optional(),
  release: z.string().max(64).optional(),
  events: z.array(z.unknown()).max(500),
});

const ERROR_MESSAGE = "Cannot read properties of undefined (reading 'id')";

function nodeError(message = ERROR_MESSAGE): Error {
  const err = new TypeError(message);
  err.stack =
    `TypeError: ${message}\n` +
    "    at handleCheckout (/srv/app/src/checkout.ts:42:13)\n" +
    "    at Layer.handle [as handle_request] (/srv/app/node_modules/express/lib/router/layer.js:95:5)";
  return err;
}

type FetchCall = { url: string; init: RequestInit; body: any };
let calls: FetchCall[];
let respond: () => Response | Promise<Response>;

function ok(body: unknown = { received: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  respond = () => ok();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      return respond();
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client(extra: Record<string, unknown> = {}): OverseerClient {
  const c = new OverseerClient({ clientKey: "osk_test", environment: "production", release: "1.2.3", ...extra });
  c.init();
  return c;
}

describe("wire shape (criterion 1)", () => {
  it("sends each error as the {type,event,group} wrapper the deployed server stores", async () => {
    const c = client({ service: "checkout-api" });
    c.setSessionId("sess_1");
    c.setTags({ region: "eu" });
    c.addBreadcrumb({ type: "navigation", message: "/cart" });
    c.captureException(nodeError());
    expect(await c.flush()).toBe(true);

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(TelemetryIngestBodySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ service: "checkout-api", environment: "production", release: "1.2.3", sessionId: "sess_1" });

    const [wire] = body.events;
    expect(WrapperErrorEventSchema.safeParse(wire).success).toBe(true);
    expect(wire.type).toBe("error");
    expect(wire.event).toMatchObject({
      message: ERROR_MESSAGE,
      level: "error",
      environment: "production",
      release: "1.2.3",
      tags: { region: "eu" },
      fingerprint: ["TypeError", "/srv/app/src/checkout.ts:42", "Cannot read properties of undefined (reading 'id')"],
    });
    expect(typeof wire.event.id).toBe("string");
    // The SDK's other fields stay alongside.
    expect(wire.event.exception.type).toBe("TypeError");
    expect(wire.event.exception.stacktrace[0]).toMatchObject({ filename: "/srv/app/src/checkout.ts", lineno: 42 });
    expect(wire.event.breadcrumbs).toHaveLength(1);
    expect(wire.group).toEqual({
      fingerprint: wire.event.fingerprint,
      message: ERROR_MESSAGE,
      culprit: "/srv/app/src/checkout.ts:42",
      level: "error",
    });
    // No flat leftovers at the top level that would make the server see two shapes.
    expect(wire.exception).toBeUndefined();
  });

  it("fingerprints like the platform's sdkFingerprint and ErrorTracker.generateFingerprint", () => {
    // Port of apps/api/src/__tests__/overseer-ingest-sdk-5492.test.ts "fingerprints the way ErrorTracker groups".
    // There, ErrorTracker produced this array for the stack below; here it is written out because @codmir/overseer
    // is not a dependency of the SDK: name, first in-app `file:line`, message with digits -> <N>.
    const expectedFromErrorTracker = ["Error", "/srv/app/src/checkout.ts:42", "order <N> not found"];
    const flat = {
      id: "x",
      type: "error",
      timestamp: "2026-11-01T09:30:12.481Z",
      level: "error",
      exception: {
        type: "Error",
        value: "order 1001 not found",
        stacktrace: [
          { function: "handleCheckout", filename: "/srv/app/src/checkout.ts", lineno: 42, colno: 13, in_app: true },
        ],
      },
    };
    expect(sdkFingerprint(flat)).toEqual(expectedFromErrorTracker);
  });

  it("masks digits and 8+ hex runs, slices to 100, and skips frames that are not in_app", () => {
    const base = { id: "x", type: "error", timestamp: "t", level: "error" };
    const fp = sdkFingerprint({
      ...base,
      exception: {
        type: "Error",
        value: "user deadbeef12 got 404 " + "z".repeat(200),
        stacktrace: [
          { filename: "/node_modules/a.js", lineno: 1, in_app: false },
          { filename: "/app/b.ts", lineno: 7, in_app: true },
        ],
      },
    });
    expect(fp[0]).toBe("Error");
    expect(fp[1]).toBe("/app/b.ts:7");
    expect(fp[2].startsWith("user <ID><N> got <N> zzz")).toBe(true);
    expect(fp[2]).toHaveLength(100);
    // 1001 and 2002 differ only in digits: same group.
    const a = sdkFingerprint({ ...base, exception: { type: "E", value: "order 1001 not found" } });
    const b = sdkFingerprint({ ...base, exception: { type: "E", value: "order 2002 not found" } });
    expect(a).toEqual(b);
  });

  it("lets the event's own fingerprint[] win (set in beforeSend)", async () => {
    const c = client({ beforeSend: (e: any) => ({ ...e, fingerprint: ["custom", "group"] }) });
    c.captureException(nodeError());
    await c.flush();
    const [wire] = calls[0].body.events;
    expect(wire.event.fingerprint).toEqual(["custom", "group"]);
    expect(wire.group.fingerprint).toEqual(["custom", "group"]);
  });

  it("clips envelope fields to the limits the server validates", () => {
    const body = JSON.parse(
      buildBody([], { service: "s".repeat(100), environment: "e".repeat(100), release: "r".repeat(100), sessionId: "i".repeat(300) }),
    );
    expect(TelemetryIngestBodySchema.safeParse(body).success).toBe(true);
  });
});

describe("non-error events are unchanged (criterion 2)", () => {
  it.each(["message", "transaction", "replay"] as const)("%s", (type) => {
    const evt = { id: "m1", type, timestamp: "2026-11-01T00:00:00Z", level: "info", message: "hi", tags: { a: "b" } };
    expect(toWireEvent(evt)).toBe(evt);
  });

  it("captureMessage goes out flat", async () => {
    const c = client();
    c.captureMessage("hello", "warning");
    await c.flush();
    const [wire] = calls[0].body.events;
    expect(wire).toMatchObject({ type: "message", message: "hello", level: "warning" });
    expect(wire.event).toBeUndefined();
    expect(wire.group).toBeUndefined();
  });
});

describe("delivery (criterion 3)", () => {
  it.each([500, 502, 503, 408, 429])("a %i re-queues the batch and a later attempt delivers it", async (status) => {
    const c = client();
    respond = () => new Response("nope", { status });
    c.captureException(nodeError());
    expect(await c.flush()).toBe(false);
    expect(calls).toHaveLength(1);

    respond = () => ok();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.events[0].event.id).toBe(calls[0].body.events[0].event.id);
    expect(await c.flush()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 413])("a %i is not retried and the batch is dropped", async (status) => {
    const c = client();
    respond = () => new Response("bad", { status });
    c.captureException(nodeError());
    await c.flush();
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(calls).toHaveLength(1);
    expect(await c.flush()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a network failure is retried", async () => {
    const c = client();
    (globalThis.fetch as any).mockRejectedValueOnce(new TypeError("fetch failed"));
    c.captureException(nodeError());
    expect(await c.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.events).toHaveLength(1);
  });

  it("backs off exponentially and caps the delay", async () => {
    expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(30)).toBe(RETRY_MAX_MS);

    const c = client();
    respond = () => new Response("down", { status: 503 });
    c.captureException(nodeError());
    await c.flush(); // attempt 1 at t=0
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // retry at 1s
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // next at +2s
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4000); // then +4s
    expect(calls).toHaveLength(4);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(calls.length).toBeGreaterThanOrEqual(14);
    c.close();
  });

  it("honours Retry-After on a 429 when it is longer than the backoff", async () => {
    const c = client();
    respond = () => new Response("slow down", { status: 429, headers: { "retry-after": "10" } });
    c.captureException(nodeError());
    await c.flush();
    respond = () => ok();
    await vi.advanceTimersByTimeAsync(9999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
  });

  it("caps the queue and drops the oldest events", async () => {
    const c = client();
    (globalThis.fetch as any).mockRejectedValueOnce(new TypeError("offline"));
    for (let i = 0; i < MAX_QUEUE_SIZE + 5; i++) c.captureException(new Error(`e${i}`));
    await c.flush(); // fails, batch put back, trimmed
    await vi.advanceTimersByTimeAsync(1000);
    await c.flush();

    const messages = calls.flatMap((x) => x.body.events.map((e: any) => e.event.message));
    expect(messages).toHaveLength(MAX_QUEUE_SIZE);
    expect(messages[0]).toBe("e5"); // e0..e4 were the oldest
    expect(messages.at(-1)).toBe(`e${MAX_QUEUE_SIZE + 4}`);
    expect(calls.every((x) => x.body.events.length <= 100)).toBe(true);
  });

  it("logs droppedEvents from the response in debug mode only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    respond = () => ok({ received: true, droppedEvents: [{ index: 0, reason: "unkeyed", type: "error" }] });

    const quiet = client();
    quiet.captureException(nodeError());
    await quiet.flush();
    expect(log).not.toHaveBeenCalled();

    const loud = client({ debug: true });
    loud.captureException(nodeError());
    await loud.flush();
    expect(log.mock.calls.some((c) => c[0] === "[Overseer]" && c[1] === "Server dropped events:")).toBe(true);
    log.mockRestore();
  });
});

describe("browser unload flush (criterion 4)", () => {
  let win: EventTarget;
  let doc: EventTarget & { visibilityState: string };
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    win = new EventTarget();
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    beacon = vi.fn();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
  });

  it("pagehide flushes with keepalive and the x-overseer-key header", async () => {
    const c = client();
    c.captureException(nodeError());
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://codmir.com/api/overseer/ingest");
    expect((calls[0].init as any).keepalive).toBe(true);
    expect((calls[0].init.headers as Record<string, string>)["x-overseer-key"]).toBe("osk_test");
    expect(WrapperErrorEventSchema.safeParse(calls[0].body.events[0]).success).toBe(true);
    expect(beacon).not.toHaveBeenCalled();
    // Already sent: the debounce does not send it again.
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
  });

  it("visibilitychange to hidden flushes; to visible does not", async () => {
    const c = client();
    c.captureException(nodeError());
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);

    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect((calls[0].init as any).keepalive).toBe(true);
  });

  it("an unload flush that fails puts the events back", async () => {
    const c = client();
    respond = () => new Response("down", { status: 503 });
    c.captureException(nodeError());
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    respond = () => ok();
    expect(await c.flush()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("close() removes the listeners", async () => {
    const c = client();
    c.close();
    c.captureException(nodeError());
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
  });
});

describe("default dsn (criterion 5)", () => {
  it("is codmir.com even in a browser on a customer origin", async () => {
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { origin: "https://customer.example" } }));
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    const c = client();
    c.captureException(nodeError());
    await c.flush();
    expect(calls[0].url).toBe("https://codmir.com/api/overseer/ingest");
    expect(c.getDsn()).toBe("https://codmir.com/api/overseer");
  });

  it("an explicit dsn still wins", async () => {
    const c = client({ dsn: "https://ingest.example.test/api/overseer" });
    c.captureException(nodeError());
    await c.flush();
    expect(calls[0].url).toBe("https://ingest.example.test/api/overseer/ingest");
  });
});

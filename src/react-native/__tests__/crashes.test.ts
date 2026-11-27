import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/v1/overseer";

type Handler = (error: Error, isFatal?: boolean) => void;
type RN = typeof import("../index");

let RN: RN;
let handler: Handler;
let sent: any[];
let atOriginal: Array<{ message: string; fatal?: boolean; requests: number }>;

/** Every error event the stubbed `fetch` was given. */
function events(): any[] {
  return sent.flatMap((body) => (body.events ?? []).filter((w: any) => w.type === "error").map((w: any) => w.event));
}

function stubNetwork(answers: boolean): void {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return answers ? Promise.resolve(new Response('{"received":true}', { status: 200 })) : new Promise<Response>(() => {});
    }),
  );
}

/** ErrorUtils as React Native has it: the original handler is what ends the app, so it notes how much was sent by then. */
function stubErrorUtils(): void {
  handler = (error, isFatal) => {
    atOriginal.push({ message: error.message, fatal: isFatal, requests: sent.length });
  };
  vi.stubGlobal("ErrorUtils", { getGlobalHandler: () => handler, setGlobalHandler: (h: Handler) => (handler = h) });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  atOriginal = [];
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { product: "ReactNative" });
  RN = await import("../index");
});

afterEach(() => {
  RN.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a fatal error", () => {
  it("(a) is sent before React Native's handler runs", async () => {
    stubNetwork(true);
    stubErrorUtils();
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    handler(new TypeError("undefined is not a function"), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(atOriginal).toHaveLength(1);
    expect(atOriginal[0].fatal).toBe(true);
    expect(atOriginal[0].requests).toBeGreaterThanOrEqual(1);
    expect(events()[0]).toMatchObject({ level: "fatal", exception: { mechanism: { type: "global-error-handler", handled: false } } });
  });

  it("(b) still reaches React Native's handler at 2 s when the network never answers", async () => {
    stubNetwork(false);
    stubErrorUtils();
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    handler(new Error("boom"), true);
    await vi.advanceTimersByTimeAsync(1900);
    expect(atOriginal).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(atOriginal).toHaveLength(1);
  });

  it("(c) while the flush is pending, a second fatal reaches React Native's handler at once", async () => {
    stubNetwork(false);
    stubErrorUtils();
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    handler(new Error("first"), true);
    await vi.advanceTimersByTimeAsync(500);
    expect(atOriginal).toHaveLength(0);
    handler(new Error("second"), true);
    expect(atOriginal.map((c) => c.message)).toEqual(["second"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(atOriginal.map((c) => c.message)).toEqual(["second", "first"]);
  });

  it("is passed on at once after close()", async () => {
    stubNetwork(true);
    stubErrorUtils();
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    const sdkHandler = handler;
    RN.close();
    sdkHandler(new Error("late"), true);
    expect(atOriginal).toHaveLength(1);
  });
});

describe("other errors", () => {
  it("(d) a non-fatal error reaches React Native's handler at once", () => {
    stubNetwork(true);
    stubErrorUtils();
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    handler(new Error("soft"), false);
    expect(atOriginal).toEqual([{ message: "soft", fatal: false, requests: 0 }]);
  });
});

describe("app state", () => {
  it("(e) background sends what is queued; active only adds the breadcrumb", async () => {
    stubNetwork(true);
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    RN.trackAppStateChange("active");
    RN.captureException(new Error("queued"));
    expect(sent).toHaveLength(0);
    RN.trackAppStateChange("background");
    await vi.advanceTimersByTimeAsync(0);
    expect(events().map((e) => e.exception.value)).toEqual(["queued"]);
    const crumbs = events()[0].breadcrumbs.map((b: any) => b.message);
    expect(crumbs).toContain("App state: active");
  });
});

describe("unhandled rejections", () => {
  function stubHermes(): { tracker: ReturnType<typeof vi.fn>; options: () => any } {
    const tracker = vi.fn();
    vi.stubGlobal("HermesInternal", { hasPromise: () => true, enablePromiseRejectionTracker: tracker });
    return { tracker, options: () => tracker.mock.calls[0][0] };
  }

  it("(f) are captured as unhandled, an Error with its stack and another value with none", async () => {
    stubNetwork(true);
    const { tracker, options } = stubHermes();
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    expect(tracker).toHaveBeenCalledTimes(1);
    expect(options().allRejections).toBe(true);
    expect(() => options().onHandled(1)).not.toThrow();

    const error = new Error("x");
    options().onUnhandled(1, error);
    options().onUnhandled(2, { message: "Session expired" });
    await RN.flush();
    const [first, second] = events();
    expect(first.exception.value).toBe("x");
    expect(first.exception.mechanism).toEqual({ type: "onunhandledrejection", handled: false });
    expect(first.exception.stacktrace.length).toBeGreaterThan(0);
    expect(first.exception.stacktrace[0].filename).toContain("crashes.test");
    expect(second.exception.value).toBe("Session expired");
    expect(second.exception.mechanism).toEqual({ type: "onunhandledrejection", handled: false });
    expect(second.exception.stacktrace ?? []).toEqual([]);
    expect(events()).toHaveLength(2);
  });

  it("(f) capture nothing after close()", async () => {
    stubNetwork(true);
    const { options } = stubHermes();
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    const { onUnhandled } = options();
    RN.close();
    sent.length = 0;
    onUnhandled(3, new Error("after close"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(0);
  });

  it("(g) without Hermes, init does not throw and enables nothing", () => {
    stubNetwork(true);
    vi.stubGlobal("HermesInternal", undefined);
    expect(() => RN.init({ dsn: DSN, clientKey: "osk_test" })).not.toThrow();
    const tracker = vi.fn();
    RN.close();
    vi.stubGlobal("HermesInternal", { hasPromise: () => false, enablePromiseRejectionTracker: tracker });
    expect(() => RN.init({ dsn: DSN, clientKey: "osk_test" })).not.toThrow();
    expect(tracker).not.toHaveBeenCalled();
  });

  it("(h) warns under __DEV__ and stays quiet outside it", () => {
    stubNetwork(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { options } = stubHermes();
    RN.init({ dsn: DSN, clientKey: "osk_test" });
    const reason = new Error("dev");

    vi.stubGlobal("__DEV__", false);
    options().onUnhandled(4, reason);
    expect(warn).not.toHaveBeenCalled();

    vi.stubGlobal("__DEV__", true);
    options().onUnhandled(5, reason);
    expect(warn).toHaveBeenCalledWith("Possible unhandled promise rejection (id: 5):", reason);
    warn.mockRestore();
  });
});

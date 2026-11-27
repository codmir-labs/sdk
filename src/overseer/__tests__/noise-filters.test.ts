// @vitest-environment jsdom
/**
 * Noise filters: `ignoreErrors` (with its built-in entries), `denyUrls`, `allowUrls`, `maxBreadcrumbs` and
 * `beforeBreadcrumb`, and a thrown value that is not an error carrying no frame from inside the SDK. Everything is read
 * from the body `fetch` was given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as browser from "../../browser/index";
import { addBreadcrumb, captureException, captureMessage, close, flush, getClient, init, type OverseerConfig } from "../index";
import { withHint, crash } from "../capture-hint";
import { withRequestScope } from "../request-scope";

type Frame = { filename?: string; in_app?: boolean };
type Wire = { type: string; message?: string; exception?: { type: string; value: string; stacktrace: Frame[] }; breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }> };

let bodies: string[];
let dropped: Array<{ events: number; status: number; reason?: string; eventIds?: string[] }>;

const base = { clientKey: "osk_test", dsn: "https://ingest.example.com/api/overseer", environment: "test", includeSourceContext: false, rateLimit: false } as const;

function start(config: OverseerConfig = {}): void {
  init({ ...base, onDropped: (d) => dropped.push(d), ...config });
}

beforeEach(() => {
  bodies = [];
  dropped = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, req: RequestInit) => {
      bodies.push(String(req.body));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  browser.close();
  close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The error and message events on the wire. */
async function sent(): Promise<Wire[]> {
  await flush();
  return bodies.flatMap((b) => (JSON.parse(b).events as Array<Wire & { event?: Wire }>).filter((e) => e.type === "error" || e.type === "message").map((e) => e.event ?? e));
}

/** An error whose stack names `file` as its innermost frame. */
function thrownIn(file: string, message = "boom"): Error {
  return Object.assign(new Error(message), { stack: `Error: ${message}\n    at run (${file}:10:5)\n    at main (https://app.example.com/main.js:1:1)` });
}

describe("default ignoreErrors", () => {
  it("drops a ResizeObserver loop error from the global handler", async () => {
    start();
    browser.init({ ...base, onDropped: (d) => dropped.push(d) });
    window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
    window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop limit exceeded" }));
    expect(await sent()).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual(["filtered", "filtered"]);
  });

  it("drops the cross-origin Script error, with or without the period", async () => {
    browser.init({ ...base, onDropped: (d) => dropped.push(d) });
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error" }));
    expect(await sent()).toEqual([]);
    expect(dropped).toHaveLength(2);
  });

  it("does not drop a message that only mentions Script error", async () => {
    start();
    captureException(new Error("Script error in checkout widget"));
    expect(await sent()).toHaveLength(1);
  });

  it("sends both when defaultIgnoreErrors is false", async () => {
    browser.init({ ...base, defaultIgnoreErrors: false, onDropped: (d) => dropped.push(d) });
    window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    const events = await sent();
    expect(events.map((e) => e.exception?.value)).toEqual(["ResizeObserver loop completed with undelivered notifications.", "Script error."]);
    expect(dropped).toEqual([]);
  });

  it("applies beside the user's own list", async () => {
    start({ ignoreErrors: ["flaky"] });
    captureException(new Error("ResizeObserver loop limit exceeded"));
    captureException(new Error("a flaky thing"));
    captureException(new Error("real"));
    expect((await sent()).map((e) => e.exception?.value)).toEqual(["real"]);
  });
});

describe("ignoreErrors", () => {
  it("a string matches as a substring and keeps what does not match", async () => {
    start({ ignoreErrors: ["Network request failed"] });
    captureException(new Error("Network request failed: /api/x"));
    captureException(new Error("Cart is empty"));
    expect((await sent()).map((e) => e.exception?.value)).toEqual(["Cart is empty"]);
  });

  it("a RegExp is tested, and a global one is not stuck on lastIndex", async () => {
    start({ ignoreErrors: [/^Loading chunk \d+ failed/g] });
    captureException(new Error("Loading chunk 12 failed"));
    captureException(new Error("Loading chunk 13 failed"));
    captureException(new Error("Cart is empty"));
    expect((await sent()).map((e) => e.exception?.value)).toEqual(["Cart is empty"]);
    expect(dropped).toHaveLength(2);
  });

  it("a global RegExp drops two matching events in a row", async () => {
    start({ ignoreErrors: [/cart/gi] });
    // A message event has one text, so a stale lastIndex from the first would make the second miss.
    captureMessage("Cart is empty");
    captureMessage("Cart is empty");
    captureException(new Error("Cart total is wrong"));
    captureException(new Error("Cart total is wrong"));
    captureMessage("deploy finished");
    expect((await sent()).map((e) => e.message)).toEqual(["deploy finished"]);
    expect(dropped.map((d) => d.reason)).toEqual(["filtered", "filtered", "filtered", "filtered"]);
  });

  it("filters an error event and a message event sent with captureEvent", async () => {
    start({ ignoreErrors: ["noise"] });
    const client = getClient()!;
    const at = new Date().toISOString();
    const errorId = client.captureEvent({ id: "evt-error", type: "error", timestamp: at, level: "error", exception: { type: "Error", value: "some noise here" } } as never);
    const messageId = client.captureEvent({ id: "evt-message", type: "message", timestamp: at, level: "info", message: "more noise" });
    expect([errorId, messageId]).toEqual(["evt-error", "evt-message"]);
    expect(dropped).toEqual([
      { events: 1, status: 0, reason: "filtered", eventIds: ["evt-error"] },
      { events: 1, status: 0, reason: "filtered", eventIds: ["evt-message"] },
    ]);
    expect(await sent()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("matches `<type>: <message>` as well as the bare message", async () => {
    start({ ignoreErrors: ["TypeError: x is undefined", /^RangeError/] });
    captureException(new TypeError("x is undefined"));
    captureException(new RangeError("out of range"));
    captureException(new Error("x is undefined"));
    expect((await sent()).map((e) => e.exception?.type)).toEqual(["Error"]);
  });

  it("drops a matching message event and keeps another", async () => {
    start({ ignoreErrors: ["healthcheck"] });
    captureMessage("healthcheck ok");
    captureMessage("deploy finished");
    expect((await sent()).map((e) => e.message)).toEqual(["deploy finished"]);
    expect(dropped).toHaveLength(1);
  });

  it("ignores an empty string and a wrong type instead of dropping everything", async () => {
    start({ ignoreErrors: ["", 5 as unknown as string] });
    captureException(new Error("kept"));
    expect(await sent()).toHaveLength(1);
  });

  it("reports one `filtered` drop with the event id, and sends nothing", async () => {
    start({ ignoreErrors: ["noise"] });
    const id = captureException(new Error("noise here"));
    expect(id).not.toBe("");
    expect(dropped).toEqual([{ events: 1, status: 0, reason: "filtered", eventIds: [id] }]);
    expect(await sent()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never reaches beforeSend, sampling or the rate limit", async () => {
    const beforeSend = vi.fn((e) => e);
    start({ ignoreErrors: ["noise"], beforeSend, sampleRate: 0, rateLimit: { perMinute: 1 } });
    captureException(new Error("noise"));
    captureException(new Error("noise"));
    expect(beforeSend).not.toHaveBeenCalled();
    // Reported though the sample rate is 0, and no `rate_limited` is reported for the second.
    expect(dropped.map((d) => d.reason)).toEqual(["filtered", "filtered"]);
  });

  it("logs the option that dropped it with debug on", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    start({ ignoreErrors: ["noise"], denyUrls: ["bad.js"], debug: true });
    captureException(new Error("noise"));
    captureException(thrownIn("https://cdn.example.com/bad.js"));
    const lines = log.mock.calls.map((c) => c.join(" "));
    expect(lines.some((l) => l.includes("ignoreErrors dropped"))).toBe(true);
    expect(lines.some((l) => l.includes("denyUrls dropped"))).toBe(true);
  });
});

describe("denyUrls and allowUrls", () => {
  it("denyUrls drops an error thrown in a matching script", async () => {
    start({ denyUrls: [/extension\.example\.com/, "tracker.js"] });
    captureException(thrownIn("https://extension.example.com/inject.js"));
    captureException(thrownIn("https://cdn.example.com/tracker.js?v=3"));
    captureException(thrownIn("https://app.example.com/app.js"));
    expect((await sent()).map((e) => e.exception?.stacktrace[0]?.filename)).toEqual(["https://app.example.com/app.js"]);
    expect(dropped.map((d) => d.reason)).toEqual(["filtered", "filtered"]);
  });

  it("matches the innermost frame, not an outer one", async () => {
    start({ denyUrls: ["main.js"] });
    // `main.js` is the outer frame of every `thrownIn` error.
    captureException(thrownIn("https://app.example.com/app.js"));
    expect(await sent()).toHaveLength(1);
  });

  it("allowUrls keeps a matching script and drops another", async () => {
    start({ allowUrls: [/^https:\/\/app\.example\.com\//] });
    captureException(thrownIn("https://app.example.com/app.js", "mine"));
    captureException(thrownIn("https://other.example.org/lib.js", "theirs"));
    expect((await sent()).map((e) => e.exception?.value)).toEqual(["mine"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toBe("filtered");
  });

  it("an error with no URL is kept under allowUrls", async () => {
    start({ allowUrls: ["https://app.example.com/"] });
    captureException(Object.assign(new Error("no frames"), { stack: "Error: no frames" }));
    captureException("a string", withHint({}, crash("onunhandledrejection", undefined, "none")));
    captureMessage("a message");
    expect(await sent()).toHaveLength(3);
    expect(dropped).toEqual([]);
  });

  it("with no stack, the event's own file name is the URL", async () => {
    start({ denyUrls: ["vendor.js"] });
    captureException("x", withHint({}, crash("onerror", undefined, { filename: "https://cdn.example.com/vendor.js", lineno: 1 })));
    captureException({ message: "y" }, withHint({ filename: "https://cdn.example.com/vendor.js" }, crash("onerror", undefined, "none")));
    expect(await sent()).toEqual([]);
    expect(dropped).toHaveLength(2);
  });

  it("a window error from an extension is dropped by its file", async () => {
    browser.init({ ...base, denyUrls: [/^chrome-extension:/], onDropped: (d) => dropped.push(d) });
    window.dispatchEvent(new ErrorEvent("error", { message: "injected failed", filename: "chrome-extension://abcdef/content.js", lineno: 3 }));
    window.dispatchEvent(new ErrorEvent("error", { message: "page failed", filename: `${window.location.origin}/app.js`, lineno: 3 }));
    expect((await sent()).map((e) => e.exception?.value)).toEqual(["page failed"]);
  });
});

describe("maxBreadcrumbs", () => {
  const crumbs = (n: number): void => {
    for (let i = 1; i <= n; i++) addBreadcrumb({ message: `crumb ${i}` });
  };

  it("keeps the newest 5 of 20 with maxBreadcrumbs: 5", async () => {
    start({ maxBreadcrumbs: 5 });
    crumbs(20);
    captureException(new Error("x"));
    expect((await sent())[0]!.breadcrumbs!.map((b) => b.message)).toEqual(["crumb 16", "crumb 17", "crumb 18", "crumb 19", "crumb 20"]);
  });

  it("keeps none with 0", async () => {
    start({ maxBreadcrumbs: 0 });
    crumbs(20);
    captureException(new Error("x"));
    expect((await sent())[0]!.breadcrumbs ?? []).toEqual([]);
  });

  it("keeps 20 by default", async () => {
    start();
    crumbs(30);
    captureException(new Error("x"));
    expect((await sent())[0]!.breadcrumbs).toHaveLength(20);
  });

  it("clamps to 100 and ignores a value that is not a number", async () => {
    start({ maxBreadcrumbs: 500 });
    crumbs(150);
    captureException(new Error("a"));
    close();
    start({ maxBreadcrumbs: "7" as unknown as number });
    crumbs(30);
    captureException(new Error("b"));
    const [a, b] = await sent();
    expect(a!.breadcrumbs).toHaveLength(100);
    expect(b!.breadcrumbs).toHaveLength(20);
  });

  it("clamps a negative number to 0", async () => {
    start({ maxBreadcrumbs: -3 });
    crumbs(5);
    captureException(new Error("x"));
    expect((await sent())[0]!.breadcrumbs ?? []).toEqual([]);
  });

  it("keeps up to maxBreadcrumbs in a request's list, above 20", async () => {
    start({ maxBreadcrumbs: 50 });
    withRequestScope({ url: "https://app.example.com/x", method: "GET" }, () => {
      for (let i = 1; i <= 30; i++) addBreadcrumb({ message: `request ${i}` });
      captureException(new Error("in request"));
    });
    const crumbs = (await sent())[0]!.breadcrumbs!.map((b) => b.message);
    expect(crumbs).toHaveLength(30);
    expect(crumbs[0]).toBe("request 1");
    expect(crumbs[29]).toBe("request 30");
  });

  it("limits a request's list and the combined list alike", async () => {
    start({ maxBreadcrumbs: 3 });
    addBreadcrumb({ message: "global 1" });
    addBreadcrumb({ message: "global 2" });
    withRequestScope({ url: "https://app.example.com/x", method: "GET" }, () => {
      for (let i = 1; i <= 5; i++) addBreadcrumb({ message: `request ${i}` });
      captureException(new Error("in request"));
    });
    expect((await sent())[0]!.breadcrumbs!.map((b) => b.message)).toEqual(["request 3", "request 4", "request 5"]);
  });
});

describe("beforeBreadcrumb", () => {
  it("sees an automatic and a manual breadcrumb", async () => {
    const seen: string[] = [];
    // Before `browser.init`, which patches `console`: the page's own warning is silenced, and still seen as a breadcrumb.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    start({ beforeBreadcrumb: (b) => (seen.push(`${b.category ?? "-"}:${b.message}`), b) });
    browser.init({ ...base, beforeBreadcrumb: (b) => (seen.push(`${b.category ?? "-"}:${b.message}`), b), trackNavigation: false, trackClicks: false, trackRequests: false, trackConsole: ["warn"] });
    console.warn("from the page");
    addBreadcrumb({ message: "manual" });
    expect(seen.some((s) => s.startsWith("console:") && s.includes("from the page"))).toBe(true);
    expect(seen).toContain("-:manual");
  });

  it("can change a breadcrumb, and gets the hint", async () => {
    const hints: unknown[] = [];
    start({
      beforeBreadcrumb: (b, hint) => {
        hints.push(hint);
        return { ...b, message: `${b.message} (edited)`, data: { ...b.data, added: true } };
      },
    });
    addBreadcrumb({ message: "click", data: { id: 1 } }, { source: "test" });
    captureException(new Error("x"));
    const [event] = await sent();
    expect(event!.breadcrumbs![0]).toMatchObject({ message: "click (edited)", data: { id: 1, added: true } });
    expect(hints).toEqual([{ source: "test" }]);
  });

  it("gives the hook a copy: editing it never changes the caller's object", () => {
    start({ beforeBreadcrumb: (b) => ((b.data as Record<string, unknown>).seen = true, b) });
    const mine = { message: "m", data: { id: 1 } };
    addBreadcrumb(mine);
    expect(mine.data).toEqual({ id: 1 });
  });

  it("null drops the breadcrumb", async () => {
    start({ beforeBreadcrumb: (b) => (b.message === "secret" ? null : b) });
    addBreadcrumb({ message: "secret" });
    addBreadcrumb({ message: "fine" });
    captureException(new Error("x"));
    expect((await sent())[0]!.breadcrumbs!.map((b) => b.message)).toEqual(["fine"]);
  });

  it("a throw drops that breadcrumb, never breaks the app, and logs with debug on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    start({
      debug: true,
      beforeBreadcrumb: (b) => {
        if (b.message === "bad") throw new Error("hook broke");
        return b;
      },
    });
    expect(() => addBreadcrumb({ message: "bad" })).not.toThrow();
    addBreadcrumb({ message: "good" });
    captureException(new Error("x"));
    expect((await sent())[0]!.breadcrumbs!.map((b) => b.message)).toEqual(["good"]);
    expect(log.mock.calls.some((c) => c.join(" ").includes("beforeBreadcrumb failed"))).toBe(true);
  });

  it("a result that is not a breadcrumb drops it", async () => {
    let next: unknown = "nope";
    start({ beforeBreadcrumb: () => next as never });
    addBreadcrumb({ message: "a" });
    next = Promise.resolve({ message: "b" });
    addBreadcrumb({ message: "b" });
    next = [1];
    addBreadcrumb({ message: "c" });
    captureException(new Error("x"));
    expect((await sent())[0]!.breadcrumbs ?? []).toEqual([]);
  });

  it("the hook's data is scrubbed like any breadcrumb's", async () => {
    start({ beforeBreadcrumb: (b) => ({ ...b, data: { password: "hunter2", ok: 1 } }) });
    addBreadcrumb({ message: "login" });
    captureException(new Error("x"));
    const data = (await sent())[0]!.breadcrumbs![0]!.data!;
    expect(data.password).not.toBe("hunter2");
    expect(data.ok).toBe(1);
  });
});

describe("a thrown value that is not an Error", () => {
  const insideSdk = (f: Frame): boolean => /src[\\/](overseer|browser|nextjs|remix|express|react-native)[\\/](?!__tests__)/.test(f.filename ?? "");

  it("a string and a plain object carry no frame from inside the SDK", async () => {
    start();
    captureException("a thrown string");
    captureException({ message: "a plain object", code: 7 });
    const events = await sent();
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.exception!.stacktrace.some(insideSdk)).toBe(false);
      expect(e.exception!.stacktrace[0]?.filename).toMatch(/noise-filters\.test\.ts$/);
    }
  });

  it("an integration's capture of a string or an object carries no stack at all", async () => {
    start();
    captureException("integration string", withHint({}, crash("express-error-handler")));
    captureException({ message: "integration object" }, withHint({}, crash("nextjs-router")));
    for (const e of await sent()) expect(e.exception!.stacktrace).toEqual([]);
  });

  it("the global handlers' string and object rejections carry no frame", async () => {
    browser.init({ ...base, onDropped: (d) => dropped.push(d) });
    for (const reason of ["rejected string", { message: "rejected object" }]) {
      const event = new Event("unhandledrejection");
      Object.assign(event, { reason, promise: Promise.resolve() });
      window.dispatchEvent(event);
    }
    const events = await sent();
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.exception!.stacktrace).toEqual([]);
  });

  it("a real Error keeps its stack, unchanged, also under an integration's hint", async () => {
    start();
    const err = new RangeError("out of range");
    captureException(err);
    captureException(err, withHint({}, crash("express-error-handler")));
    for (const e of await sent()) {
      expect(e.exception!.stacktrace.length).toBeGreaterThan(0);
      expect(e.exception!.stacktrace[0]?.filename).toMatch(/noise-filters\.test\.ts$/);
    }
  });
});

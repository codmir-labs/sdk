// @vitest-environment jsdom
/**
 * What an entry's `init` patches, its `close` ends: a patch that something else was put over (another copy of the SDK,
 * another library) stays in the chain, passes every call on, and no longer records anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLive, listen, patch, Stops } from "../lifecycle";

describe("Stops", () => {
  it("runs the undo functions last first, once, and a throwing one does not stop the rest", () => {
    const order: number[] = [];
    const stops = new Stops();
    stops.add(() => order.push(1));
    stops.add(() => {
      throw new Error("x");
    });
    stops.add(() => order.push(3));
    stops.run();
    stops.run();
    expect(order).toEqual([3, 1]);
  });
});

describe("listen", () => {
  it("adds and removes a listener, and does nothing for a target without addEventListener", () => {
    const handler = vi.fn();
    const stop = listen(window, "ping", handler);
    window.dispatchEvent(new Event("ping"));
    stop();
    window.dispatchEvent(new Event("ping"));
    expect(handler).toHaveBeenCalledTimes(1);
    for (const target of [undefined, null, {}, globalThis.process]) expect(() => listen(target, "ping", handler)()).not.toThrow();
  });
});

describe("patch", () => {
  it("wraps a method, and puts the original back when it is still on top", () => {
    const target = { greet: (name: string) => `hello ${name}` };
    const original = target.greet;
    const stop = patch(target, "greet", (orig) => (name) => `${orig(name)}!`);
    expect(target.greet("a")).toBe("hello a!");
    stop();
    expect(target.greet).toBe(original);
  });

  it("leaves itself in place when another patch is over it, and then only passes the call on", () => {
    const target = { count: vi.fn((n: number) => n) };
    const base = target.count;
    const seen: number[] = [];
    const stop = patch(target, "count", (orig) => (n) => {
      seen.push(n);
      return orig(n);
    });
    const ours = target.count;
    const outer = (n: number): number => ours(n);
    target.count = outer;
    stop();
    expect(target.count).toBe(outer);
    expect(target.count(5)).toBe(5);
    expect(base).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("does nothing for a missing target or method", () => {
    expect(() => patch(undefined, "x" as never, (o) => o)()).not.toThrow();
    expect(() => patch({} as { f?: () => void }, "f", (o) => o)()).not.toThrow();
  });
});

describe("isLive", () => {
  it("is true for a working patch and for the mark of an older version (the original function), false for a closed one and for none", () => {
    const key = Symbol("patched");
    const marked = (mark?: unknown) => Object.assign(() => {}, mark === undefined ? {} : { [key]: mark });
    expect(isLive(marked({ active: true }), key)).toBe(true);
    expect(isLive(marked(() => {}), key)).toBe(true);
    expect(isLive(marked({ active: false }), key)).toBe(false);
    expect(isLive(marked(), key)).toBe(false);
    expect(isLive(undefined, key)).toBe(false);
  });
});

describe("fetch, XHR and history with another patch over ours", () => {
  const DSN = "https://ingest.example.test/api/overseer";
  let calls: string[];
  let bodies: Array<{ events: Array<{ event?: { breadcrumbs?: Array<{ category: string }> } }> }>;
  let nativeFetch: typeof fetch;

  beforeEach(() => {
    vi.resetModules();
    calls = [];
    bodies = [];
    nativeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (target.startsWith(DSN)) bodies.push(JSON.parse(String(init?.body)));
      else calls.push(target);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", nativeFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** The breadcrumb categories of an error captured now. */
  async function crumbs(entry: { captureException(e: Error): string; flush(): Promise<boolean> }) {
    bodies.length = 0;
    entry.captureException(new Error("x"));
    await entry.flush();
    return (bodies[0]?.events[0]?.event?.breadcrumbs ?? []).map((b) => b.category);
  }

  it("fetch: a library's patch over ours keeps working after close, and the next init records each request once", async () => {
    const browser = await import("../../browser/index");
    browser.init({ dsn: DSN, clientKey: "k", browserTracing: false, trackNavigation: false });
    const ours = globalThis.fetch;
    const library = vi.fn((input: RequestInfo | URL, init?: RequestInit) => ours(input, init));
    globalThis.fetch = library as unknown as typeof fetch;
    await fetch("https://api.example.test/a");
    expect(await crumbs(browser)).toEqual(["fetch"]);

    browser.close();
    expect(globalThis.fetch).toBe(library);
    await fetch("https://api.example.test/b");
    expect(calls).toEqual(["https://api.example.test/a", "https://api.example.test/b"]);
    browser.init({ dsn: DSN, clientKey: "k2", browserTracing: false, trackNavigation: false });
    expect(await crumbs(browser)).toEqual([]);
    await fetch("https://api.example.test/c");
    expect(await crumbs(browser)).toEqual(["fetch"]);
    expect(calls).toHaveLength(3);
    browser.close();
  });

  it("XHR: a patch over ours keeps working after close, and the next init records each request once", async () => {
    const browser = await import("../../browser/index");
    const request = (url: string) =>
      new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("loadend", () => resolve());
        xhr.open("GET", url);
        xhr.send();
      });
    const nativeSend = XMLHttpRequest.prototype.send;
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (this: XMLHttpRequest) {
      queueMicrotask(() => this.dispatchEvent(new Event("loadend")));
    });
    browser.init({ dsn: DSN, clientKey: "k", browserTracing: false, trackNavigation: false });
    // A library patches `open` and `send` over ours: neither is on top at close.
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    let opened = 0;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      opened++;
      return (open as (...a: unknown[]) => void).apply(this, args);
    } as typeof open;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      return send.call(this, body);
    };
    await request("https://api.example.test/a");
    expect(await crumbs(browser)).toEqual(["xhr"]);
    browser.close();
    await request("https://api.example.test/b");
    expect(opened).toBe(2);
    browser.init({ dsn: DSN, clientKey: "k2", browserTracing: false, trackNavigation: false });
    expect(await crumbs(browser)).toEqual([]);
    await request("https://api.example.test/c");
    expect(await crumbs(browser)).toEqual(["xhr"]);
    browser.close();
    expect(nativeSend).toBeDefined();
  });

  it("history: the pageload tracing's patch under another one ends without starting a navigation, and restores when on top", async () => {
    const { startBrowserTracing } = await import("../../tracing/browser");
    (await import("../index")).init({ dsn: DSN, clientKey: "k", tracesSampleRate: 1 });
    const nativePush = history.pushState;
    const stop = startBrowserTracing();
    const ours = history.pushState;
    expect(ours).not.toBe(nativePush);
    const outer = vi.fn((...args: Parameters<History["pushState"]>) => ours.apply(history, args));
    history.pushState = outer as unknown as History["pushState"];
    stop();
    expect(history.pushState).toBe(outer);
    history.pushState({}, "", "/moved");
    expect(outer).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe("/moved");
    // The patch that ended starts no navigation transaction.
    expect((await import("../../tracing/context")).getActiveSpan()).toBeUndefined();
    history.pushState = nativePush;

    const again = startBrowserTracing();
    expect(history.pushState).not.toBe(nativePush);
    again();
    expect(history.pushState).toBe(nativePush);
  });
});

// @vitest-environment jsdom
/**
 * `init`, `close`, `init` in the browser entries: one of everything each time, against a capture server on 127.0.0.1.
 * Events, breadcrumbs and spans are counted exactly: a listener or a patch left behind by the first `init` shows as a
 * double in the second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, settle, until, type FakeServer } from "./helpers/fake-server";

let server: FakeServer;
beforeEach(async () => {
  vi.resetModules();
  server = await startServer();
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

const xhr = (url: string) =>
  new Promise<void>((resolve) => {
    const request = new XMLHttpRequest();
    request.addEventListener("loadend", () => resolve());
    request.open("GET", url);
    request.send();
  });

/** The kinds of breadcrumb in an error event, in order. */
const crumbs = (event: { breadcrumbs: Array<{ category?: string; message?: string }> }) => event.breadcrumbs.map((b) => b.category);

describe("/browser", () => {
  /** One round of work: a click, a fetch and an XHR (each a breadcrumb and a span), a captured error and a thrown one. */
  async function round(browser: typeof import("../browser/index"), prefix: string) {
    document.body.click();
    await (await fetch(`${server.url}/ping`)).text();
    await xhr(`${server.url}/ping`);
    browser.captureException(new Error(`captured ${prefix}`));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error(`thrown ${prefix}`), message: `thrown ${prefix}` }));
    expect(await browser.flush()).toBe(true);
  }

  it("starts clean after close: one error handler, one click breadcrumb, one fetch span, one pageload, the new config", async () => {
    const browser = await import("../browser/index");
    const nativeFetch = globalThis.fetch;
    const nativeOpen = XMLHttpRequest.prototype.open;
    const config = (n: number) => ({ dsn: `${server.url}/p${n}`, clientKey: `osk_${n}`, environment: `env${n}`, release: `r${n}`, tracesSampleRate: 1 });

    browser.init(config(1));
    browser.init(config(9)); // a second init before close is ignored
    expect(browser.isOverseerInitialized()).toBe(true);
    await round(browser, "one");
    browser.close();
    expect(browser.isOverseerInitialized()).toBe(false);
    expect(globalThis.fetch).toBe(nativeFetch);
    expect(XMLHttpRequest.prototype.open).toBe(nativeOpen);
    await until(() => server.transactions("/p1").length === 1, "the pageload transaction of the first init");

    browser.init(config(2));
    expect(browser.isOverseerInitialized()).toBe(true);
    await round(browser, "two");
    browser.close();
    await until(() => server.transactions("/p2").length === 1, "the pageload transaction of the second init");
    await settle();

    expect(server.received.some((r) => r.path.startsWith("/p9"))).toBe(false);
    for (const [n, word] of [[1, "one"], [2, "two"]] as const) {
      const errors = server.errors(`/p${n}`);
      expect(errors.map((e) => e.message).sort()).toEqual([`captured ${word}`, `thrown ${word}`]);
      for (const event of errors) {
        expect(crumbs(event)).toEqual(["ui.click", "fetch", "xhr"]);
        expect(event.environment).toBe(`env${n}`);
        expect(event.release).toBe(`r${n}`);
      }
      const [tx, ...more] = server.transactions(`/p${n}`);
      expect(more).toEqual([]);
      expect(tx.op).toBe("pageload");
      expect(tx.spans.map((s: { op: string }) => s.op)).toEqual(["http.client", "http.client"]);
      expect(server.received.filter((r) => r.path === `/p${n}/ingest`).every((r) => r.headers["x-overseer-key"] === `osk_${n}`)).toBe(true);
    }
    // The client of the first init got nothing from the second round.
    expect(server.events("/p1").length).toBe(3);
    expect(server.events("/p2").length).toBe(3);
  });

  it("sends a capture made after close and before the next init once, and starts no handler", async () => {
    const browser = await import("../browser/index");
    browser.init({ dsn: `${server.url}/p1`, clientKey: "osk_1", captureConsoleErrors: true, browserTracing: false });
    browser.close();
    browser.captureException(new Error("between"));
    await browser.flush();
    await until(() => server.errors("/p1").length === 1, "the capture between");
    await settle();
    expect(server.errors("/p1").map((e) => e.message)).toEqual(["between"]);
    // The closed client no longer hears the page.
    const seen = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener("error", seen);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("late"), message: "late", cancelable: true }));
    window.removeEventListener("error", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    await browser.flush();
    await settle();
    expect(server.errors("/p1")).toHaveLength(1);
  });

  it("puts console.error back, and a console patch over it stays working while its own undo does nothing", async () => {
    const original = vi.spyOn(console, "error").mockImplementation(() => {});
    const browser = await import("../browser/index");
    browser.init({ dsn: `${server.url}/p1`, clientKey: "osk_1", captureConsoleErrors: true, browserTracing: false, trackRequests: false });
    expect(console.error).not.toBe(original);
    browser.close();
    expect(console.error).toBe(original);
    browser.init({ dsn: `${server.url}/p2`, clientKey: "osk_2", captureConsoleErrors: true, browserTracing: false, trackRequests: false });
    console.error("hello");
    expect(original).toHaveBeenCalledTimes(1);
    await browser.flush();
    await until(() => server.events("/p2").length === 1, "the console error");
    await settle();
    expect(server.events("/p1")).toHaveLength(0);
    expect(server.events("/p2")).toHaveLength(1);
    browser.close();
    expect(console.error).toBe(original);
  });
});

describe("close ends the core client", () => {
  it.each(["browser", "nextjs", "remix"] as const)("/%s", async (entry) => {
    const mod = entry === "browser" ? await import("../browser/index") : entry === "nextjs" ? await import("../nextjs/index") : await import("../remix/index");
    const { getClient } = await import("../overseer/index");
    mod.init({ dsn: `${server.url}/p1`, clientKey: "osk_1" });
    const closed = vi.spyOn(getClient()!, "close");
    mod.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("two copies of the SDK on one page", () => {
  const loadTwo = async () => {
    const first = await import("../browser/index");
    vi.resetModules();
    const second = await import("../browser/index");
    expect(second).not.toBe(first);
    return [first, second] as const;
  };

  it.each([
    ["first copy first", 0],
    ["second copy first", 1],
  ])("console.error: %s", async (_name, closeFirst) => {
    const original = vi.spyOn(console, "error").mockImplementation(() => {});
    const copies = await loadTwo();
    copies.forEach((copy, i) => copy.init({ dsn: `${server.url}/c${i}`, clientKey: `osk_${i}`, captureConsoleErrors: true, browserTracing: false, trackRequests: false, trackClicks: false }));

    console.error("both");
    expect(original).toHaveBeenCalledTimes(1);
    copies[closeFirst]!.close();
    console.error("one left");
    expect(original).toHaveBeenCalledTimes(2);
    await Promise.all(copies.map((copy) => copy.flush()));
    const other = 1 - closeFirst;
    await until(() => server.events(`/c${other}`).length === 2 && server.events(`/c${closeFirst}`).length === 1, "the console errors");
    await settle();
    expect(server.events(`/c${closeFirst}`).map((e) => e.message)).toEqual(["both"]);
    expect(server.events(`/c${other}`).map((e) => e.message)).toEqual(["both", "one left"]);

    copies[other]!.close();
    console.error("none left");
    expect(original).toHaveBeenCalledTimes(3);
    await settle();
    expect(server.events("/c0").length + server.events("/c1").length).toBe(3);
    // Closed in this order, the one that was on top went back to the first copy's wrapper, which only passes calls on.
    if (closeFirst === 1) expect(console.error).toBe(original);
  });
});

describe("/nextjs", () => {
  it("starts clean after close: one route breadcrumb per move, one error handler, the new config", async () => {
    const next = await import("../nextjs/index");
    const original = history.pushState;
    const config = (n: number) => ({ dsn: `${server.url}/p${n}`, clientKey: `osk_${n}`, environment: `env${n}` });
    next.init(config(1));
    next.init(config(9));
    history.pushState({}, "", "/one");
    next.captureException(new Error("captured one"));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown one"), message: "thrown one" }));
    await next.flush();
    next.close();
    expect(next.isOverseerInitialized()).toBe(false);
    expect(history.pushState).toBe(original);

    next.init(config(2));
    history.pushState({}, "", "/two");
    next.captureException(new Error("captured two"));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown two"), message: "thrown two" }));
    await next.flush();
    next.close();
    await until(() => server.errors("/p1").length === 2 && server.errors("/p2").length === 2, "the errors");
    await settle();

    expect(server.received.some((r) => r.path.startsWith("/p9"))).toBe(false);
    for (const n of [1, 2]) {
      const errors = server.errors(`/p${n}`);
      expect(errors).toHaveLength(2);
      for (const event of errors) {
        expect(event.breadcrumbs.map((b: { message: string }) => b.message)).toEqual([expect.stringMatching(/^\//), `pushState /${n === 1 ? "one" : "two"}`]);
        expect(event.environment).toBe(`env${n}`);
      }
    }
    expect(history.pushState).toBe(original);
  });

  it.each([
    ["first copy first", 0],
    ["second copy first", 1],
  ])("two copies: history, %s", async (_name, closeFirst) => {
    const first = await import("../nextjs/index");
    vi.resetModules();
    const second = await import("../nextjs/index");
    const copies = [first, second];
    const original = history.pushState;
    copies.forEach((copy, i) => copy.init({ dsn: `${server.url}/c${i}`, clientKey: `osk_${i}` }));
    history.pushState({}, "", "/both");
    copies[closeFirst]!.close();
    history.pushState({}, "", "/one-left");
    const other = 1 - closeFirst;
    copies[other]!.captureException(new Error("x"));
    copies[closeFirst]!.captureException(new Error("y"));
    await Promise.all(copies.map((copy) => copy.flush()));
    await until(() => server.errors("/c0").length === 1 && server.errors("/c1").length === 1, "the errors");
    const moves = (i: number) => server.errors(`/c${i}`)[0].breadcrumbs.map((b: { message: string }) => b.message).filter((m: string) => m.startsWith("pushState "));
    expect(moves(other)).toEqual(["pushState /both", "pushState /one-left"]);
    expect(moves(closeFirst)).toEqual(["pushState /both"]);
    copies[other]!.close();
    expect(window.location.pathname).toBe("/one-left");
    if (closeFirst === 1) expect(history.pushState).toBe(original);
  });
});

describe("/remix", () => {
  it("starts clean after close: setupBrowserTracking's handlers and route breadcrumbs end, the new config", async () => {
    const remix = await import("../remix/index");
    const original = history.pushState;
    const config = (n: number) => ({ dsn: `${server.url}/p${n}`, clientKey: `osk_${n}`, environment: `env${n}` });
    remix.init(config(1));
    remix.init(config(9));
    remix.setupBrowserTracking();
    history.pushState({}, "", "/one");
    remix.captureException(new Error("captured one"));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown one"), message: "thrown one" }));
    await remix.flush();
    remix.close();
    expect(remix.isOverseerInitialized()).toBe(false);
    expect(history.pushState).toBe(original);

    remix.init(config(2));
    remix.setupBrowserTracking();
    history.pushState({}, "", "/two");
    remix.captureException(new Error("captured two"));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown two"), message: "thrown two" }));
    await remix.flush();
    remix.close();
    await until(() => server.errors("/p1").length === 2 && server.errors("/p2").length === 2, "the errors");
    await settle();

    expect(server.received.some((r) => r.path.startsWith("/p9"))).toBe(false);
    for (const n of [1, 2]) {
      const errors = server.errors(`/p${n}`);
      expect(errors).toHaveLength(2);
      for (const event of errors) {
        expect(event.breadcrumbs.map((b: { message: string }) => b.message)).toEqual([expect.stringMatching(/^\//), `pushState /${n === 1 ? "one" : "two"}`]);
        expect(event.environment).toBe(`env${n}`);
      }
    }
  });
});

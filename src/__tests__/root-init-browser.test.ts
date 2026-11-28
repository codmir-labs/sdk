// @vitest-environment jsdom
/**
 * `init` from `@codmir/sdk` catches uncaught errors and unhandled rejections in a browser, with the two listeners
 * `@codmir/sdk/browser` installs, and nothing else. Each entry is loaded fresh, so a listener a test leaves behind
 * cannot reach the next one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Root = typeof import("../index");
type Browser = typeof import("../browser/index");

let bodies: Array<{ events: Array<{ type: string; event: any }> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
beforeEach(() => {
  vi.resetModules();
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const load = async () => ({ root: (await import("../index")) as Root, browser: (await import("../browser/index")) as Browser });
const events = () => bodies.flatMap((b) => b.events).filter((e) => e.type === "error");
const throwError = (message: string) => window.dispatchEvent(new ErrorEvent("error", { error: new Error(message), message }));
const reject = (reason: unknown) => {
  const event = new Event("unhandledrejection") as Event & { reason?: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
};
/** A listener of the page's own for the test that dispatches an error nobody should capture: jsdom reports an unhandled one. */
const absorb = (e: Event) => e.preventDefault();
beforeEach(() => window.addEventListener("error", absorb));
afterEach(() => window.removeEventListener("error", absorb));
const config = { clientKey: "osk_test" };

describe("root init in a browser", () => {
  it("captures an uncaught error once, with the frame of the event", async () => {
    const { root } = await load();
    root.init(config);
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "https://app.example.com/main.js", lineno: 12, colno: 5 }));
    expect(await root.flush()).toBe(true);
    expect(events()).toHaveLength(1);
    expect(events()[0].event.message).toBe("boom");
    expect(events()[0].event.exception.stacktrace[0]).toMatchObject({ lineno: 12, colno: 5 });
    await root.close();
  });

  it("captures an error object with its own message", async () => {
    const { root } = await load();
    root.init(config);
    throwError("own error");
    await root.flush();
    expect(events().map((e) => e.event.message)).toEqual(["own error"]);
    await root.close();
  });

  it("captures an unhandled rejection once", async () => {
    const { root } = await load();
    root.init(config);
    reject(new Error("rejected"));
    await root.flush();
    expect(events().map((e) => e.event.message)).toEqual(["rejected"]);
    await root.close();
  });

  it("adds nothing else: no click breadcrumb, no fetch patch, no console patch", async () => {
    const { root } = await load();
    const nativeFetch = globalThis.fetch;
    const nativeError = console.error;
    root.init(config);
    expect(globalThis.fetch).toBe(nativeFetch);
    expect(console.error).toBe(nativeError);
    document.body.click();
    throwError("after click");
    await root.flush();
    expect(events()[0].event.breadcrumbs ?? []).toEqual([]);
    await root.close();
  });

  it("a second init adds no second listener", async () => {
    const { root } = await load();
    root.init(config);
    root.init(config);
    throwError("twice");
    await root.flush();
    expect(events()).toHaveLength(1);
    await root.close();
  });

  it("close removes the listeners, and a later init puts them back", async () => {
    const { root } = await load();
    root.init(config);
    await root.close();
    throwError("after close");
    reject(new Error("rejected after close"));
    await root.flush();
    expect(events()).toHaveLength(0);

    root.init(config);
    throwError("after reinit");
    await root.flush();
    expect(events().map((e) => e.event.message)).toEqual(["after reinit"]);
    await root.close();
  });
});

describe("root init and browser init together", () => {
  for (const order of ["root first", "browser first"] as const) {
    it(`${order}: one event per error and per rejection`, async () => {
      const { root, browser } = await load();
      if (order === "root first") {
        root.init(config);
        browser.init(config);
      } else {
        browser.init(config);
        root.init(config);
      }
      throwError("one error");
      reject(new Error("one rejection"));
      await root.flush();
      expect(events().map((e) => e.event.message).sort()).toEqual(["one error", "one rejection"]);
      browser.close();
      await root.close();
    });
  }

  it("after both close, no error is captured, and the guard is free for the next init", async () => {
    const { root, browser } = await load();
    root.init(config);
    browser.init(config);
    browser.close();
    await root.close();
    throwError("after both");
    await root.flush();
    expect(events()).toHaveLength(0);

    browser.init(config);
    throwError("browser again");
    await browser.flush();
    expect(events().map((e) => e.event.message)).toEqual(["browser again"]);
    browser.close();
  });
});

describe("debug line", () => {
  it("logs once that /browser adds more, even across two inits", async () => {
    const { root } = await load();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    root.init({ ...config, debug: true });
    root.init({ ...config, debug: true });
    const lines = log.mock.calls.filter((call) => String(call[1]).includes("@codmir/sdk/browser adds"));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][1])).toMatch(/breadcrumbs, request and navigation tracking, and tracing/);
    await root.close();
  });

  it("is silent without debug", async () => {
    const { root } = await load();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    root.init(config);
    expect(log.mock.calls.filter((call) => String(call[1]).includes("@codmir/sdk/browser adds"))).toHaveLength(0);
    await root.close();
  });
});

describe("a window that cannot listen", () => {
  it("installs nothing and does not throw", async () => {
    const { root } = await load();
    vi.stubGlobal("window", {});
    expect(() => root.init({ ...config, debug: true })).not.toThrow();
    await expect(root.close()).resolves.toBe(true);
  });
});

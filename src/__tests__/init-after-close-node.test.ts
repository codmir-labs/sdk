/**
 * `init`, `close`, `init` in the server and React Native entries, and every entry in a runtime without `location`:
 * React Native (both shapes of `window`), a worker and plain Node. A capture server on 127.0.0.1 counts what arrives.
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

describe("/express", () => {
  it("starts clean after close: one fetch span per request, the new config, fetch put back", async () => {
    const express = await import("../express/index");
    const { startTransaction, withActiveSpan } = await import("../tracing/index");
    const nativeFetch = globalThis.fetch;
    const config = (n: number) => ({ dsn: `${server.url}/p${n}`, clientKey: `osk_${n}`, environment: `env${n}`, tracesSampleRate: 1 });

    for (const n of [1, 2]) {
      express.init(config(n));
      express.init(config(9)); // ignored while open
      expect(globalThis.fetch).not.toBe(nativeFetch);
      const tx = startTransaction({ op: "http.server", name: `GET /${n}` });
      await withActiveSpan(tx, async () => {
        await (await fetch(`${server.url}/ping`)).text();
      });
      tx.end();
      express.captureException(new Error(`error ${n}`));
      expect(await express.flush()).toBe(true);
      express.close();
      expect(globalThis.fetch).toBe(nativeFetch);
      expect(express.isOverseerInitialized()).toBe(false);
      await until(() => server.errors(`/p${n}`).length === 1 && server.transactions(`/p${n}`).length === 1, "the error and the transaction");
    }
    await settle();
    expect(server.received.some((r) => r.path.startsWith("/p9"))).toBe(false);
    for (const n of [1, 2]) {
      expect(server.errors(`/p${n}`).map((e) => [e.message, e.environment])).toEqual([[`error ${n}`, `env${n}`]]);
      const [tx, ...more] = server.transactions(`/p${n}`);
      expect(more).toEqual([]);
      expect(tx.spans.map((s: { op: string }) => s.op)).toEqual(["http.client"]);
    }
  });
});

describe("/react-native", () => {
  const utils = () => {
    const state = { handler: vi.fn() as (error: Error, fatal?: boolean) => void };
    (globalThis as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: () => state.handler,
      setGlobalHandler: (handler: (error: Error, fatal?: boolean) => void) => {
        state.handler = handler;
      },
    };
    return state;
  };
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).ErrorUtils;
  });

  it("starts clean after close: one global handler, the app's own handler back, the new config", async () => {
    const rn = await import("../react-native/index");
    const state = utils();
    const app = state.handler as unknown as ReturnType<typeof vi.fn>;
    const config = (n: number) => ({ dsn: `${server.url}/p${n}`, clientKey: `osk_${n}`, environment: `env${n}` });

    for (const n of [1, 2]) {
      rn.init(config(n));
      rn.init(config(9));
      expect(state.handler).not.toBe(app);
      rn.trackScreenView(`Home ${n}`);
      state.handler(new Error(`thrown ${n}`), true);
      rn.captureException(new Error(`captured ${n}`));
      expect(await rn.flush()).toBe(true);
      rn.close();
      expect(state.handler).toBe(app);
      expect(rn.isOverseerInitialized()).toBe(false);
      await until(() => server.errors(`/p${n}`).length === 2, "the errors");
    }
    await settle();
    expect(app).toHaveBeenCalledTimes(2);
    expect(server.received.some((r) => r.path.startsWith("/p9"))).toBe(false);
    for (const n of [1, 2]) {
      const errors = server.errors(`/p${n}`);
      expect(errors.map((e) => e.message).sort()).toEqual([`captured ${n}`, `thrown ${n}`]);
      for (const event of errors) {
        expect(event.breadcrumbs.map((b: { message: string }) => b.message)).toEqual([`Screen: Home ${n}`]);
        expect(event.environment).toBe(`env${n}`);
      }
    }
  });

  it("leaves a handler another copy set over its own in place, and passes errors on", async () => {
    const rn = await import("../react-native/index");
    const state = utils();
    const app = state.handler as unknown as ReturnType<typeof vi.fn>;
    rn.init({ dsn: `${server.url}/p1`, clientKey: "osk_1" });
    const ours = state.handler;
    const other = vi.fn((error: Error, fatal?: boolean) => ours(error, fatal));
    state.handler = other;
    rn.close();
    expect(state.handler).toBe(other);
    state.handler(new Error("after"), false);
    expect(app).toHaveBeenCalledTimes(1);
    await settle();
    expect(server.errors("/p1")).toHaveLength(0);
  });

  it("runs without ErrorUtils", async () => {
    const rn = await import("../react-native/index");
    expect(() => rn.init({ dsn: `${server.url}/p1`, clientKey: "osk_1" })).not.toThrow();
    rn.captureException(new Error("x"));
    await rn.flush();
    rn.close();
    await until(() => server.errors("/p1").length === 1, "the error");
  });
});

/** The globals of a runtime that has no `window.location`; each returns what to remove again. */
const runtimes: Record<string, () => () => void> = {
  "React Native 0.72 (global.window = global)": () => {
    const g = globalThis as Record<string, unknown>;
    g.window = globalThis;
    Object.defineProperty(globalThis, "navigator", { value: { product: "ReactNative" }, configurable: true });
    return () => {
      delete g.window;
      delete g.navigator;
    };
  },
  "React Native 0.88 (globalThis.window defined)": () => {
    Object.defineProperty(globalThis, "window", { get: () => globalThis, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { product: "ReactNative" }, configurable: true });
    return () => {
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).navigator;
    };
  },
  "a window and a document without location, history or listeners": () => {
    const g = globalThis as Record<string, unknown>;
    g.window = { setTimeout };
    g.document = { readyState: "complete", referrer: "", visibilityState: "visible" };
    return () => {
      delete g.window;
      delete g.document;
    };
  },
  "a worker (self, no window)": () => {
    const g = globalThis as Record<string, unknown>;
    g.self = globalThis;
    g.importScripts = () => {};
    return () => {
      delete g.self;
      delete g.importScripts;
    };
  },
  "plain Node": () => () => {},
};

describe.each(Object.entries(runtimes))("without a location: %s", (_name, enter) => {
  let leave: () => void;
  beforeEach(() => {
    leave = enter();
  });
  afterEach(() => leave());

  const run = async (name: string, load: () => Promise<any>, extra: Record<string, unknown> = {}, after: (m: any) => void = () => {}) => {
    const entry = await load();
    const prefix = `/${name}`;
    expect(() => entry.init({ dsn: `${server.url}${prefix}`, clientKey: "osk_1", tracesSampleRate: 1, ...extra })).not.toThrow();
    after(entry);
    expect(() => entry.addBreadcrumb({ category: "app", message: "b" })).not.toThrow();
    expect(() => entry.captureException(new Error(`${name} captured`))).not.toThrow();
    expect(await entry.flush()).toBe(true);
    expect(() => entry.close()).not.toThrow();
    // Init again after close: the same, once.
    expect(() => entry.init({ dsn: `${server.url}${prefix}2`, clientKey: "osk_2", ...extra })).not.toThrow();
    entry.captureException(new Error(`${name} again`));
    await entry.flush();
    entry.close();
    return prefix;
  };

  it.each([
    ["browser", () => import("../browser/index"), {}],
    ["nextjs", () => import("../nextjs/index"), {}],
    ["remix", () => import("../remix/index"), {}],
    ["react-native", () => import("../react-native/index"), {}],
    ["express", () => import("../express/index"), {}],
  ])("/%s: init, capture, flush, close and init again never throw, and the dsn that is given is used", async (name, load, extra) => {
    const hasWindow = typeof window !== "undefined";
    const prefix = await run(name, load as () => Promise<unknown>, extra, (entry) => {
      if (name === "remix") expect(() => entry.setupBrowserTracking()).not.toThrow();
    });
    // /browser does not start where there is no window at all; every other entry does.
    if (name === "browser" && !hasWindow) {
      expect(server.received).toHaveLength(0);
      return;
    }
    await until(() => server.errors(prefix).length === 1 && server.errors(`${prefix}2`).length === 1, "both errors");
    const [event] = server.errors(prefix);
    // No location: no page context, no navigation breadcrumb.
    expect(event.request).toBeUndefined();
    expect((event.breadcrumbs as Array<{ category: string }>).map((b) => b.category)).toEqual(["app"]);
  });

  it("startBrowserTracing starts no pageload where there is no location, and its undo does nothing", async () => {
    const { startBrowserTracing } = await import("../tracing/browser");
    const stop = startBrowserTracing();
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("the patch runtime starts nothing and matches no page without a location", async () => {
    const { PatchRuntime } = await import("../overseer/patch-runtime");
    const runtime = new PatchRuntime({ dsn: server.url, environment: "x", overseerKey: "k", config: { enabled: true } });
    await expect(runtime.start()).resolves.toBeUndefined();
    runtime.stop();
    const matches = (pages?: string[]) => (runtime as unknown as { matchesCurrentPage(p: unknown): boolean }).matchesCurrentPage({ pages });
    expect(matches()).toBe(true);
    if (typeof window !== "undefined" && !(window as { location?: unknown }).location) expect(matches(["/*"])).toBe(false);
  });
});

describe("a window that has a location but lacks a document or a history", () => {
  const location = { href: "https://app.example.com/a?token=SECRET#frag", protocol: "https:", host: "app.example.com", pathname: "/a" };
  const listeners = { addEventListener() {}, removeEventListener() {} };
  const shapes: Record<string, () => () => void> = {
    "no document": () => {
      (globalThis as Record<string, unknown>).window = { location, history: { pushState() {}, replaceState() {} }, ...listeners };
      return () => delete (globalThis as Record<string, unknown>).window;
    },
    "no history": () => {
      const g = globalThis as Record<string, unknown>;
      g.window = { location, ...listeners };
      g.document = { readyState: "complete", referrer: "", visibilityState: "visible", ...listeners };
      return () => {
        delete g.window;
        delete g.document;
      };
    },
  };

  describe.each(Object.entries(shapes))("%s", (_name, enter) => {
    let leave: () => void;
    beforeEach(() => {
      leave = enter();
    });
    afterEach(() => leave());

    it.each([
      ["nextjs", () => import("../nextjs/index")],
      ["remix", () => import("../remix/index")],
    ])("/%s: init and the route breadcrumbs never throw, and keep origin and path only", async (name, load) => {
      const entry: any = await load();
      expect(() => entry.init({ dsn: `${server.url}/${name}`, clientKey: "osk_1" })).not.toThrow();
      if (name === "remix") expect(() => entry.setupBrowserTracking()).not.toThrow();
      entry.captureException(new Error("x"));
      await entry.flush();
      entry.close();
      await until(() => server.errors(`/${name}`).length === 1, "the error");
      const [event] = server.errors(`/${name}`);
      expect(event.request).toEqual({ url: "https://app.example.com/a" });
      expect(event.breadcrumbs.map((b: { message: string }) => b.message)).toEqual(["/a"]);
      expect(JSON.stringify(event)).not.toContain("SECRET");
    });

    it("/browser: init with tracing on never throws and starts a pageload only where it can", async () => {
      const browser = await import("../browser/index");
      expect(() => browser.init({ dsn: `${server.url}/browser`, clientKey: "osk_1", tracesSampleRate: 1, browserTracing: true })).not.toThrow();
      browser.captureException(new Error("x"));
      await browser.flush();
      expect(() => browser.close()).not.toThrow();
      await until(() => server.errors("/browser").length === 1, "the error");
    });

    it("startBrowserTracing and its undo never throw", async () => {
      const { startBrowserTracing } = await import("../tracing/browser");
      const stop = startBrowserTracing();
      expect(() => stop()).not.toThrow();
    });
  });

  it("the patch runtime starts nothing without a document, though the manifest has a patch", async () => {
    const { PatchRuntime } = await import("../overseer/patch-runtime");
    const runtime = new PatchRuntime({ dsn: server.url, environment: "x", overseerKey: "k", config: { enabled: true } });
    vi.spyOn(runtime as unknown as { loadManifest(): Promise<void> }, "loadManifest").mockImplementation(async function (this: unknown) {
      (this as { manifest: unknown }).manifest = { version: 1, patches: [{ id: "p", type: "css", css: "a{}" }] };
    });
    const leave = shapes["no document"]!();
    try {
      await expect(runtime.start()).resolves.toBeUndefined();
      expect((runtime as unknown as { pollTimer: unknown }).pollTimer).toBeNull();
    } finally {
      runtime.stop();
      leave();
    }
  });
});

// @vitest-environment jsdom
/**
 * A crash an integration captures is sent as unhandled, under its own mechanism, and at `fatal` when the platform says
 * so. The note rides on a symbol key of the context: it never reaches `extra`, and a caller's own `handled` or
 * `mechanism` keys stay data. Everything is read from the body `fetch` was given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as browser from "../../browser/index";
import * as express from "../../express/index";
import * as nextjs from "../../nextjs/index";
import * as reactNative from "../../react-native/index";
import { captureException, close, flush, init } from "../index";

type Wire = { level: string; tags: Record<string, string>; exception: { mechanism: { type: string; handled: boolean } }; extra: Record<string, unknown> };

let bodies: string[];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, req: RequestInit) => {
      bodies.push(String(req.body));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  close();
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).ErrorUtils;
});

const config = { clientKey: "osk_test", dsn: "https://ingest.example.com/api/overseer", environment: "test", includeSourceContext: false, rateLimit: false } as const;

/** The error events on the wire, parsed. */
async function sent(): Promise<Wire[]> {
  await flush();
  return bodies.flatMap((b) => (JSON.parse(b).events as Array<{ type: string; event: Wire }>).filter((e) => e.type === "error").map((e) => e.event));
}

describe("browser", () => {
  it("a window error is { onerror, unhandled } at level error, with none of those keys in extra", async () => {
    browser.init(config);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), message: "boom", filename: "app.js", lineno: 3, colno: 7 }));
    const [event] = await sent();
    expect(event!.exception.mechanism).toEqual({ type: "onerror", handled: false });
    expect(event!.level).toBe("error");
    expect(event!.extra).toMatchObject({ filename: "app.js", lineno: 3, colno: 7 });
    for (const key of ["handled", "mechanism", "fatal"]) expect(event!.extra).not.toHaveProperty(key);
    browser.close();
  });

  it("an unhandled rejection is { onunhandledrejection, unhandled }", async () => {
    browser.init(config);
    const event = new Event("unhandledrejection");
    Object.assign(event, { reason: new Error("nope"), promise: Promise.resolve() });
    window.dispatchEvent(event);
    const [sentEvent] = await sent();
    expect(sentEvent!.exception.mechanism).toEqual({ type: "onunhandledrejection", handled: false });
    expect(sentEvent!.level).toBe("error");
    for (const key of ["handled", "mechanism", "fatal"]) expect(sentEvent!.extra).not.toHaveProperty(key);
    browser.close();
  });
});

describe("react-native global handler", () => {
  const install = () => {
    const state = { handler: vi.fn() as (error: Error, fatal?: boolean) => void };
    (globalThis as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: () => state.handler,
      setGlobalHandler: (handler: (error: Error, fatal?: boolean) => void) => {
        state.handler = handler;
      },
    };
    return state;
  };

  it("isFatal true: level fatal, its own mechanism, unhandled", async () => {
    const state = install();
    reactNative.init(config);
    state.handler(new Error("crash"), true);
    const [event] = await sent();
    expect(event!.level).toBe("fatal");
    expect(event!.exception.mechanism).toEqual({ type: "global-error-handler", handled: false });
    for (const key of ["handled", "mechanism", "fatal"]) expect(event!.extra).not.toHaveProperty(key);
    reactNative.close();
  });

  it("isFatal false: level error, unhandled", async () => {
    const state = install();
    reactNative.init(config);
    state.handler(new Error("soft"), false);
    const [event] = await sent();
    expect(event!.level).toBe("error");
    expect(event!.exception.mechanism).toEqual({ type: "global-error-handler", handled: false });
    reactNative.close();
  });
});

describe("server integrations", () => {
  it("Next.js onRequestError (captureRouterError) gives nextjs-router, unhandled", async () => {
    nextjs.init(config);
    await nextjs.captureRouterError(
      new Error("render") as never,
      { path: "/dash", method: "GET", headers: {} },
      { routerKind: "App Router", routePath: "/dash", routeType: "render" } as never,
    );
    const [event] = await sent();
    expect(event!.exception.mechanism).toEqual({ type: "nextjs-router", handled: false });
    expect(event!.extra).toMatchObject({ routerKind: "App Router" });
    expect(event!.tags).toMatchObject({ route: "/dash" });
    expect(event!.extra).not.toHaveProperty("mechanism");
    nextjs.close();
  });

  it("Next.js captureRequestError gives server, unhandled", async () => {
    nextjs.init(config);
    nextjs.captureRequestError(new Error("api") as never, { routerKind: "App Router", routePath: "/api/x", routeType: "route" } as never);
    const [event] = await sent();
    expect(event!.exception.mechanism).toEqual({ type: "server", handled: false });
    expect(event!.tags).toMatchObject({ route: "/api/x" });
    expect(event!.extra).not.toHaveProperty("mechanism");
    nextjs.close();
  });

  it("Express errorHandler gives express-error-handler, unhandled", async () => {
    express.init(config);
    express.errorHandler()(new Error("route"), { method: "GET", url: "/a", originalUrl: "/a", path: "/a", headers: {}, route: { path: "/a" } } as never, {} as never, () => undefined);
    const [event] = await sent();
    expect(event!.exception.mechanism).toEqual({ type: "express-error-handler", handled: false });
    expect(event!.level).toBe("error");
    expect(event!.tags).toMatchObject({ route: "/a" });
    expect(event!.extra).not.toHaveProperty("mechanism");
    express.close();
  });
});

describe("a caller's own capture", () => {
  it("a plain captureException stays generic, handled, level error", async () => {
    init(config);
    captureException(new Error("x"));
    const [event] = await sent();
    expect(event!.exception.mechanism).toEqual({ type: "generic", handled: true });
    expect(event!.level).toBe("error");
  });

  it("its own handled and mechanism keys stay in extra and change nothing", async () => {
    init(config);
    captureException(new Error("x"), { handled: false, mechanism: "mine" });
    const [event] = await sent();
    expect(event!.extra).toMatchObject({ handled: false, mechanism: "mine" });
    expect(event!.exception.mechanism).toEqual({ type: "generic", handled: true });
    expect(event!.level).toBe("error");
  });

  it("a look-alike string key does not act as the hint", async () => {
    init(config);
    captureException(new Error("x"), { "codmir.capture.hint": { mechanism: { type: "fake", handled: false }, level: "fatal" } });
    const [event] = await sent();
    expect(event!.exception.mechanism).toEqual({ type: "generic", handled: true });
    expect(event!.level).toBe("error");
  });
});

describe("the wire", () => {
  it("holds no hint symbol or hint object, only the event's own mechanism and level", async () => {
    const state = { handler: vi.fn() as (error: Error, fatal?: boolean) => void };
    (globalThis as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: () => state.handler,
      setGlobalHandler: (handler: (error: Error, fatal?: boolean) => void) => {
        state.handler = handler;
      },
    };
    reactNative.init(config);
    state.handler(new Error("crash"), true);
    await sent();
    const text = bodies.join("\n");
    expect(text).not.toContain("codmir.capture.hint");
    expect(text).not.toContain("Symbol");
    // The only places the mechanism and the level appear are the event's own fields.
    expect(text.match(/"global-error-handler"/g)).toHaveLength(1);
    expect(text.match(/"handled"/g)).toHaveLength(1);
    // The level is the event's own and the group summary's, which copies it.
    expect(text.match(/"fatal"/g)).toHaveLength(2);
    expect(JSON.parse(bodies[0]!).events[0].event.level).toBe("fatal");
    expect(JSON.parse(bodies[0]!).events[0].group.level).toBe("fatal");
    reactNative.close();
  });
});

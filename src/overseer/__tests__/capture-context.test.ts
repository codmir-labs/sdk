// @vitest-environment jsdom
/**
 * `captureException`'s second argument sets the event's tags, level, fingerprint, user and contexts when it is a capture
 * context, and is `extra` as a whole when it is anything else. The integrations send the route as the tag `route` and the
 * React component stack as `contexts.react.componentStack`. Everything is read from the body `fetch` was given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as express from "../../express/index";
import * as nextjs from "../../nextjs/index";
import * as reactNative from "../../react-native/index";
import { captureException, close, flush, getClient, init, setUser } from "../index";
import { crash, withHint } from "../capture-hint";

type Wire = {
  level: string;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
  fingerprint?: string[];
  user?: Record<string, unknown>;
  contexts: Record<string, Record<string, unknown> | undefined>;
  exception: { mechanism: { type: string; handled: boolean } };
};

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
});

const config = { clientKey: "osk_test", dsn: "https://ingest.example.com/api/overseer", environment: "test", includeSourceContext: false, rateLimit: false } as const;

/** The error events on the wire, parsed. */
async function sent(): Promise<Wire[]> {
  await flush();
  return bodies.flatMap((b) => (JSON.parse(b).events as Array<{ type: string; event: Wire }>).filter((e) => e.type === "error").map((e) => e.event));
}

describe("a capture context", () => {
  it("sets tags, level, fingerprint and extra, and none of them is inside extra", async () => {
    init(config);
    captureException(new Error("card declined"), { tags: { checkout: "v2" }, level: "warning", fingerprint: ["x"], extra: { orderId: 7 } });
    const [event] = await sent();
    expect(event!.tags.checkout).toBe("v2");
    expect(event!.level).toBe("warning");
    expect(event!.fingerprint).toEqual(["x"]);
    expect(event!.extra.orderId).toBe(7);
    for (const key of ["tags", "level", "fingerprint", "extra"]) expect(event!.extra).not.toHaveProperty(key);
  });

  it("merges tags over the client's, as strings", async () => {
    init(config);
    getClient()!.setTags({ region: "eu", checkout: "v1" });
    captureException(new Error("a"), { tags: { checkout: "v2", attempt: 3, retry: false } });
    const [event] = await sent();
    expect(event!.tags).toMatchObject({ region: "eu", checkout: "v2", attempt: "3", retry: "false" });
  });

  it("a plain object stays extra, and the level stays error", async () => {
    init(config);
    captureException(new Error("a"), { orderId: 7, level: "warning" });
    const [event] = await sent();
    expect(event!.extra).toMatchObject({ orderId: 7, level: "warning" });
    expect(event!.level).toBe("error");
  });

  it("a wrong shape stays extra, and the event's user is unchanged", async () => {
    init(config);
    setUser({ id: "u1" });
    captureException(new Error("a"), { user: "bob" });
    captureException(new Error("b"), { tags: { nested: { a: 1 } }, level: "loud" });
    const [first, second] = await sent();
    expect(first!.extra.user).toBe("bob");
    expect(first!.user).toEqual({ id: "u1" });
    expect(second!.extra).toMatchObject({ tags: { nested: { a: 1 } }, level: "loud" });
    expect(second!.tags).toEqual({});
    expect(second!.level).toBe("error");
  });

  it("a hint's level is below a capture context's level and above error", async () => {
    init(config);
    captureException(new Error("a"), withHint({ level: "info" }, crash("x", "fatal")));
    captureException(new Error("b"), withHint({ tags: { k: "v" } }, crash("x", "fatal")));
    captureException(new Error("c"), withHint({ level: "debug" }, crash("x", "fatal")));
    const [plain, hinted, over] = await sent();
    expect(plain!.level).toBe("info");
    expect(hinted!.level).toBe("fatal");
    expect(hinted!.exception.mechanism).toEqual({ type: "x", handled: false });
    expect(hinted!.tags).toMatchObject({ k: "v" });
    expect(over!.level).toBe("debug");
  });

  describe("user", () => {
    it("is merged over setUser's; an email follows sendDefaultPii", async () => {
      for (const pii of [false, true]) {
        bodies = [];
        init({ ...config, sendDefaultPii: pii });
        setUser({ id: "u1", username: "ann" });
        captureException(new Error("a"), { user: { username: "bob", email: "bob@example.com" } });
        const [event] = await sent();
        expect(event!.user).toMatchObject({ id: "u1", username: "bob" });
        if (pii) expect(event!.user!.email).toBe("bob@example.com");
        else expect(event!.user).not.toHaveProperty("email");
        close();
      }
    });
  });

  it("contexts are merged over the environment's, and conversation and session stay the SDK's", async () => {
    init(config);
    captureException(new Error("a"), { contexts: { order: { id: 7 }, conversation: { id: "forged" }, session: { id: "forged" } } });
    const [event] = await sent();
    expect(event!.contexts.order).toEqual({ id: 7 });
    expect(Object.keys(event!.contexts).filter((k) => k !== "order").length).toBeGreaterThan(0);
    expect(event!.contexts.conversation).not.toEqual({ id: "forged" });
    expect(event!.contexts.session).not.toEqual({ id: "forged" });
  });

  it("a string fingerprint is a one-item list, and the per-group rate limit groups by it", async () => {
    init({ ...config, rateLimit: { perGroupPerMinute: 1 } });
    captureException(new Error("first"), { fingerprint: "same" });
    captureException(new Error("second"), { fingerprint: "same" });
    captureException(new Error("third"), { fingerprint: "other" });
    const events = await sent();
    expect(events.map((e) => e.fingerprint)).toEqual([["same"], ["other"]]);
  });
});

const expressReq = (route: string): never =>
  ({ method: "GET", url: "/users/5", originalUrl: "/users/5", path: "/users/5", baseUrl: "", headers: {}, route: { path: route } }) as never;

describe("integrations", () => {
  it("Express sends the route as tags.route and none in extra", async () => {
    express.init(config);
    express.errorHandler()(new Error("boom"), expressReq("/users/:id"), {} as never, () => undefined);
    const [event] = await sent();
    expect(event!.tags.route).toBe("/users/:id");
    expect(event!.extra).not.toHaveProperty("route");
    expect(event!.exception.mechanism).toEqual({ type: "express-error-handler", handled: false });
  });

  it("Next.js onRequestError sends tags.route as the route path", async () => {
    nextjs.init(config);
    await nextjs.captureRouterError(
      new Error("db timeout") as never,
      { path: "/orders/42?token=abc", method: "GET", headers: {} },
      { routerKind: "App Router", routePath: "/orders/[id]", routeType: "render" } as never,
    );
    const [event] = await sent();
    expect(event!.tags.route).toBe("/orders/[id]");
    expect(event!.extra).not.toHaveProperty("route");
    expect(event!.extra).not.toHaveProperty("routePath");
    expect(event!.extra).toMatchObject({ routerKind: "App Router", routeType: "render" });
    expect(event!.exception.mechanism).toEqual({ type: "nextjs-router", handled: false });
  });

  it("captureBoundaryError sends contexts.react.componentStack and keeps its hint", async () => {
    nextjs.init(config);
    nextjs.captureBoundaryError(new Error("render"), { componentStack: "\n    in Cart\n    in App" });
    const [event] = await sent();
    expect(event!.contexts.react).toEqual({ componentStack: "\n    in Cart\n    in App" });
    expect(event!.extra).not.toHaveProperty("componentStack");
    expect(event!.exception.mechanism).toEqual({ type: "nextjs-error-boundary", handled: false });
  });

  it("the React Native boundary sends contexts.react.componentStack and keeps its hint", async () => {
    init(config);
    class Component {
      constructor(public props: unknown) {}
    }
    const Boundary = reactNative.createErrorBoundary({ Component });
    const boundary = new Boundary({ fallback: null }) as unknown as { componentDidCatch(e: Error, info: { componentStack: string }): void };
    boundary.componentDidCatch(new Error("render"), { componentStack: "\n    in Cart\n    in App" });
    const [event] = await sent();
    expect(event!.contexts.react).toEqual({ componentStack: "\n    in Cart\n    in App" });
    expect(event!.extra).not.toHaveProperty("componentStack");
    expect(event!.exception.mechanism).toEqual({ type: "react-error-boundary", handled: false });
  });
});

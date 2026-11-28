// @vitest-environment jsdom
/**
 * The page listeners are one pair per page, whichever entries ran `init`: the root, `/browser`, `/nextjs` and `/remix`
 * share the two flags on `globalThis`, and the core `close` ends what any of them installed. Each entry is loaded fresh,
 * so a listener a test leaves behind cannot reach the next one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Root = typeof import("../index");
type Browser = typeof import("../browser/index");
type Next = typeof import("../nextjs/index");
type Remix = typeof import("../remix/index");

let bodies: Array<{ events: Array<{ type: string; event: any }> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FLAGS = [Symbol.for("codmir.page-errors.error"), Symbol.for("codmir.page-errors.unhandledrejection")];
const slots = globalThis as Record<symbol, unknown>;
let closers: Array<() => unknown>;

beforeEach(() => {
  vi.resetModules();
  bodies = [];
  closers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});
afterEach(async () => {
  for (const close of closers) await close();
  for (const flag of FLAGS) delete slots[flag];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const root = async () => {
  const m = (await import("../index")) as Root;
  closers.push(() => m.close());
  return m;
};
const browser = async () => {
  const m = (await import("../browser/index")) as Browser;
  closers.push(() => m.close());
  return m;
};
const next = async () => {
  const m = (await import("../nextjs/index")) as Next;
  closers.push(() => m.close());
  return m;
};
const remix = async () => {
  const m = (await import("../remix/index")) as Remix;
  closers.push(() => m.close());
  return m;
};

const events = () => bodies.flatMap((b) => b.events).filter((e) => e.type === "error").map((e) => e.event);
const throwError = (error: unknown, extra: ErrorEventInit = {}) => window.dispatchEvent(new ErrorEvent("error", { error, message: String((error as Error)?.message ?? error), ...extra }));
const reject = (reason: unknown) => {
  const event = new Event("unhandledrejection") as Event & { reason?: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
};
/** A listener of the page's own for the tests that dispatch an error nobody should capture: jsdom reports an unhandled one. */
const absorb = (e: Event) => e.preventDefault();
const pageWindow = window;
beforeEach(() => pageWindow.addEventListener("error", absorb));
afterEach(() => pageWindow.removeEventListener("error", absorb));
const config = { clientKey: "osk_test" };
/** Runs `a` then `b`, or `b` then `a`. */
const initBoth = (aFirst: boolean, a: () => void, b: () => void) => {
  if (aFirst) {
    a();
    b();
  } else {
    b();
    a();
  }
};
const flush = async () => (await import("../overseer/index")).flush();

describe("the root init and /nextjs on one page", () => {
  it.each(["root first", "next first"])("%s: one event per uncaught error and per unhandled rejection", async (order) => {
    const r = await root();
    const n = await next();
    initBoth(order === "root first", () => r.init(config), () => n.init(config));
    throwError(new Error("uncaught"));
    reject(new Error("rejected"));
    await flush();
    expect(events().map((e) => e.message).sort()).toEqual(["rejected", "uncaught"]);
  });

  it("an error its boundary already sent is not captured again, whichever init owns the listener", async () => {
    for (const order of ["root first", "next first"]) {
      bodies = [];
      const r = await root();
      const n = await next();
      initBoth(order === "root first", () => r.init(config), () => n.init(config));
      const seen = new Error(`seen by the boundary, ${order}`);
      const fresh = new Error(`fresh, ${order}`);
      const rejected = new Error(`rejected after the boundary, ${order}`);
      // The boundary sends it first and marks it; the window event for the same object comes after.
      n.captureBoundaryError(seen);
      n.captureBoundaryError(rejected);
      throwError(seen);
      throwError(fresh);
      reject(rejected);
      await flush();
      const messages = events().map((e) => e.message);
      expect(messages.filter((m) => m === seen.message), order).toHaveLength(1);
      expect(messages.filter((m) => m === rejected.message), order).toHaveLength(1);
      expect(messages.filter((m) => m === fresh.message), order).toHaveLength(1);
      await n.close();
      for (const flag of FLAGS) delete slots[flag];
      vi.resetModules();
    }
  });

  it("captureUnhandledErrors: false leaves the error listener out and the flag free; the rejection one stays", async () => {
    const n = await next();
    n.init({ ...config, captureUnhandledErrors: false });
    expect(slots[FLAGS[0]]).toBeUndefined();
    expect(slots[FLAGS[1]]).toBeDefined();
    throwError(new Error("ignored error"));
    reject(new Error("kept rejection"));
    await flush();
    expect(events().map((e) => e.message)).toEqual(["kept rejection"]);
    const b = await browser();
    b.init(config);
    throwError(new Error("browser error"));
    await flush();
    expect(events().map((e) => e.message)).toEqual(["kept rejection", "browser error"]);
  });

  it("captureUnhandledRejections: false leaves the rejection listener out and the flag free", async () => {
    const n = await next();
    n.init({ ...config, captureUnhandledRejections: false });
    expect(slots[FLAGS[1]]).toBeUndefined();
    expect(slots[FLAGS[0]]).toBeDefined();
    reject(new Error("ignored rejection"));
    await flush();
    expect(events()).toHaveLength(0);
  });
});

describe("the root init and Remix's setupBrowserTracking on one page", () => {
  it.each(["root first", "remix first"])("%s: one event per uncaught error and per unhandled rejection", async (order) => {
    const r = await root();
    const x = await remix();
    const initRemix = () => {
      x.init(config);
      x.setupBrowserTracking();
    };
    initBoth(order === "root first", () => r.init(config), initRemix);
    throwError(new Error("uncaught"));
    reject(new Error("rejected"));
    await flush();
    expect(events().map((e) => e.message).sort()).toEqual(["rejected", "uncaught"]);
  });

  it("its own close ends its listeners, and a second setupBrowserTracking before it is ignored", async () => {
    const x = await remix();
    x.init(config);
    x.setupBrowserTracking();
    x.setupBrowserTracking();
    throwError(new Error("once"));
    await flush();
    expect(events()).toHaveLength(1);
    x.close();
    for (const flag of FLAGS) expect(slots[flag]).toBeUndefined();
  });
});

describe("what an event carries through /nextjs and /remix", () => {
  const place = { filename: "https://app.example.com/main.js", lineno: 12, colno: 5 };
  it.each(["next", "remix"])("%s: the message, the mechanism, the frame and now the file, line and column", async (entry) => {
    if (entry === "next") (await next()).init(config);
    else {
      const x = await remix();
      x.init(config);
      x.setupBrowserTracking();
    }
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", ...place }));
    reject("plain reason");
    await flush();
    const [error, rejection] = events();
    expect(error.message).toBe("boom");
    expect(error.exception.mechanism).toMatchObject({ type: "onerror", handled: false });
    expect(error.exception.stacktrace[0]).toMatchObject({ lineno: 12, colno: 5 });
    expect(error.extra).toMatchObject(place);
    expect(rejection.message).toBe("plain reason");
    expect(rejection.exception.mechanism).toMatchObject({ type: "onunhandledrejection", handled: false });
  });
});

describe("the core close", () => {
  it("after the root init, ends the listeners and frees both flags; a /browser init after it captures once", async () => {
    const r = await root();
    const core = await import("../overseer/index");
    r.init(config);
    expect(FLAGS.every((flag) => slots[flag] !== undefined)).toBe(true);
    await core.close();
    for (const flag of FLAGS) expect(slots[flag]).toBeUndefined();
    throwError(new Error("after close"));
    reject(new Error("after close"));
    await flush();
    expect(events()).toHaveLength(0);

    const b = await browser();
    b.init(config);
    throwError(new Error("again"));
    reject(new Error("again"));
    await flush();
    expect(events().map((e) => e.message)).toEqual(["again", "again"]);
  });

  it("ends a /nextjs listener too, and the entry's own close after it still works and is idempotent", async () => {
    const n = await next();
    const core = await import("../overseer/index");
    n.init(config);
    await core.close();
    for (const flag of FLAGS) expect(slots[flag]).toBeUndefined();
    expect(() => n.close()).not.toThrow();
    expect(() => n.close()).not.toThrow();
    const b = await browser();
    b.init(config);
    throwError(new Error("later"));
    await flush();
    expect(events().map((e) => e.message)).toEqual(["later"]);
  });

  it("an entry's own close after a core close is idempotent, and a later init of any entry installs its own once", async () => {
    const b = await browser();
    const r = await root();
    const core = await import("../overseer/index");
    b.init(config);
    await core.close();
    b.close();
    b.close();
    for (const flag of FLAGS) expect(slots[flag]).toBeUndefined();
    r.init(config);
    r.init(config);
    throwError(new Error("captured once"));
    await flush();
    expect(events().map((e) => e.message)).toEqual(["captured once"]);
  });
});

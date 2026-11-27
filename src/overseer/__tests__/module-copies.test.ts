/**
 * A bundler may load the SDK more than once in one process (Next.js: once for instrumentation, again for each route
 * layer), and only the copy that ran `init` has a client. Copy A here ran `init`; copy B never does. B's captures,
 * `setUser`, request scope and transactions must still reach A's client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Copy = {
  overseer: typeof import("../index");
  scope: typeof import("../request-scope");
  server: typeof import("../../tracing/server");
  tracing: typeof import("../../tracing/index");
  next: typeof import("../../nextjs/server");
};

async function loadCopy(): Promise<Copy> {
  vi.resetModules();
  return {
    overseer: await import("../index"),
    scope: await import("../request-scope"),
    server: await import("../../tracing/server"),
    tracing: await import("../../tracing/index"),
    next: await import("../../nextjs/server"),
  };
}

const CLIENT_SLOT = Symbol.for("codmir.overseer.client");
const slots = globalThis as Record<symbol, unknown>;
const DSN = "https://ingest.example.test/api/overseer";

type Wire = { type: string; name?: string; event?: { message?: string; user?: { id?: string } | null } };
let wire: Wire[];
let a: Copy;
let b: Copy;

const errors = (): Array<NonNullable<Wire["event"]>> => wire.filter((w) => w.type === "error").map((w) => w.event!);

beforeEach(async () => {
  wire = [];
  delete slots[CLIENT_SLOT];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      wire.push(...(JSON.parse(String(init?.body)) as { events: Wire[] }).events);
      return new Response("{}", { status: 200 });
    }),
  );
  a = await loadCopy();
  b = await loadCopy();
  expect(a.overseer).not.toBe(b.overseer);
});

afterEach(() => {
  a.overseer.close();
  b.overseer.close();
  delete slots[CLIENT_SLOT];
  vi.unstubAllGlobals();
});

const initA = (extra: Record<string, unknown> = {}): void => a.overseer.init({ dsn: DSN, clientKey: "osk_test", ...extra });

describe("a copy of the SDK that never ran init", () => {
  it("(a) captures through the client another copy made", async () => {
    initA();
    const id = b.overseer.captureException(new Error("x"));
    expect(id).not.toBe("");
    expect(b.overseer.captureMessage("hello")).not.toBe("");
    expect(await b.overseer.flush()).toBe(true);
    expect(errors().map((e) => e.message)).toContain("x");
    expect(wire.some((w) => w.type === "message")).toBe(true);
    expect(b.overseer.getClient()).toBe(a.overseer.getClient());
  });

  it("(b) sees a request scope opened in another copy, and the user stays inside it", async () => {
    initA();
    a.server.installNodeTracingContext();
    const aScope = { url: "https://app.example/a", method: "GET" };
    await a.scope.withRequestScope(aScope, async () => {
      await new Promise((r) => setTimeout(r));
      expect(b.scope.getRequestScope()).toBe(aScope);
      b.overseer.setUser({ id: "alice" });
      b.overseer.captureException(new Error("in a"));
    });

    // A scope opened by the copy that never ran init: the client is A's, the scope is B's.
    b.server.installNodeTracingContext();
    await b.scope.withRequestScope({ url: "https://app.example/b", method: "POST" }, async () => {
      await new Promise((r) => setTimeout(r));
      b.overseer.setUser({ id: "bob" });
      b.overseer.captureException(new Error("in b"));
    });

    b.overseer.captureException(new Error("outside"));
    await b.overseer.flush();
    const byMessage = Object.fromEntries(errors().map((e) => [e.message, e.user ?? null]));
    expect(byMessage["in a"]).toMatchObject({ id: "alice" });
    expect(byMessage["in b"]).toMatchObject({ id: "bob" });
    expect(byMessage["outside"]).toBeNull();
  });

  it("(c) sends a transaction it started", async () => {
    initA({ tracesSampleRate: 1 });
    await b.tracing.startSpan({ name: "from b", op: "function" }, async () => {});
    const handler = b.next.withCodmirTracing(async () => Response.json({ ok: true }), { route: "/api/x" });
    await handler(new Request("https://app.example/api/x"));
    await b.overseer.flush();
    const names = wire.filter((w) => w.type === "transaction").map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(["from b", "GET /api/x"]));
  });

  it("(d) captures nothing once the copy that ran init has closed, and the slot is empty", async () => {
    initA();
    a.overseer.close();
    expect(slots[CLIENT_SLOT]).toBeUndefined();
    expect(b.overseer.captureException(new Error("late"))).toBe("");
    expect(b.overseer.getClient()).toBeNull();
    await b.overseer.flush();
    expect(errors().map((e) => e.message)).not.toContain("late");
  });

  it("(e) ignores a foreign value in the slot", async () => {
    for (const foreign of [{}, { captureException: () => "id" }, { captureException: "no", [Symbol.for("codmir.overseer.client.marker")]: true }, "text", 7]) {
      slots[CLIENT_SLOT] = foreign;
      expect(() => b.overseer.captureException(new Error("x"))).not.toThrow();
      expect(b.overseer.captureException(new Error("x"))).toBe("");
      expect(() => b.overseer.setUser({ id: "u" })).not.toThrow();
      expect(b.overseer.getClient()).toBeNull();
      await expect(b.overseer.flush()).resolves.toBe(true);
    }
    expect(wire).toEqual([]);
  });

  it("(f) a copy that ran its own init keeps its own client", async () => {
    initA();
    b.overseer.init({ dsn: DSN, clientKey: "osk_b" });
    const own = b.overseer.getClient();
    expect(own).not.toBe(a.overseer.getClient());
    slots[CLIENT_SLOT] = a.overseer.getClient();
    expect(b.overseer.getClient()).toBe(own);
    b.overseer.captureException(new Error("from b"));
    expect(b.overseer.getClientKey()).toBe("osk_b");
  });

  it("closing one copy leaves the other copy's client in the slot", () => {
    initA();
    b.overseer.init({ dsn: DSN, clientKey: "osk_b" });
    // The slot now holds B's client (the later init); A closing must not empty it.
    expect(slots[CLIENT_SLOT]).toBe(b.overseer.getClient());
    a.overseer.close();
    expect(slots[CLIENT_SLOT]).toBe(b.overseer.getClient());
  });
});

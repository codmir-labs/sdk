/** On a serverless runtime the hooks send the event before they return, or hand the send to waitUntil. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, init } from "../../overseer/index";
import { flushInBackground } from "../../overseer/flush-in-background";
import { captureRouterError } from "../index";
import { withCodmirTracing } from "../server";

const INGEST = "https://ingest.example.test/api/overseer";
const SLOT = Symbol.for("@next/request-context");
const SERVERLESS_ENV = ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "K_SERVICE"];

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let answers: Array<() => void>;
let hold: boolean;

const request = { path: "/api/orders?x=1", method: "GET", headers: { host: "app.example.test" } };
const context = { routerKind: "App Router", routePath: "/api/orders", routeType: "route" } as never;
const sends = (type: string) =>
  calls.filter((c) => c.url.endsWith("/ingest")).filter((c) => String(c.init?.body).includes(`"type":"${type}"`));

beforeEach(() => {
  calls = [];
  answers = [];
  hold = false;
  for (const name of SERVERLESS_ENV) vi.stubEnv(name, "");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (!hold) return Promise.resolve(new Response("{}", { status: 200 }));
      return new Promise<Response>((resolve) => answers.push(() => resolve(new Response("{}", { status: 200 }))));
    }),
  );
  init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 1 });
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
  close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function settled(promise: Promise<unknown>): { done: boolean } {
  const state = { done: false };
  void promise.then(() => (state.done = true), () => (state.done = true));
  return state;
}

describe("captureRouterError", () => {
  it("(a) settles only after the event's request was made, and within about 2 s when fetch never answers", async () => {
    vi.useFakeTimers();
    hold = true;
    const returned = captureRouterError(new Error("boom"), request, context);
    const state = settled(returned);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].init?.body)).toContain("boom");
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2100);
    expect(state.done).toBe(true);
  });

  it("(b) hands the send to Next's waitUntil once and returns at once", async () => {
    hold = true;
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[SLOT] = { get: () => ({ waitUntil }) };
    await captureRouterError(new Error("boom"), request, context); // would hang on the held request if it awaited
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    answers.forEach((answer) => answer());
    await waitUntil.mock.calls[0][0];
    expect(String(calls[0].init?.body)).toContain("boom");
  });
});

describe("withCodmirTracing", () => {
  const handler = withCodmirTracing(async () => Response.json({ ok: true }), { route: "/api/orders" });
  const call = () => handler(new Request("http://app.example.test/api/orders"));

  it("(c) on a serverless runtime the transaction is sent before the wrapper's promise settles", async () => {
    vi.stubEnv("VERCEL", "1");
    await call();
    expect(sends("transaction")).toHaveLength(1);
  });

  it("(c) without a serverless marker there is no flush per request", async () => {
    await call();
    expect(calls).toHaveLength(0);
  });

  it("(c) a request with Next's waitUntil counts as serverless", async () => {
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[SLOT] = { get: () => ({ waitUntil }) };
    await call();
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("(d) flushOnEnd: false turns it off on Vercel, and true turns it on elsewhere", async () => {
    vi.stubEnv("VERCEL", "1");
    await withCodmirTracing(async () => Response.json({}), { route: "/a", flushOnEnd: false })(
      new Request("http://app.example.test/a"),
    );
    expect(calls).toHaveLength(0);
    vi.stubEnv("VERCEL", "");
    await withCodmirTracing(async () => Response.json({}), { route: "/b", flushOnEnd: true })(
      new Request("http://app.example.test/b"),
    );
    expect(sends("transaction")).toHaveLength(1);
  });

  it("(c) a handler that throws is sent too, and still throws", async () => {
    vi.stubEnv("VERCEL", "1");
    const failing = withCodmirTracing(async () => {
      throw new Error("nope");
    }, { route: "/api/orders" });
    await expect(failing(new Request("http://app.example.test/api/orders"))).rejects.toThrow("nope");
    expect(sends("transaction")).toHaveLength(1);
  });
});

describe("flushInBackground", () => {
  it("(f) never throws when flush rejects, or when waitUntil throws", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
    const overseer = await import("../../overseer/index");
    const spy = vi.spyOn(overseer, "flush").mockRejectedValue(new Error("flush failed"));
    await expect(flushInBackground(10)).resolves.toBeUndefined();
    const waitUntil = vi.fn(() => {
      throw new Error("waitUntil failed");
    });
    await expect(flushInBackground(10, waitUntil)).resolves.toBeUndefined();
    expect(waitUntil).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

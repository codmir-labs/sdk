// @vitest-environment jsdom
/**
 * A thrown value that is not an `Error` is captured under its own type, message and place: a plain object gives its
 * `message` and `name` (else its keys), an error from another realm and an event keep what they hold, and a stack made up
 * for the value starts at the app's call, never inside the SDK. Everything is read from the body `fetch` was given.
 */
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as browser from "../../browser/index";
import { captureException, close, flush, init } from "../index";
import { parseStackTrace } from "../stack";

type Frame = { filename?: string; lineno?: number; function?: string; in_app?: boolean };
type Wire = { exception: { type: string; value: string; stacktrace: Frame[] }; extra: Record<string, unknown> };
type Sent = { event: Wire; group: { fingerprint: string[] } };

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
  init(config);
});

afterEach(() => {
  browser.close();
  close();
  vi.unstubAllGlobals();
});

const config = { clientKey: "osk_test", dsn: "https://ingest.example.com/api/overseer", environment: "test", includeSourceContext: false, rateLimit: false } as const;

/** The error events on the wire, parsed. */
async function sent(): Promise<Sent[]> {
  await flush();
  return bodies.flatMap((b) => (JSON.parse(b).events as Array<{ type: string } & Sent>).filter((e) => e.type === "error"));
}

const here = (frame: Frame | undefined): boolean => !!frame?.filename?.endsWith("thrown-values.test.ts");
const insideSdk = (frame: Frame): boolean => /src[\\/](overseer|browser)[\\/](?!__tests__)/.test(frame.filename ?? "");

describe("a plain object", () => {
  it("(a) is its message, type Error, and a cleaned copy in extra.thrown", async () => {
    captureException({ message: "Payment declined", code: "card_declined", apiKey: "k" });
    const [{ event }] = await sent();
    expect(event.exception.type).toBe("Error");
    expect(event.exception.value).toBe("Payment declined");
    expect(event.extra.thrown).toEqual({ message: "Payment declined", code: "card_declined" });
    expect(event.extra.thrown).not.toHaveProperty("apiKey");
  });

  it("(b) without a message is named by its keys", async () => {
    captureException({ code: 1, reason: "x" });
    const [{ event }] = await sent();
    expect(event.exception.value).toBe("Object captured with keys: code, reason");
  });

  it("(b) names the first 10 keys only", async () => {
    captureException(Object.fromEntries("abcdefghijkl".split("").map((k) => [k, 1])));
    const [{ event }] = await sent();
    expect(event.exception.value).toBe("Object captured with keys: a, b, c, d, e, f, g, h, i, j");
  });

  it("(c) takes its type from its name", async () => {
    captureException({ name: "ValidationError", message: "bad" });
    const [{ event }] = await sent();
    expect(event.exception.type).toBe("ValidationError");
    expect(event.exception.value).toBe("bad");
  });
});

describe("an error of another realm", () => {
  it("(d) keeps its type, message and stack", async () => {
    const foreign = runInNewContext("new TypeError('from another realm')") as Error;
    expect(foreign instanceof Error).toBe(false);
    captureException(foreign);
    const [{ event }] = await sent();
    expect(event.exception.type).toBe("TypeError");
    expect(event.exception.value).toBe("from another realm");
    expect(event.exception.stacktrace).toEqual(parseStackTrace(foreign.stack));
    expect(event.exception.stacktrace.length).toBeGreaterThan(0);
  });
});

describe("where a string capture is", () => {
  function cartA(): string {
    return captureException("Cart is empty");
  }
  function cartB(): string {
    return captureException("Cart is empty");
  }

  it("(e) is the app's call: two functions are two places", async () => {
    cartA();
    cartB();
    const [a, b] = await sent();
    for (const [item, name] of [[a, "cartA"], [b, "cartB"]] as const) {
      const top = item!.event.exception.stacktrace.find((f) => f.in_app);
      expect(here(top)).toBe(true);
      expect(top!.function).toContain(name);
      expect(item!.event.exception.stacktrace.some(insideSdk)).toBe(false);
    }
    expect(a!.group.fingerprint).not.toEqual(b!.group.fingerprint);
    expect(a!.group.fingerprint[2]).toBe("Cart is empty");
  });

  it("(e) is the app's call also where Error.captureStackTrace is missing", async () => {
    const original = Error.captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = undefined;
    try {
      cartA();
      cartB();
    } finally {
      Error.captureStackTrace = original;
    }
    const [a, b] = await sent();
    for (const [item, name] of [[a, "cartA"], [b, "cartB"]] as const) {
      const top = item!.event.exception.stacktrace.find((f) => f.in_app);
      expect(here(top)).toBe(true);
      expect(top!.function).toContain(name);
      expect(item!.event.exception.stacktrace.some(insideSdk)).toBe(false);
    }
    expect(a!.group.fingerprint).not.toEqual(b!.group.fingerprint);
  });

  it("(e) is the app's call for a thrown object too", async () => {
    (function paymentFailed() {
      captureException({ message: "Payment declined" });
    })();
    const [{ event }] = await sent();
    expect(here(event.exception.stacktrace.find((f) => f.in_app))).toBe(true);
    expect(event.exception.stacktrace.some(insideSdk)).toBe(false);
  });
});

describe("the browser integration", () => {
  const rejection = (reason: unknown): void => {
    const event = new Event("unhandledrejection");
    Object.assign(event, { reason, promise: Promise.resolve() });
    window.dispatchEvent(event);
  };

  it("(f) a window error with no error is one frame from the event and none from the SDK", async () => {
    browser.init(config);
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error.", filename: "https://cdn.example.com/app.js", lineno: 12, colno: 5 }));
    const [{ event }] = await sent();
    expect(event.exception.value).toBe("Script error.");
    expect(event.exception.stacktrace).toEqual([{ filename: "https://cdn.example.com/app.js", lineno: 12, colno: 5, in_app: true }]);
  });

  it("(f) a window error with no error and no file has no frames", async () => {
    browser.init(config);
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    const [{ event }] = await sent();
    expect(event.exception.stacktrace).toEqual([]);
  });

  it("(f) a rejection with an object is its message and no frames; two messages are two groups", async () => {
    browser.init(config);
    rejection({ message: "Session expired" });
    rejection({ message: "Quota exceeded" });
    const [a, b] = await sent();
    expect(a!.event.exception.value).toBe("Session expired");
    expect(a!.event.exception.stacktrace).toEqual([]);
    expect(b!.event.exception.stacktrace).toEqual([]);
    expect(a!.group.fingerprint).not.toEqual(b!.group.fingerprint);
  });

  it("(f) a rejection with a string has no frames", async () => {
    browser.init(config);
    rejection("plain string");
    const [{ event }] = await sent();
    expect(event.exception.value).toBe("plain string");
    expect(event.exception.stacktrace).toEqual([]);
  });
});

describe("an error and an event", () => {
  it("(g) a real Error keeps its type, message and stack frames", async () => {
    const err = new RangeError("out of range");
    captureException(err);
    const [{ event }] = await sent();
    expect(event.exception.type).toBe("RangeError");
    expect(event.exception.value).toBe("out of range");
    expect(event.exception.stacktrace).toEqual(parseStackTrace(err.stack));
    expect(event.extra).not.toHaveProperty("thrown");
  });

  it("(h) an ErrorEvent-like value is the error it holds", async () => {
    const inner = new Error("inner");
    captureException({ error: inner, message: "Uncaught Error: inner", filename: "app.js" });
    const [{ event }] = await sent();
    expect(event.exception.type).toBe("Error");
    expect(event.exception.value).toBe("inner");
    expect(event.exception.stacktrace).toEqual(parseStackTrace(inner.stack));
  });

  it("a PromiseRejectionEvent is its reason, normalized in turn", async () => {
    const event = new Event("unhandledrejection");
    Object.assign(event, { reason: { name: "AuthError", message: "Session expired" }, promise: Promise.resolve() });
    captureException(event);
    const [{ event: wire }] = await sent();
    expect(wire.exception.type).toBe("AuthError");
    expect(wire.exception.value).toBe("Session expired");
  });
});

describe("a value that is not a plain object", () => {
  it("an event with no error and no reason is named by its type, with no copy in extra", async () => {
    captureException(new Event("error"));
    const [{ event }] = await sent();
    expect(event.exception.type).toBe("Event");
    expect(event.exception.value).toBe("Event captured: error");
    expect(event.extra).not.toHaveProperty("thrown");
  });

  it("a class instance with no message is named by its kind", async () => {
    captureException(new Response(null, { status: 404 }));
    const [{ event }] = await sent();
    expect(event.exception.value).toBe("Response captured with no keys");
  });

  it("a plain object is still named Object", async () => {
    captureException({});
    const [{ event }] = await sent();
    expect(event.exception.value).toBe("Object captured with no keys");
  });
});

describe("any other primitive", () => {
  it.each([
    [null, "null"],
    [undefined, "undefined"],
    [42, "42"],
    [false, "false"],
    [10n, "10"],
    [Symbol("tag"), "Symbol(tag)"],
  ])("%s is %s", async (value, text) => {
    captureException(value);
    const [{ event }] = await sent();
    expect(event.exception.type).toBe("Error");
    expect(event.exception.value).toBe(text);
  });
});

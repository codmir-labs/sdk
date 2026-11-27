/** An error's `cause` chain and an `AggregateError`'s `errors` are sent, scrubbed, bounded, and wrapped errors group by their root cause. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient, type OverseerEvent } from "../index";
import { sdkFingerprint } from "../transport";

let calls: Array<{ body: any }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(extra: Record<string, unknown> = {}): OverseerClient {
  const c = new OverseerClient({ clientKey: "osk_test", environment: "production", rateLimit: false, ...extra });
  c.init();
  return c;
}

/** The wire event of one capture. */
async function wireOf(error: unknown, extra: Record<string, unknown> = {}): Promise<any> {
  calls = [];
  const c = client(extra);
  c.captureException(error);
  await c.flush();
  return calls[0]!.body.events[0].event;
}

// Each helper makes its error on one line, so two errors from it share a `file:line`.
const wrap = (message: string, cause: unknown): Error => new Error(message, { cause });
const failA = (message: string): Error => new TypeError(message);
const failB = (message: string): Error => new TypeError(message);

describe("cause chain on the wire", () => {
  it("sends the cause of a wrapper", async () => {
    const wire = await wireOf(wrap("could not load the cart", new TypeError("connect ECONNREFUSED 10.0.0.5:5432")));
    expect(wire.exception.type).toBe("Error");
    expect(wire.exception.causes).toHaveLength(1);
    expect(wire.exception.causes[0]).toMatchObject({ type: "TypeError", value: "connect ECONNREFUSED 10.0.0.5:5432", source: "cause", parent: -1 });
    expect(JSON.stringify(wire)).toContain("ECONNREFUSED");
  });

  it("has no `causes` key for an error with nothing to walk", async () => {
    const wire = await wireOf(new Error("plain"));
    expect("causes" in wire.exception).toBe(false);
    expect("causes" in (await wireOf("a string"))).toBe(false);
  });

  it("links each entry to its parent, in walk order", async () => {
    const root = new RangeError("root");
    const mid = new Error("mid", { cause: root });
    const agg = new AggregateError([new Error("e0"), new Error("e1", { cause: new Error("deep") })], "many", { cause: mid });
    const wire = await wireOf(agg);
    expect(wire.exception.causes.map((c: any) => [c.value, c.source, c.parent])).toEqual([
      ["mid", "cause", -1],
      ["e0", "errors[0]", -1],
      ["e1", "errors[1]", -1],
      ["root", "cause", 0],
      ["deep", "cause", 2],
    ]);
  });
});

describe("bounds", () => {
  it("stops at a cycle", async () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as any).cause = b;
    (b as any).cause = a;
    const wire = await wireOf(a);
    expect(wire.exception.causes).toHaveLength(1);
    expect(wire.exception.causes[0].value).toBe("b");
  });

  it("keeps 5 of a chain of 8", async () => {
    let e: Error = new Error("e7");
    for (let i = 6; i >= 0; i--) e = new Error(`e${i}`, { cause: e });
    const wire = await wireOf(e);
    expect(wire.exception.causes.map((c: any) => c.value)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("keeps 10 of an AggregateError of 12", async () => {
    const wire = await wireOf(new AggregateError(Array.from({ length: 12 }, (_, i) => new Error(`inner ${i}`))));
    expect(wire.exception.causes).toHaveLength(10);
    expect(wire.exception.causes[9].source).toBe("errors[9]");
  });

  it("keeps 30 frames of a cause with a 10,000-frame stack", async () => {
    const cause = new Error("deep stack");
    cause.stack = "Error: deep stack\n" + Array.from({ length: 10_000 }, (_, i) => `    at f${i} (/srv/app/src/f${i}.ts:${i + 1}:1)`).join("\n");
    const wire = await wireOf(wrap("outer", cause));
    const frames = wire.exception.causes[0].stacktrace;
    expect(frames).toHaveLength(30);
    expect(frames[0]).toMatchObject({ function: "f0", lineno: 1 });
    expect(frames[0].context_line).toBeUndefined();
  });

  it("cuts a script URL in a cause frame like any other frame", async () => {
    const cause = new Error("x");
    cause.stack = "Error: x\n    at run (https://cdn.example.com/app.js?key=abc#top:1:2)";
    const wire = await wireOf(wrap("outer", cause));
    expect(wire.exception.causes[0].stacktrace[0].filename).toBe("https://cdn.example.com/app.js");
  });
});

describe("a cause that is not an Error", () => {
  it("is readable, never [object Object]", async () => {
    const wire = await wireOf(wrap("outer", "disk full"));
    expect(wire.exception.causes[0]).toMatchObject({ type: "Error", value: "disk full", source: "cause", parent: -1 });

    const obj = (await wireOf(wrap("outer", { message: "quota exceeded", name: "QuotaError" }))).exception.causes[0];
    expect(obj).toMatchObject({ type: "QuotaError", value: "quota exceeded" });
    const keys = (await wireOf(wrap("outer", { code: 7, reason: "x" }))).exception.causes[0];
    expect(keys.value).toBe("Object captured with keys: code, reason");
    expect(JSON.stringify([obj, keys])).not.toContain("[object Object]");
  });
});

describe("secrets", () => {
  it("are redacted in a cause message", async () => {
    const wire = await wireOf(wrap("outer", new Error("refused: token=ghp_9f8e7d6c5b4a39281706f5e4d3c2b1a0 and Authorization: Bearer abcdef0123456789abcdef0123456789")));
    const value: string = wire.exception.causes[0].value;
    expect(value).not.toContain("ghp_9f8e7d6c5b4a39281706f5e4d3c2b1a0");
    expect(value).not.toContain("abcdef0123456789abcdef0123456789");
    expect(value).toContain("[secret]");
  });
});

describe("beforeSend", () => {
  it("sees exception.causes", async () => {
    const seen: Array<OverseerEvent["exception"]> = [];
    const c = client({
      beforeSend: (e: OverseerEvent) => {
        seen.push(e.exception);
        return e;
      },
    });
    c.captureException(wrap("outer", new TypeError("inner")));
    await c.flush();
    expect(seen[0]?.causes).toMatchObject([{ type: "TypeError", value: "inner", source: "cause", parent: -1 }]);
  });
});

describe("errors is read from an AggregateError only", () => {
  class ValidationError extends Error {
    errors = [{ path: ["email"], message: "Required" }];
  }
  class FetchFailures extends AggregateError {}

  it("sends no causes for a validation-style error, and its fingerprint is the no-cause one", async () => {
    const err = new ValidationError("invalid input");
    const wire = await wireOf(err);
    expect("causes" in wire.exception).toBe(false);
    expect(wire.fingerprint).toEqual(sdkFingerprint({ ...wire, exception: { type: wire.exception.type, value: wire.exception.value, stacktrace: wire.exception.stacktrace } }));
  });

  it("still walks an AggregateError and a subclass of it", async () => {
    for (const agg of [new AggregateError([new Error("e0"), new Error("e1")], "many"), new FetchFailures([new Error("e0"), new Error("e1")], "many")]) {
      const wire = await wireOf(agg);
      expect(wire.exception.causes.map((c: any) => [c.value, c.source, c.parent])).toEqual([
        ["e0", "errors[0]", -1],
        ["e1", "errors[1]", -1],
      ]);
    }
  });
});

describe("culprit", () => {
  const groupOf = async (error: unknown): Promise<any> => {
    calls = [];
    const c = client();
    c.captureException(error);
    await c.flush();
    return calls[0]!.body.events[0].group;
  };

  it("is the first inner error's file:line for a Promise.any failure", async () => {
    const inner = failA("upstream down");
    let caught: unknown;
    try {
      await Promise.any([Promise.reject(inner)]);
    } catch (e) {
      caught = e;
    }
    const wire = await wireOf(caught);
    expect(wire.exception.stacktrace ?? []).toEqual([]);
    const frame = wire.exception.causes[0].stacktrace.find((f: any) => f.filename);
    expect(frame).toBeDefined();
    const group = await groupOf(caught);
    expect(group.culprit).toBe(`${frame.filename}:${frame.lineno}`);
  });

  it("keeps the top error's own frame when it has one", async () => {
    const err = wrap("outer", failA("inner"));
    err.stack = "Error: outer\n    at handleCheckout (/srv/app/src/checkout.ts:42:13)";
    expect((await groupOf(err)).culprit).toBe("/srv/app/src/checkout.ts:42");
  });
});

describe("grouping", () => {
  const fp = async (error: unknown) => (await wireOf(error)).fingerprint as string[];

  it("splits wrappers at one line by the type of their root cause", async () => {
    const a = await fp(wrap("could not load the cart", new TypeError("boom")));
    const b = await fp(wrap("could not load the cart", new RangeError("boom")));
    expect(a).not.toEqual(b);
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
    expect(a.at(-1)).toBe("TypeError");
    expect(b.at(-1)).toBe("RangeError");
  });

  it("follows the cause links to the deepest root", async () => {
    const wire = await wireOf(wrap("a", wrap("b", new RangeError("root"))));
    expect(wire.fingerprint.at(-1)).toBe("RangeError");
  });

  it("keeps one group for one root type with different ids in its message", async () => {
    const a = await fp(wrap("could not load the cart", failA("no row for user 1001")));
    const b = await fp(wrap("could not load the cart", failA("no row for user 2002")));
    expect(a).toEqual(b);
  });

  it("splits Promise.any failures by where the first inner error comes from, and joins them by the same line", async () => {
    const anyOf = async (make: () => Error) => {
      try {
        await Promise.any([Promise.reject(make()), Promise.reject(make())]);
      } catch (e) {
        return e;
      }
    };
    const fromA1 = await anyOf(() => failA("upstream down"));
    const fromA2 = await anyOf(() => failA("upstream down"));
    const fromB = await anyOf(() => failB("upstream down"));
    expect(fromA1).toBeInstanceOf(AggregateError);
    const [a1, a2, b] = [await fp(fromA1), await fp(fromA2), await fp(fromB)];
    expect(a1[0]).toBe("AggregateError");
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  it("is unchanged for an error with no cause", async () => {
    const err = new TypeError("order 1001 not found");
    err.stack = "TypeError: order 1001 not found\n    at handleCheckout (/srv/app/src/checkout.ts:42:13)";
    const wire = await wireOf(err);
    // What the base computes for this error: type, first in-app file:line, masked message.
    expect(wire.fingerprint).toEqual(["TypeError", "/srv/app/src/checkout.ts:42", "order <N> not found"]);
    expect(sdkFingerprint({ id: "x", type: "error", timestamp: "", level: "error", exception: { type: "TypeError", value: "order 1001 not found", stacktrace: [{ filename: "/srv/app/src/checkout.ts", lineno: 42, in_app: true }] } })).toEqual(wire.fingerprint);
  });
});

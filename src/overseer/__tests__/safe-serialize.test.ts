/**
 * One BigInt, one circular value or one event that cannot be serialized never stops sending: a BigInt is written as
 * its decimal string, a true cycle as "[Circular]", and an event that still cannot be written is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient } from "../index";
import { safeStringify, toWireEvent } from "../transport";

let bodies: string[];
let unhandled: unknown[];
const onUnhandled = (err: unknown) => unhandled.push(err);

beforeEach(() => {
  vi.useFakeTimers();
  bodies = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const onDropped = vi.fn();
  const c = new OverseerClient({ clientKey: "osk_test", environment: "production", onDropped, rateLimit: false });
  c.init();
  return { c, onDropped };
}

type Wire = { event: { message: string; fingerprint: string[]; user: { id: string } }; group: { fingerprint: string[] } };
const events = () => bodies.flatMap((b) => JSON.parse(b).events as Wire[]);

describe("safe serialization", () => {
  it("(a) sends an event whose context holds a BigInt, as its decimal string", async () => {
    const { c } = client();
    c.captureException(new Error("x"), { orderId: 12345678901234567890n } as never);
    expect(await c.flush()).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('"orderId":"12345678901234567890"');
  });

  it("(b) sends an event whose user id is a BigInt, as a string", async () => {
    const { c } = client();
    c.setUser({ id: 42n } as never);
    c.captureException(new Error("x"));
    expect(await c.flush()).toBe(true);
    expect(events()[0].event.user.id).toBe("42");
  });

  it("(c) sends a class instance that references itself, cut at the cycle", async () => {
    class Node {
      self: Node = this;
      name = "n";
    }
    const { c } = client();
    c.captureException(new Error("x"), { node: new Node() } as never);
    expect(await c.flush()).toBe(true);
    expect(bodies[0]).toContain('"self":"[Circular]"');
    expect(bodies[0]).toContain('"name":"n"');
  });

  it("(d) writes the fingerprint in both event and group, and an object reached twice side by side twice", async () => {
    const { c } = client();
    c.captureException(new Error("x"));
    expect(await c.flush()).toBe(true);
    const [wire] = events();
    expect(Array.isArray(wire.event.fingerprint)).toBe(true);
    expect(wire.event.fingerprint.length).toBeGreaterThan(0);
    expect(wire.group.fingerprint).toEqual(wire.event.fingerprint);
    expect(bodies[0]).not.toContain("[Circular]");

    // The same plain object twice in one event, not nested in itself, is written twice; a true cycle is cut.
    const shared = { a: 1 };
    expect(safeStringify({ first: shared, second: [shared, shared] })).toBe('{"first":{"a":1},"second":[{"a":1},{"a":1}]}');
    const loop: Record<string, unknown> = { a: 1 };
    loop.me = loop;
    expect(safeStringify({ loop })).toBe('{"loop":{"a":1,"me":"[Circular]"}}');
  });

  it("(e) delivers an ordinary error captured after a bad event", async () => {
    const { c } = client();
    c.captureException(new Error("bad"), { n: 1n } as never);
    expect(await c.flush()).toBe(true);
    c.captureException(new Error("later"));
    expect(await c.flush()).toBe(true);
    expect(events().map((e) => e.event.message)).toEqual(["bad", "later"]);
  });

  it("(f) drops an event whose toJSON throws, reports it, and sends the next one in the same batch", async () => {
    const { c, onDropped } = client();
    // The context is cleaned before it is queued (a throwing toJSON there is cut), so the throw comes from the user.
    c.setUser({
      id: "u",
      toJSON() {
        throw new Error("no");
      },
    } as never);
    const badId = c.captureException(new Error("bad"));
    c.setUser(null);
    c.captureException(new Error("good"));
    expect(await c.flush()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);

    expect(events().map((e) => e.event.message)).toEqual(["good"]);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith({ events: 1, status: 0, reason: "unserializable", eventIds: [badId] });
    expect(unhandled).toEqual([]);
  });

  it("(g) writes the same bytes as JSON.stringify for an event JSON.stringify handles", async () => {
    const { c } = client();
    c.setUser({ id: "u1", email: "a@b.c" });
    c.captureException(new Error("plain"), { when: new Date(0), nested: { list: [1, "two", null], skip: undefined, fn() {} } } as never);
    expect(await c.flush()).toBe(true);
    const sent = JSON.parse(bodies[0]).events[0];
    const wire = { type: "error", ...sent };
    expect(safeStringify(wire)).toBe(JSON.stringify(wire));
    const body = JSON.parse(bodies[0]);
    expect(bodies[0]).toBe(JSON.stringify(body));
    expect(safeStringify(toWireEvent({ type: "error", message: "m", fingerprint: ["a", "b"] } as never))).toBe(
      JSON.stringify(toWireEvent({ type: "error", message: "m", fingerprint: ["a", "b"] } as never)),
    );
  });
});

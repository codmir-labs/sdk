/** `beforeSend` is guarded: a throw drops the event, a Promise is awaited, and the hook edits copies. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient, type OverseerConfig, type OverseerEvent } from "../index";

type Crumb = { category: string; message: string; data?: Record<string, unknown> };
type Sent = { message?: string; user?: Record<string, unknown>; breadcrumbs: Crumb[] };

let bodies: Array<{ events: Array<{ type: string; event: Sent }> }> = [];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function make(config: OverseerConfig): OverseerClient {
  const c = new OverseerClient({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", ...config });
  c.init();
  return c;
}

const sent = (): Sent[] => bodies.flatMap((b) => b.events).map((e) => e.event);

describe("a throwing beforeSend", () => {
  it("sends nothing, throws nothing into the app, and reports before_send for an error and a message", async () => {
    const onDropped = vi.fn();
    const c = make({
      beforeSend: () => {
        throw new Error("scrubber broke");
      },
      onDropped,
    });

    let errorId = "";
    let messageId = "";
    expect(() => {
      errorId = c.captureException(new Error("boom"));
      messageId = c.captureMessage("hello");
    }).not.toThrow();
    await c.flush();

    expect(sent()).toEqual([]);
    expect(onDropped).toHaveBeenCalledTimes(2);
    expect(onDropped).toHaveBeenNthCalledWith(1, { events: 1, status: 0, reason: "before_send", eventIds: [errorId] });
    expect(onDropped).toHaveBeenNthCalledWith(2, { events: 1, status: 0, reason: "before_send", eventIds: [messageId] });
  });

  it("a rejected Promise drops the event the same way", async () => {
    const onDropped = vi.fn();
    const c = make({ beforeSend: () => Promise.reject(new Error("no")), onDropped });
    c.captureException(new Error("boom"));
    await c.flush();
    expect(sent()).toEqual([]);
    expect(onDropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "before_send" }));
  });
});

describe("an async beforeSend", () => {
  it("is awaited: the event it returns is sent after flush()", async () => {
    const c = make({
      beforeSend: async (e) => {
        await new Promise((r) => setTimeout(r, 20));
        return { ...e, message: "scrubbed" };
      },
    });
    const id = c.captureException(new Error("secret"));
    expect(id).not.toBe("");
    await c.flush();
    expect(sent().map((e) => e.message)).toEqual(["scrubbed"]);
  });

  it("returning null sends nothing", async () => {
    const c = make({ beforeSend: async () => null });
    c.captureException(new Error("boom"));
    await c.flush();
    expect(sent()).toEqual([]);
  });
});

describe("beforeSend edits copies", () => {
  it("the app's user keeps its email after the hook deletes it", async () => {
    const user = { id: "u1", email: "a@example.test" };
    const c = make({
      beforeSend: (e: OverseerEvent) => {
        delete e.user!.email;
        return e;
      },
    });
    c.setUser(user);
    c.captureException(new Error("boom"));
    await c.flush();
    expect(sent()[0].user).toEqual({ id: "u1" });
    expect(user).toEqual({ id: "u1", email: "a@example.test" });
  });

  it("the next event still carries breadcrumb data a hook deleted", async () => {
    let calls = 0;
    const c = make({
      beforeSend: (e: OverseerEvent) => {
        if (calls++ === 0) for (const b of e.breadcrumbs ?? []) delete b.data;
        return e;
      },
    });
    c.addBreadcrumb({ category: "ui.click", message: "go", data: { tag: "a" } });
    c.captureException(new Error("one"));
    c.captureException(new Error("two"));
    await c.flush();
    const [first, second] = sent();
    expect(first.breadcrumbs[0].data).toBeUndefined();
    expect(second.breadcrumbs[0].data).toEqual({ tag: "a" });
  });
});

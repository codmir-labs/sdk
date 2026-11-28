// @vitest-environment jsdom
/**
 * The browser `@example` setup, as written (`init` with a client key, then nothing that listens for errors), and the Remix
 * client entry's: one uncaught error is one event, however many times the setup runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let bodies: { events: { type: string }[] }[];
let keys: (string | undefined)[];

beforeEach(() => {
  bodies = [];
  keys = [];
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)["x-overseer-key"]);
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const errorsSent = () => bodies.flatMap((b) => b.events).filter((e) => e.type === "error");

/** One uncaught error on the page; the page's own listener keeps jsdom from logging it. */
function uncaught(message: string): void {
  const absorb = (e: Event) => e.preventDefault();
  window.addEventListener("error", absorb);
  window.dispatchEvent(new ErrorEvent("error", { error: new Error(message), message }));
  window.removeEventListener("error", absorb);
}

describe("the /browser @example", () => {
  it("sends one uncaught error once, with the client key", async () => {
    const { init, flush, close } = await import("../index");
    init({ clientKey: "osk_doc_example" });
    uncaught("one uncaught error");
    await flush();
    close();
    expect(errorsSent()).toHaveLength(1);
    expect(keys).toEqual(["osk_doc_example"]);
  });

  it("init called twice still sends it once", async () => {
    const { init, flush, close } = await import("../index");
    init({ clientKey: "osk_doc_example" });
    init({ clientKey: "osk_doc_example" });
    uncaught("one uncaught error");
    await flush();
    close();
    expect(errorsSent()).toHaveLength(1);
  });
});

describe("the /remix client entry @example", () => {
  it("sends one uncaught error once", async () => {
    const { init, setupBrowserTracking, flush, close } = await import("../../remix/index");
    init({ clientKey: "osk_doc_example" });
    setupBrowserTracking();
    uncaught("one uncaught error");
    await flush();
    close();
    expect(errorsSent()).toHaveLength(1);
  });

  it("setupBrowserTracking called twice registers its handlers once", async () => {
    const { init, setupBrowserTracking, flush, close } = await import("../../remix/index");
    init({ clientKey: "osk_doc_example" });
    setupBrowserTracking();
    setupBrowserTracking();
    uncaught("one uncaught error");
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("one rejection") }));
    await flush();
    close();
    expect(errorsSent()).toHaveLength(2);
  });

  it("a call after close registers them again", async () => {
    const { init, setupBrowserTracking, flush, close } = await import("../../remix/index");
    init({ clientKey: "osk_doc_example" });
    setupBrowserTracking();
    close();
    init({ clientKey: "osk_doc_example" });
    setupBrowserTracking();
    uncaught("after the restart");
    await flush();
    close();
    expect(errorsSent()).toHaveLength(1);
  });
});

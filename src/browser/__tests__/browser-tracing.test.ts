// @vitest-environment jsdom
/** CSL-5584: `browserTracing` on the browser `init`: default on with a sample rate, off without one. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INGEST = "https://ingest.example.test/api/overseer";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(async () => {
  const { close } = await import("../index");
  close();
  vi.unstubAllGlobals();
});

async function load() {
  const tracing = await import("../../tracing/index");
  const browser = await import("../index");
  return { getActiveSpan: tracing.getActiveSpan, init: browser.init };
}

describe("browser init, browserTracing", () => {
  it("starts a pageload root by default when tracesSampleRate is above 0", async () => {
    const { init, getActiveSpan } = await load();
    init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 0.5 });
    expect(getActiveSpan()?.op).toBe("pageload");
  });

  it("starts nothing by default at tracesSampleRate 0", async () => {
    const { init, getActiveSpan } = await load();
    init({ dsn: INGEST, clientKey: "osk_test" });
    expect(getActiveSpan()).toBeUndefined();
  });

  it("starts nothing with browserTracing: false, whatever the rate", async () => {
    const { init, getActiveSpan } = await load();
    init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 1, browserTracing: false });
    expect(getActiveSpan()).toBeUndefined();
  });

  it("accepts options and starts with browserTracing: true", async () => {
    const { init, getActiveSpan } = await load();
    init({ dsn: INGEST, clientKey: "osk_test", browserTracing: { routeName: () => "/home" } });
    expect(getActiveSpan()?.name).toBe("/home");
  });
});

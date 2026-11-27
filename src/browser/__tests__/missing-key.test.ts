// @vitest-environment jsdom
/** The browser entry with no `clientKey` and no `dsn`: one warning, every event reported as `not_configured`, nothing sent. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Browser from "../index";

type Dropped = { events: number; status: number; reason?: string; eventIds?: string[] };

afterEach(() => {
  Browser.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Browser.init with no key and no dsn", () => {
  it("warns once naming clientKey, reports both events as not_configured, sends nothing, and flush() is false", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dropped: Dropped[] = [];

    Browser.init({ clientKey: undefined, trackRequests: false, onDropped: (d) => dropped.push(d) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("clientKey");

    const a = Browser.captureException(new Error("first"));
    const b = Browser.captureException(new Error("second"));
    const flushed = await Browser.flush();

    expect(flushed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(dropped).toEqual([{ events: 2, status: 0, reason: "not_configured", eventIds: [a, b] }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("enabled: false warns nothing and reports nothing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dropped: Dropped[] = [];
    Browser.init({ enabled: false, trackRequests: false, onDropped: (d) => dropped.push(d) });
    Browser.captureException(new Error("off"));
    await Browser.flush();
    expect(warn).not.toHaveBeenCalled();
    expect(dropped).toEqual([]);
  });

  it("page hide reports what is queued instead of waiting for a timer", () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dropped: Dropped[] = [];
    Browser.init({ trackRequests: false, onDropped: (d) => dropped.push(d) });
    const id = Browser.captureException(new Error("last words"));
    window.dispatchEvent(new Event("pagehide"));
    expect(dropped).toEqual([{ events: 1, status: 0, reason: "not_configured", eventIds: [id] }]);
  });
});

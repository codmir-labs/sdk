/**
 * A client with no `clientKey` and no `dsn` (the README quick start with its environment variable unset) has no
 * endpoint. It warns once at init and reports each event it cannot send to `onDropped` as `not_configured`, and
 * `flush()` does not resolve `true` for events that were neither sent nor refused.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Root from "../index";

type Dropped = { events: number; status: number; reason?: string; eventIds?: string[] };

afterEach(() => {
  Root.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const dropped: Dropped[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return { fetch, dropped, warn, onDropped: (d: Dropped) => dropped.push(d) };
}

describe("a client with no key and no dsn", () => {
  it("warns once naming clientKey, reports both events as not_configured, sends nothing, and flush() is false", async () => {
    const t = setup();
    Root.init({ clientKey: undefined, environment: "production", onDropped: t.onDropped });
    expect(t.warn).toHaveBeenCalledTimes(1);
    expect(String(t.warn.mock.calls[0][0])).toContain("clientKey");
    expect(String(t.warn.mock.calls[0][0])).toMatch(/no event will be sent/);

    const a = Root.captureException(new Error("first"));
    const b = Root.captureException(new Error("second"));
    expect(a).not.toBe("");
    expect(b).not.toBe("");
    const flushed = await Root.flush();

    expect(flushed).toBe(false);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.dropped).toEqual([{ events: 2, status: 0, reason: "not_configured", eventIds: [a, b] }]);
    expect(t.warn).toHaveBeenCalledTimes(1);
  });

  it("a second client with no key warns once more, for its own init", () => {
    const t = setup();
    Root.init({ onDropped: t.onDropped });
    Root.init({ onDropped: t.onDropped });
    expect(t.warn).toHaveBeenCalledTimes(2);
  });

  it("enabled: false warns nothing and reports nothing", async () => {
    const t = setup();
    Root.init({ enabled: false, onDropped: t.onDropped });
    expect(Root.captureException(new Error("off"))).toBe("");
    expect(await Root.flush()).toBe(true);
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.dropped).toEqual([]);
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("a client with a key warns nothing, sends, and flush() is true", async () => {
    const t = setup();
    Root.init({ clientKey: "osk_test", environment: "production", onDropped: t.onDropped });
    Root.captureException(new Error("sent"));
    expect(await Root.flush()).toBe(true);
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.dropped).toEqual([]);
  });

  it("a dsn alone is a destination: no warning, a request", async () => {
    const t = setup();
    Root.init({ dsn: "https://ingest.example.test/api/overseer", onDropped: t.onDropped });
    Root.captureException(new Error("sent"));
    expect(await Root.flush()).toBe(true);
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("with debug: true the line names clientKey, not the DSN", async () => {
    const t = setup();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map((x) => (typeof x === "string" ? x : "<obj>")).join(" "));
    });
    Root.init({ debug: true, onDropped: t.onDropped });
    Root.captureException(new Error("x"));
    await Root.flush();
    expect(lines.some((l) => /clientKey/.test(l))).toBe(true);
    expect(lines.some((l) => /No DSN configured/.test(l))).toBe(false);
  });
});

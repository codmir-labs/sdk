// @vitest-environment node
/** The root `init` where there is no `window` (Node, a worker): it installs no page listener and never throws. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("root init outside a browser", () => {
  it("has no window, installs nothing, logs no browser line and does not throw", async () => {
    expect(typeof window).toBe("undefined");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await import("../index");
    expect(() => root.init({ clientKey: "osk_test", debug: true })).not.toThrow();
    expect(log.mock.calls.filter((call) => String(call[1]).includes("@codmir/sdk/browser adds"))).toHaveLength(0);
    expect(Object.getOwnPropertySymbols(globalThis).filter((s) => String(s.description).startsWith("codmir.page-errors"))).toEqual([]);
    await expect(root.close()).resolves.toBe(true);
    log.mockRestore();
  });
});

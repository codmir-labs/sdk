// @vitest-environment jsdom
/**
 * `apiKey` is an alias of `clientKey` in `/browser`'s `init`. This runs in jsdom because `Browser.init` returns at once
 * without a window: in the node environment the case passed through whatever client an earlier case had left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Browser from "../browser/index";

let headers: Record<string, string>[];
beforeEach(() => {
  headers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});
afterEach(() => {
  Browser.close();
  vi.unstubAllGlobals();
});

describe("/browser apiKey alias", () => {
  it("init({ apiKey }) really runs and sends the key as x-overseer-key, like clientKey", async () => {
    Browser.init({ apiKey: "osk_alias" });
    expect(Browser.isOverseerInitialized()).toBe(true);
    Browser.captureException(new Error("boom"));
    expect(await Browser.flush()).toBe(true);
    expect(headers).toHaveLength(1);
    expect(headers[0]["x-overseer-key"]).toBe("osk_alias");
  });

  it("a later case gets its own key: the one before left no client behind", async () => {
    Browser.init({ apiKey: "osk_second" });
    Browser.captureException(new Error("boom"));
    expect(await Browser.flush()).toBe(true);
    expect(headers.map((h) => h["x-overseer-key"])).toEqual(["osk_second"]);
  });
});

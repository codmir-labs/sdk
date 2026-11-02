/** CSL-5375: `apiKey` is an alias of `clientKey` (the name @codmir/overseer used), in the root entry and every framework init. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Root from "../index";
import * as Nextjs from "../nextjs/index";
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
  Root.close();
  vi.unstubAllGlobals();
});

const entries: [string, { init: (c: any) => void; captureException: (e: unknown) => string; flush: () => Promise<boolean> }][] = [
  ["root", Root],
  ["/nextjs", Nextjs],
  ["/browser", Browser],
];

describe("apiKey alias", () => {
  for (const [name, entry] of entries) {
    it(`${name}: init({ apiKey }) sends the key as x-overseer-key, like clientKey`, async () => {
      entry.init({ apiKey: "osk_alias" });
      entry.captureException(new Error("boom"));
      expect(await entry.flush()).toBe(true);
      expect(headers).toHaveLength(1);
      expect(headers[0]["x-overseer-key"]).toBe("osk_alias");
    });
  }

  it("clientKey wins when both are given", async () => {
    Root.init({ clientKey: "osk_client", apiKey: "osk_api" });
    expect(Root.getClientKey()).toBe("osk_client");
    Root.captureException(new Error("boom"));
    await Root.flush();
    expect(headers[0]["x-overseer-key"]).toBe("osk_client");
  });

  it("getClientKey and getOverseerKey report the alias", () => {
    Root.init({ apiKey: "osk_alias" });
    expect(Root.getClientKey()).toBe("osk_alias");
    expect(Root.getOverseerKey()).toBe("osk_alias");
  });
});

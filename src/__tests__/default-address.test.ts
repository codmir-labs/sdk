import { afterEach, describe, expect, it, vi } from "vitest";
import { CodmirClient } from "../client";
import { OverseerClient } from "../overseer/index";
import { CodmirReport } from "../report/client";

/**
 * The apex answers every request with a redirect to `www`. A browser refuses a redirect on a preflight, and `fetch` drops
 * `Authorization` when a redirect leaves the host, so a default on the apex sends nothing from a page and signs in nowhere.
 */
describe("every default address answers itself: www, never the apex", () => {
  const urls: string[] = [];
  const stub = () =>
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
  afterEach(() => {
    urls.length = 0;
    vi.unstubAllGlobals();
  });

  it("errors, logs, replays and traces", async () => {
    stub();
    const client = new OverseerClient({ clientKey: "osk_test" });
    client.captureException(new Error("x"));
    await client.flush();
    client.close();
    expect(urls).toEqual(["https://www.codmir.com/api/v1/overseer/ingest"]);
  });

  it("the API client", async () => {
    stub();
    const client = new CodmirClient({ apiKey: "k" }) as unknown as { request(method: string, path: string): Promise<unknown> };
    await client.request("GET", "/v1/x");
    expect(urls.map((u) => new URL(u).origin)).toEqual(["https://www.codmir.com"]);
  });

  it("bug reports", async () => {
    stub();
    const report = new CodmirReport({ projectKey: "k", autoSearch: false });
    await report.searchBugs({ query: "x" });
    expect(urls.map((u) => new URL(u).origin)).toEqual(["https://www.codmir.com"]);
  });
});

describe("a DSN written with a trailing slash sends to the same ingest URL", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["", "/", "//", "/ingest", "/ingest/"])("captureException, flush: DSN suffix %j", async (suffix) => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new OverseerClient({ dsn: `https://www.example.com/api/v1/overseer${suffix}`, clientKey: "osk_test" });
    client.captureException(new Error("x"));
    await client.flush();
    client.close();
    expect(urls).toEqual(["https://www.example.com/api/v1/overseer/ingest"]);
  });
});

// @vitest-environment jsdom
/**
 * CSL-5640: a URL in a breadcrumb or a transaction keeps origin and path, never the query string or fragment. A sentinel
 * in both must be absent from the whole serialized event, and the path must still be there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException, close, flush, init, type OverseerEvent } from "../index";
import { scrubUrl } from "../url-scrub";
import { instrumentFetch, instrumentXhr } from "../../tracing/index";
import { startBrowserTracing } from "../../tracing/browser";
import { sentTransactions, type FetchCall } from "../../tracing/__tests__/helpers";

const Q = "?access_token=QSECRET&x=1";
const F = "#access_token=FSECRET";
let events: OverseerEvent[];
let teardown: Array<() => void>;

beforeEach(() => {
  events = [];
  teardown = [];
  init({ clientKey: "k", dsn: "http://127.0.0.1:9/never", includeSourceContext: false, beforeSend: (e) => (events.push(e), null) });
});
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  close();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const capture = (): string => {
  captureException(new Error("x"));
  return JSON.stringify(events.at(-1));
};
const expectScrubbed = (json: string, path: string) => {
  expect(json).not.toContain("SECRET");
  expect(json).not.toContain("access_token");
  expect(json).toContain(path);
};

describe("scrubUrl", () => {
  it.each([
    ["https://u:p@api.example.com:8443/a/b?x=1#h", undefined, "https://api.example.com:8443/a/b"],
    ["/a/b?x=1#h", undefined, "/a/b"],
    ["a/b?x=1", undefined, "a/b"],
    ["?page=2", "https://app.example.com/list?z=1", "https://app.example.com/list"],
    ["../up?x=1", "https://app.example.com/a/b/c", "https://app.example.com/a/up"],
    ["http://[bad?x=1#y", undefined, "http://[bad"],
    ["", undefined, ""],
  ])("%s", (raw, base, want) => expect(scrubUrl(raw, base)).toBe(want));

  it("takes a URL object and nothing", () => {
    expect(scrubUrl(new URL("https://h.example.com/p?q=1#f"))).toBe("https://h.example.com/p");
    expect(scrubUrl(null)).toBe("");
    expect(scrubUrl(undefined)).toBe("");
  });
});

describe("fetch breadcrumbs", () => {
  const stub = (impl: () => Promise<Response>) => {
    vi.stubGlobal("fetch", vi.fn(impl));
    teardown.push(instrumentFetch({ breadcrumbs: true }));
  };

  it("an ok fetch: message and data.url are origin and path", async () => {
    stub(async () => new Response("{}", { status: 200 }));
    await fetch(`https://api.example.com/v1/users${Q}${F}`);
    expectScrubbed(capture(), "https://api.example.com/v1/users");
    expect(events[0]!.breadcrumbs!.at(-1)).toMatchObject({ category: "fetch", message: "GET https://api.example.com/v1/users", data: { url: "https://api.example.com/v1/users" } });
  });

  it("a failed fetch: the same", async () => {
    stub(async () => { throw new TypeError("net down"); });
    await fetch(`/api/orders${Q}${F}`).catch(() => undefined);
    expectScrubbed(capture(), "/api/orders");
  });

  it("a Request and a URL object are scrubbed too", async () => {
    stub(async () => new Response("{}"));
    await fetch(new URL(`https://api.example.com/u${Q}${F}`));
    await fetch(new Request(`https://api.example.com/r${Q}`));
    const json = capture();
    expectScrubbed(json, "https://api.example.com/u");
    expect(json).toContain("https://api.example.com/r");
  });
});

describe("xhr breadcrumbs", () => {
  it("message and data.url are origin and path", async () => {
    // The stub goes in first, so the instrumentation wraps it.
    const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (this: XMLHttpRequest) {
      queueMicrotask(() => this.dispatchEvent(new Event("loadend")));
    });
    teardown.push(instrumentXhr({ breadcrumbs: true }), () => send.mockRestore());
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `https://api.example.com/v1/items${Q}${F}`);
    xhr.send();
    await new Promise((r) => setTimeout(r, 5));
    expectScrubbed(capture(), "https://api.example.com/v1/items");
    expect(events[0]!.breadcrumbs!.at(-1)).toMatchObject({ category: "xhr", message: "GET https://api.example.com/v1/items" });
  });
});

describe("browser transactions", () => {
  it("the pageload transaction's data.url has no query or fragment", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
      return new Response("{}", { status: 200 });
    }));
    close();
    init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", tracesSampleRate: 1 });
    window.history.replaceState(null, "", `/start${Q}${F}`);
    const stop = startBrowserTracing({});
    teardown.push(stop);
    stop();
    await flush();
    const body = JSON.stringify(sentTransactions(calls));
    expect(body).toContain("/start");
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("access_token");
  });
});

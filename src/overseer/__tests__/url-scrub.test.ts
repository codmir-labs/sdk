// @vitest-environment jsdom
/**
 * A URL in a breadcrumb or a transaction keeps origin and path, never the query string or fragment. A sentinel
 * in both must be absent from the whole serialized event, and the path must still be there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException, close, flush, init, type OverseerEvent } from "../index";
import { MAX_URL_LENGTH, scrubUrl, scrubUrlsIn } from "../url-scrub";
import { instrumentFetch, instrumentXhr } from "../../tracing/index";
import { scrubRequestUrl } from "../../tracing/url-match";
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

  it.each([
    ["https://app.test/#/settings/billing", undefined, "https://app.test/#/settings/billing"],
    ["https://app.test/#!/users/42?tab=keys", undefined, "https://app.test/#!/users/42"],
    ["https://app.test/#/cb?access_token=abc", undefined, "https://app.test/#/cb"],
    ["https://app.test/#/a#access_token=abc", undefined, "https://app.test/#/a"],
    ["https://app.test/#/access_token=abc&token_type=bearer", undefined, "https://app.test/#/access_token"],
    ["https://app.test/#/search/q=shoes", undefined, "https://app.test/#/search/q"],
    ["https://app.test/#access_token=abc&token_type=bearer", undefined, "https://app.test/"],
    ["https://app.test/#id_token=abc", undefined, "https://app.test/"],
    ["https://app.test/#section-2", undefined, "https://app.test/"],
    ["https://app.test/#!access_token=abc", undefined, "https://app.test/"],
    ["https://app.test/app?x=1#/settings", undefined, "https://app.test/app#/settings"],
    ["#/settings?x=1", "https://app.test/app?y=2", "https://app.test/app#/settings"],
    ["/app#/settings?x=1", undefined, "/app#/settings"],
    ["/app#access_token=abc", undefined, "/app"],
    ["http://[bad#/route?x=1", undefined, "http://[bad#/route"],
  ])("fragment: %s", (raw, base, want) => expect(scrubUrl(raw, base)).toBe(want));

  it("masks no path segment, so a route fragment segment is kept as a path segment is", () => {
    expect(scrubUrl("https://app.test/reset/abcdef0123456789abcdef")).toBe("https://app.test/reset/abcdef0123456789abcdef");
    expect(scrubUrl("https://app.test/#/reset/abcdef0123456789abcdef")).toBe("https://app.test/#/reset/abcdef0123456789abcdef");
  });

  it("takes a URL object and nothing", () => {
    expect(scrubUrl(new URL("https://h.example.com/p?q=1#f"))).toBe("https://h.example.com/p");
    expect(scrubUrl(null)).toBe("");
    expect(scrubUrl(undefined)).toBe("");
  });
});

describe("scrubUrl: every shape a page produces", () => {
  const PAGE = "https://app.example.com/dash?x=1";
  const secret = (out: string) => {
    expect(out).not.toContain("svc");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("?");
  };

  it.each([
    ["//svc:SECRET_XHR_PASS@api.example.com/v1/items?q=SECRET_Q"],
    [" https://svc:SECRET_SPACE_PASS@api.example.com/v1/items?q=SECRET_Q#SECRET_F"],
    ["\n\t //svc:SECRET_XHR_PASS@api.example.com/v1/items#SECRET_F "],
  ])("credentials go, with a base and without: %j", (raw) => {
    for (const base of [undefined, PAGE]) {
      const out = scrubUrl(raw, base);
      secret(out);
      expect(out).toContain("api.example.com/v1/items");
    }
    expect(scrubUrl(raw.trim(), PAGE)).toMatch(/^https:\/\/api\.example\.com\/v1\/items$/);
  });

  it("an unparseable URL loses its userinfo with the query", () => {
    expect(scrubUrl("http://svc:SECRET@[bad/x?y=1")).toBe("http://[bad/x");
    expect(scrubUrl("//svc:SECRET@host/x?y")).toBe("//host/x");
  });

  it("data: keeps the media type and the payload size", () => {
    expect(scrubUrl(`data:image/png;base64,${"A".repeat(80_000)}`)).toBe("data:image/png;base64,[80000 bytes]");
    expect(scrubUrl("data:text/plain,hello?x#y")).toBe("data:text/plain,[9 bytes]");
    expect(scrubUrl("DATA:,")).toBe("data:,[0 bytes]");
    expect(scrubUrl(`data:${"x".repeat(5000)}`)).toBe("data:[5000 bytes]");
  });

  it("blob:, about: and other schemes", () => {
    expect(scrubUrl("blob:https://app.example.com/1d2e3f")).toBe("blob:https://app.example.com/1d2e3f");
    expect(scrubUrl("blob:https://u:p@app.example.com/1d2e3f?x=1#y")).toBe("blob:https://app.example.com/1d2e3f");
    expect(scrubUrl("blob:blob:blob:x")).toBe("blob:");
    expect(scrubUrl("about:blank")).toBe("about:blank");
    expect(scrubUrl("about:srcdoc?x=1#y")).toBe("about:srcdoc");
    expect(scrubUrl("javascript:alert(1)")).toBe("javascript:");
    expect(scrubUrl("mailto:someone@example.com?subject=x")).toBe("mailto:");
    expect(scrubUrl("file:///home/u/a.txt?x")).toBe("file:///home/u/a.txt");
  });

  it("a result is at most MAX_URL_LENGTH characters", () => {
    expect(MAX_URL_LENGTH).toBe(1024);
    const path = `/${"p".repeat(5000)}`;
    expect(scrubUrl(`https://a.example.com${path}`)).toHaveLength(MAX_URL_LENGTH);
    expect(scrubUrl(path)).toHaveLength(MAX_URL_LENGTH);
    expect(scrubUrl(`data:${"m".repeat(5000)},x`)).toHaveLength(MAX_URL_LENGTH);
  });
});

describe("scrubUrlsIn", () => {
  it("replaces each URL and keeps the other words", () => {
    const msg = "Request cannot be constructed from a URL that includes credentials: https://user:SECRET_PASS@api.example.com/v1/orders?token=SECRET_Q";
    expect(scrubUrlsIn(msg)).toBe("Request cannot be constructed from a URL that includes credentials: https://api.example.com/v1/orders");
    expect(scrubUrlsIn("bad (//svc:SECRET@h.example.com/a?b=1), then http://x.example.com/y#SECRET.")).toBe("bad (//h.example.com/a), then http://x.example.com/y.");
    expect(scrubUrlsIn("no url here: 1:2")).toBe("no url here: 1:2");
    expect(scrubUrlsIn("")).toBe("");
  });

  it("stays linear on 100,000 hostile characters", () => {
    const hostile = [
      "a".repeat(100_000),
      "//".repeat(50_000),
      "a:".repeat(50_000),
      "http:".repeat(20_000) + "//",
      "x//".repeat(33_333),
      "// ".repeat(33_333),
      "a://@".repeat(20_000),
      ("a".repeat(999) + ":// ").repeat(100),
    ];
    for (const text of hostile) {
      const t0 = performance.now();
      const out = scrubUrlsIn(text);
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(out.length).toBeLessThanOrEqual(text.length + 10);
    }
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
    expect(events[0]!.breadcrumbs!.at(-1)).toMatchObject({ category: "fetch", message: "GET /v1/users 200", data: { url: "https://api.example.com/v1/users" } });
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
    expect(events[0]!.breadcrumbs!.at(-1)).toMatchObject({ category: "xhr", message: "GET /v1/items failed" });
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

describe("linear time on a hostile input", () => {
  const N = 200_000;
  const time = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it("free text with a URL whose path is punctuation then a letter is scrubbed in under 1 s and keeps no query", () => {
    let result = "";
    const ms = time(() => { result = scrubUrlsIn(`see https://example.com/${".".repeat(N)}a?token=SECRET_Q for details`); });
    expect(ms).toBeLessThan(1000);
    expect(result).not.toContain("SECRET_Q");
    expect(result).not.toContain("?");
  });

  it("a trailing run of punctuation still stays outside the URL", () => {
    expect(scrubUrlsIn("go to https://a.example.com/x?q=1).")).toBe("go to https://a.example.com/x).");
  });

  it("a scheme-like run with no colon (SCHEME)", () => {
    expect(time(() => scrubUrl("a".repeat(N)))).toBeLessThan(1000);
    expect(time(() => scrubUrl("a.+-".repeat(N / 4)))).toBeLessThan(1000);
  });

  it("a long authority with no @ or with the cut's fallback (userinfo cut)", () => {
    expect(time(() => scrubUrl(`//${"a".repeat(N)}`))).toBeLessThan(1000);
    expect(time(() => scrubUrl(`http://${"a".repeat(N)} b?q=1`))).toBeLessThan(1000);
    expect(time(() => scrubUrl(`//${"u:".repeat(N / 2)}`))).toBeLessThan(1000);
  });

  it("a long run of // characters, and many short ones (the // run finder)", () => {
    expect(time(() => scrubUrlsIn("/".repeat(N)))).toBeLessThan(1000);
    expect(time(() => scrubUrlsIn(`${"a".repeat(N)}://x`))).toBeLessThan(1000);
    expect(time(() => scrubUrlsIn("// ".repeat(N / 3)))).toBeLessThan(1000);
    expect(time(() => scrubUrlsIn(`${"a:".repeat(N / 2)}//x`))).toBeLessThan(1000);
  });

  it("long whitespace before no slashes (the protocol-relative test)", () => {
    expect(time(() => scrubRequestUrl(`${" ".repeat(N)}x`))).toBeLessThan(1000);
    expect(time(() => scrubRequestUrl(`${" ".repeat(N)}/x`))).toBeLessThan(1000);
  });
});

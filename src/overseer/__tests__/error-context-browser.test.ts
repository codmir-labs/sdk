// @vitest-environment jsdom
/** CSL-5636: the browser side: contexts from userAgentData and the userAgent, a query-free request url, and no source lines. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient, type OverseerEvent } from "../index";
import { parseUserAgent, resetEnvContexts } from "../runtime-context";

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.5",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};

describe("parseUserAgent", () => {
  it.each([
    ["chromeMac", { name: "Chrome", version: "130.0.0.0" }, { name: "macOS", version: "10.15.7" }, { type: "desktop" }],
    ["edgeWin", { name: "Edge", version: "130.0.2849.5" }, { name: "Windows", version: "10.0" }, { type: "desktop" }],
    ["firefoxLinux", { name: "Firefox", version: "131.0" }, { name: "Linux" }, { type: "desktop" }],
    ["safariMac", { name: "Safari", version: "17.5" }, { name: "macOS", version: "10.15.7" }, { type: "desktop" }],
    ["safariIphone", { name: "Safari", version: "17.5" }, { name: "iOS", version: "17.5" }, { type: "mobile", family: "iPhone" }],
    ["chromeIos", { name: "Chrome", version: "130.0.6723.37" }, { name: "iOS", version: "17.5" }, { type: "mobile", family: "iPhone" }],
    ["chromeAndroid", { name: "Chrome", version: "130.0.0.0" }, { name: "Android", version: "14" }, { type: "mobile" }],
    ["androidTablet", { name: "Chrome", version: "130.0.0.0" }, { name: "Android", version: "13" }, { type: "tablet" }],
    ["ipad", { name: "Safari", version: "17.5" }, { name: "iOS", version: "17.5" }, { type: "tablet", family: "iPad" }],
  ] as const)("%s", (key, browser, os, device) => {
    expect(parseUserAgent(UA[key])).toEqual({ browser, os, device });
  });

  it("userAgentData wins: the specific brand over Chromium, its platform, and mobile", () => {
    const c = parseUserAgent(UA.chromeMac, {
      brands: [{ brand: "Not;A=Brand", version: "99" }, { brand: "Chromium", version: "130" }, { brand: "Google Chrome", version: "130" }],
      platform: "macOS",
      mobile: false,
    });
    expect(c.browser).toEqual({ name: "Chrome", version: "130" });
    expect(c.os).toEqual({ name: "macOS", version: "10.15.7" });
    expect(c.device).toEqual({ type: "desktop" });
    expect(parseUserAgent(UA.chromeMac, { brands: [{ brand: "Chromium", version: "130" }], platform: "Android", mobile: true })).toMatchObject({
      browser: { name: "Chromium", version: "130" },
      os: { name: "Android" },
      device: { type: "mobile" },
    });
  });
});

function capture(): OverseerEvent {
  let seen: OverseerEvent | undefined;
  const c = new OverseerClient({ clientKey: "k", beforeSend: (e) => ((seen = e), null) });
  c.init();
  c.captureException(Object.assign(new Error("x"), { stack: "Error: x\n    at fn (https://app.example.com/main.js:1:1)" }));
  c.close();
  return seen!;
}

describe("captureException in a browser", () => {
  beforeEach(() => resetEnvContexts());
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
    resetEnvContexts();
  });

  it("sends browser, os and device from a stubbed userAgent and userAgentData, and no runtime", () => {
    vi.stubGlobal("navigator", { userAgent: UA.chromeAndroid, userAgentData: { brands: [{ brand: "Google Chrome", version: "130" }], platform: "Android", mobile: true } });
    const e = capture();
    expect(e.contexts).toMatchObject({ browser: { name: "Chrome", version: "130" }, os: { name: "Android", version: "14" }, device: { type: "mobile" } });
    expect(e.contexts).not.toHaveProperty("runtime");
  });

  it("the request url is origin and path: no query, no hash; no headers, cookies or body", () => {
    vi.stubGlobal("navigator", { userAgent: UA.firefoxLinux });
    window.history.replaceState({}, "", "/checkout/pay?token=SECRET&x=1#frag");
    document.cookie = "sid=SECRET";
    const e = capture();
    expect(e.request).toEqual({ url: `${window.location.origin}/checkout/pay` });
    const json = JSON.stringify(e);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("frag");
    expect(e.request).not.toHaveProperty("headers");
  });

  it("sends no source lines in a browser, and parses a Firefox stack", () => {
    vi.stubGlobal("navigator", { userAgent: UA.firefoxLinux });
    const e = capture();
    expect(e.exception!.stacktrace![0]).toMatchObject({ function: "fn", filename: "https://app.example.com/main.js", in_app: true });
    expect(e.exception!.stacktrace![0]).not.toHaveProperty("context_line");
  });
});

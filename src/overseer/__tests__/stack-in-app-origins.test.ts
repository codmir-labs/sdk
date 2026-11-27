/** In a browser an http(s) frame is app code only on the page's origin, the origin init() was called from, or `inAppOrigins`. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverseerClient, type OverseerEvent } from "../index";
import { callerOrigin, parseStackTrace } from "../stack";
import { toWireEvent } from "../transport";

const PAGE = "https://shop.example.com";
const page = (origin = PAGE) => vi.stubGlobal("location", { origin, protocol: new URL(origin).protocol, href: `${origin}/cart` });
afterEach(() => vi.unstubAllGlobals());

const EXT = "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js:1:23456";
const GTM = "https://www.googletagmanager.com/gtm.js:240:7";
const APP = `${PAGE}/static/js/main.js:1:9912`;
const stack = (...locs: string[]) => `TypeError: Failed to fetch\n${locs.map((l, i) => `    at render${i} (${l})`).join("\n")}`;

type Wire = { group: { fingerprint: string[]; culprit?: string }; event: { exception: { stacktrace: Array<{ filename?: string; in_app?: boolean }> } } };
function captureFrom(origins: string[] | undefined, errStack: string, initStack?: string): Wire {
  let seen: OverseerEvent | undefined;
  const c = new OverseerClient({ clientKey: "k", inAppOrigins: origins, includeSourceContext: false, beforeSend: (e) => ((seen = e), null) });
  if (initStack === undefined) c.init();
  else {
    const prev = Error.prepareStackTrace;
    Error.prepareStackTrace = () => initStack;
    try {
      c.init();
    } finally {
      Error.prepareStackTrace = prev;
    }
  }
  c.captureException(Object.assign(new TypeError("Failed to fetch"), { stack: errStack }));
  c.close();
  return toWireEvent(seen!) as Wire;
}

describe("extension frames are never app code", () => {
  it("chrome-extension, moz-extension, safari-extension, safari-web-extension and ext: frames", () => {
    for (const where of [EXT, "moz-extension://2f5ab3e0-1c33-4b8b-9b0e-a7a2f8b39d11/content.js:10:5", "safari-extension://com.x/inject.js:3:4", "safari-web-extension://AB12/inject.js:3:4", "ext:deno_fetch/26_fetch.js:12:3"]) {
      expect(parseStackTrace(stack(where))[0]!.in_app, where).toBe(false);
    }
  });

  it("they are not app code in Node either", () => {
    expect(parseStackTrace(stack(EXT))[0]!.in_app).toBe(false);
  });

  it("an extension that wraps fetch does not own the app's group or culprit", () => {
    page();
    const w = captureFrom(undefined, stack(EXT, APP));
    expect(w.group.fingerprint[1]).toBe("/static/js/main.js:render1");
    expect(w.group.culprit).toBe(`${PAGE}/static/js/main.js:1`);
  });
});

describe("in a browser, an http(s) frame is app code only on an app origin", () => {
  it("a tag manager frame above an app frame: the fingerprint and the culprit take the app frame", () => {
    page();
    const w = captureFrom(undefined, stack(GTM, APP));
    expect(w.event.exception.stacktrace.map((f) => f.in_app)).toEqual([false, true]);
    expect(w.group.fingerprint[1]).toBe("/static/js/main.js:render1");
    expect(w.group.culprit).toBe(`${PAGE}/static/js/main.js:1`);
  });

  it("a bundle on a CDN origin that init() was called from stays app code", () => {
    page();
    const cdn = "https://cdn.example.net/assets/app.js:1:500";
    expect(callerOrigin(`Error\n    at OverseerClient.init (${cdn})\n    at init (${cdn})\n    at boot (${cdn})`)).toBe("https://cdn.example.net");
    const w = captureFrom(undefined, stack(GTM, cdn), `Error\n    at OverseerClient.init (${cdn})\n    at boot (${cdn})`);
    expect(w.group.fingerprint[1]).toBe("/assets/app.js:render1");
    expect(w.group.culprit).toBe("https://cdn.example.net/assets/app.js:1");
  });

  it("the init caller is found past the SDK's own file when the SDK is a separate script", () => {
    page();
    expect(callerOrigin("Error\n    at OverseerClient.init (https://sdk.example.org/codmir.js:1:1)\n    at boot (https://static.example.com/app.js:9:9)")).toBe("https://static.example.com");
  });

  it("an origin in inAppOrigins counts; a path or a bad entry is read as its origin or ignored", () => {
    page();
    const cdn = "https://static.example.com/app.js:1:500";
    // not listed: the CDN frame is third-party, so the group has no frame and keys on type and message
    expect(captureFrom(undefined, stack(GTM, cdn)).group.fingerprint).toHaveLength(2);
    expect(captureFrom(["https://static.example.com/x/y", "nonsense"], stack(GTM, cdn)).group.fingerprint[1]).toBe("/app.js:render1");
  });

  it("a frame on the page's own origin is app code", () => {
    page();
    expect(parseStackTrace(stack(APP))[0]!.in_app).toBe(true);
  });
});

describe("outside a browser the origin rule does not apply", () => {
  it("in Node an app file is app code and nothing changes", () => {
    const f = parseStackTrace(stack("/srv/app/src/cart.ts:4:2", "/srv/app/node_modules/x/i.js:1:1"));
    expect(f.map((x) => x.in_app)).toEqual([true, false]);
  });

  it("a worker or React Native with no http(s) location keeps an http(s) frame as app code, an extension still not", () => {
    vi.stubGlobal("location", { origin: "null", protocol: "file:" });
    expect(parseStackTrace(stack(GTM, EXT)).map((x) => x.in_app)).toEqual([true, false]);
    expect(callerOrigin(stack(GTM))).toBeUndefined();
  });
});

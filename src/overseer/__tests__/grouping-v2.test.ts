/**
 * Grouping v2: the fingerprint keys on the type, the first 3 in-app frames (a normalized file and function) and the
 * root cause's type; the message only when there is no frame. The old key travels beside it as `legacyFingerprint`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFrameFile, setAppRoot } from "../frame-file";
import { OverseerClient, type OverseerEvent } from "../index";
import { buildBody, legacyFingerprint, normalizeFunctionName, sdkFingerprint, toWireEvent, type WireSourceEvent } from "../transport";

type Group = { fingerprint: string[]; legacyFingerprint?: string[]; message?: string; culprit?: string };

/** One capture through the real client; the wire form is what the transport sends. */
function captured(error: Error, config: Record<string, unknown> = {}): { group: Group; event: { fingerprint: string[] } } {
  let wire: unknown;
  const c = new OverseerClient({ clientKey: "k", includeSourceContext: false, beforeSend: (e: OverseerEvent) => ((wire = toWireEvent(e)), null), ...config });
  c.init();
  c.captureException(error);
  c.close();
  return wire as { group: Group; event: { fingerprint: string[] } };
}

const fail = (type: string, message: string, stack: string): Error => Object.assign(new Error(message), { name: type, stack });
const fpOf = (type: string, message: string, stack: string): string[] => captured(fail(type, message, stack)).group.fingerprint;

afterEach(() => setAppRoot(undefined));

describe("frame file normalizer", () => {
  it("keeps the path of an http(s) URL only", () => {
    expect(normalizeFrameFile("https://acme.shop.example.com/static/js/app.js")).toBe("/static/js/app.js");
    expect(normalizeFrameFile("https://globex.shop.example.com:8443/static/js/app.js?v=20261127#x")).toBe("/static/js/app.js");
    expect(normalizeFrameFile("http://localhost:5173/src/List.tsx?t=1732650000000")).toBe("/src/List.tsx");
    expect(normalizeFrameFile("https://www.example.com")).toBe("/");
  });

  it("drops file:// and Hermes' address at", () => {
    expect(normalizeFrameFile("file:///srv/app/src/a.js")).toBe("/srv/app/src/a.js");
    expect(normalizeFrameFile("file:///C:/work/app/a.js")).toBe("C:/work/app/a.js");
    expect(normalizeFrameFile("address at index.android.bundle")).toBe("index.android.bundle");
  });

  it("maps install prefixes to app:///", () => {
    const uuid = "3F2A9C1E-8B7D-4E6F-A5B4-C3D2E1F0A9B8";
    expect(normalizeFrameFile(`address at /private/var/containers/Bundle/Application/${uuid}/Shop.app/main.jsbundle`)).toBe("app:///main.jsbundle");
    expect(normalizeFrameFile("/data/user/0/com.shop.app/files/bundle.js")).toBe("app:///files/bundle.js");
    expect(normalizeFrameFile("/data/data/com.shop.app/files/bundle.js")).toBe("app:///files/bundle.js");
    expect(normalizeFrameFile("file:///C:/Users/alice/AppData/Local/Programs/shop/resources/app.asar/dist/renderer.js")).toBe("app:///dist/renderer.js");
    expect(normalizeFrameFile("C:\\Users\\bob\\shop\\resources\\app.asar\\dist\\renderer.js")).toBe("app:///dist/renderer.js");
  });

  it("makes a path inside the app root relative, and leaves one outside", () => {
    setAppRoot("/srv/shop");
    expect(normalizeFrameFile("/srv/shop/src/cart.js")).toBe("src/cart.js");
    expect(normalizeFrameFile("/srv/shop-other/src/cart.js")).toBe("/srv/shop-other/src/cart.js");
    setAppRoot("/");
    expect(normalizeFrameFile("/srv/shop/src/cart.js")).toBe("/srv/shop/src/cart.js");
  });

  it("collapses a release directory", () => {
    expect(normalizeFrameFile("/var/www/shop/releases/20261126120000/src/checkout.js")).toBe("/var/www/shop/releases/<release>/src/checkout.js");
    expect(normalizeFrameFile("https://shop.example.com/releases/v2/app.js")).toBe("/releases/<release>/app.js");
  });

  it("removes a content hash and keeps a plain word", () => {
    expect(normalizeFrameFile("https://shop.example.com/static/js/main.3f2a9c1e.js")).toBe("/static/js/main.js");
    expect(normalizeFrameFile("/assets/index-8f2a1b3c.js")).toBe("/assets/index.js");
    expect(normalizeFrameFile("/assets/Cart-Dk9wPz0L.js")).toBe("/assets/Cart.js");
    expect(normalizeFrameFile("/assets/page.20261126.js")).toBe("/assets/page.js");
    expect(normalizeFrameFile("/assets/index-header.js")).toBe("/assets/index-header.js");
    expect(normalizeFrameFile("/assets/vendor-react.js")).toBe("/assets/vendor-react.js");
    expect(normalizeFrameFile("/assets/my-application.js")).toBe("/assets/my-application.js");
    expect(normalizeFrameFile("/assets/main.abc123.js")).toBe("/assets/main.abc123.js");
    expect(normalizeFrameFile("/assets/3f2a9c1e8b.js")).toBe("/assets/3f2a9c1e8b.js");
  });

  it("leaves webpack-internal, node: and unnamed files alone", () => {
    expect(normalizeFrameFile("webpack-internal:///(rsc)/./src/app/page.tsx")).toBe("webpack-internal:///(rsc)/./src/app/page.tsx");
    expect(normalizeFrameFile("node:internal/url")).toBe("node:internal/url");
    expect(normalizeFrameFile("")).toBe("");
  });
});

describe("function names", () => {
  it("loses async, new, [as x], generic receivers and Firefox's promise callback prefix", () => {
    expect(normalizeFunctionName("async chargeCard")).toBe("chargeCard");
    expect(normalizeFunctionName("new Cart")).toBe("Cart");
    expect(normalizeFunctionName("Object.chargeCard")).toBe("chargeCard");
    expect(normalizeFunctionName("Module.run")).toBe("run");
    expect(normalizeFunctionName("Layer.handle [as handle_request]")).toBe("Layer.handle");
    expect(normalizeFunctionName("promise callback*loadCart")).toBe("loadCart");
    expect(normalizeFunctionName("async Object.exports.handler")).toBe("handler");
    expect(normalizeFunctionName("OrderService.charge")).toBe("OrderService.charge");
  });
});

describe("F1: an edit above the throw keeps the group", () => {
  const stack = (line: number) => `TypeError: Card declined\n    at Object.chargeCard (/srv/app/rel/checkout.js:${line}:9)\n    at async handler (/srv/app/src/routes.js:20:5)`;

  it("the same function before and after a line is added above it is one fingerprint", () => {
    expect(fpOf("TypeError", "Card declined", stack(3))).toEqual(fpOf("TypeError", "Card declined", stack(2)));
    expect(fpOf("TypeError", "Card declined", stack(2))).toEqual(["TypeError", "/srv/app/rel/checkout.js:chargeCard", "/srv/app/src/routes.js:handler"]);
  });

  it("two different functions in one file are two fingerprints", () => {
    const at = (fn: string, line: number) => `TypeError: x\n    at ${fn} (/srv/app/src/cart.js:${line}:5)`;
    expect(fpOf("TypeError", "x", at("addItem", 10))).not.toEqual(fpOf("TypeError", "x", at("removeItem", 30)));
  });

  it("an anonymous function is its trimmed source line; the line number is the last resort", () => {
    const event = (context_line?: string, lineno = 7) => ({
      id: "e", type: "error", timestamp: "t", level: "error",
      exception: { type: "Error", value: "x", stacktrace: [{ filename: "/srv/app/src/a.js", function: "Object.<anonymous>", lineno, context_line, in_app: true }] },
    });
    // The same line of source at another number: one group.
    expect(sdkFingerprint(event("  return items.map((i) => i.id);  ", 7))).toEqual(sdkFingerprint(event("return items.map((i) => i.id);", 9)));
    expect(sdkFingerprint(event("return items.map((i) => i.id);"))[1]).toBe("/srv/app/src/a.js:return items.map((i) => i.id);");
    expect(sdkFingerprint(event(undefined, 7))[1]).toBe("/srv/app/src/a.js:7");
  });
});

/** The review's pairs of one message with different user text. */
const USER_TEXT: Record<string, [string, string]> = {
  email: ["User alice@example.com already registered", "User bob@example.org already registered"],
  url_path_slug: ["Failed to load https://api.example.com/v1/users/alice/settings", "Failed to load https://api.example.com/v1/users/bob/settings"],
  zod_enum: ["Invalid enum value. Expected 'active' | 'paused', received 'archived'", "Invalid enum value. Expected 'active' | 'paused', received 'draft'"],
  json_snippet: [`Unexpected token 'N', "Not Found" is not valid JSON`, `Unexpected token 'I', "Internal S"... is not valid JSON`],
  quoted_input: [`Product "Blue Shirt" is out of stock`, `Product "Red Hat" is out of stock`],
  cuid: ["Order clx9g2x0e0000ldw7qzk3yv8m not found", "Order cly1h4k2p0003mnb8rta5wq2z not found"],
  nanoid: ["Session V1StGXR8_Z5jdHi6B-myT expired", "Session Uakgb_J5m9g-0JDMbcJqLJ expired"],
  prefixed_id: ["No such customer: 'cus_NffrFeUfNV2Hib'", "No such customer: 'cus_OaaPqLmZx9Wtrk'"],
  base36: ["Ticket i2qfs446pix7 is locked", "Ticket k9zzt0q1mbr3 is locked"],
  git_sha7: ["Deploy a1b2c3d failed", "Deploy e4f5a6b failed"],
  jwt: ["Invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig1", "Invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MiJ9.sig2"],
  iso_time: ["Expired at 2026-11-26T20:15:00.123Z", "Expired at 2026-12-01T08:00:59.999Z"],
  date_string: ["Expired at Thu Nov 26 2026 20:15:00 GMT+0000 (Coordinated Universal Time)", "Expired at Fri Dec 04 2026 09:00:00 GMT+0100 (Central European Standard Time)"],
  ipv6: ["connect ECONNREFUSED fe80::1ff:fe23:4567:890a", "connect ECONNREFUSED fd12:3456:789a::1"],
  path_user: ["ENOENT: no such file or directory, open '/srv/app/uploads/user-alice/avatar.png'", "ENOENT: no such file or directory, open '/srv/app/uploads/user-bob/avatar.png'"],
  vite_chunk: ["Failed to fetch dynamically imported module: https://shop.example.com/assets/Cart-BxKz3_qA.js", "Failed to fetch dynamically imported module: https://shop.example.com/assets/Cart-Dk9wPz0L.js"],
};

describe("F2: the message is not in the key when a frame is", () => {
  const at = "    at addToCart (/srv/app/src/cart.js:10:5)";

  it("the four engines' words for one bug on one frame are one fingerprint", () => {
    const url = "https://shop.example.com/static/js/main.js:1:2345";
    const chrome = fpOf("TypeError", "Cannot read properties of undefined (reading 'map')", `TypeError: x\n    at List (${url})`);
    const firefox = fpOf("TypeError", "can't access property \"map\", e is undefined", `List@${url}`);
    const safari = fpOf("TypeError", "undefined is not an object (evaluating 'e.map')", `List@${url}`);
    const hermes = fpOf("TypeError", "Cannot read property 'map' of undefined", `TypeError: x\n    at List (address at ${url})`);
    expect(chrome).toEqual(["TypeError", "/static/js/main.js:List"]);
    expect(firefox).toEqual(chrome);
    expect(safari).toEqual(chrome);
    expect(hermes).toEqual(chrome);
  });


  it.each(Object.entries(USER_TEXT))("user text (%s) on one frame is one fingerprint", (_name, [a, b]) => {
    expect(fpOf("Error", a, `Error: x\n${at}`)).toEqual(fpOf("Error", b, `Error: x\n${at}`));
  });

  it("two throw sites with one message are two fingerprints", () => {
    const site = (fn: string) => `Error: Not found\n    at ${fn} (/srv/app/src/repo.js:5:9)`;
    expect(fpOf("Error", "Not found", site("findUser"))).not.toEqual(fpOf("Error", "Not found", site("findOrder")));
  });

  it("a shared helper called from two routes is two fingerprints (the key holds three frames)", () => {
    const route = (name: string, line: number) =>
      `Error: bad input\n    at fail (/srv/app/src/util.js:2:9)\n    at validate (/srv/app/src/util.js:8:5)\n    at ${name} (/srv/app/src/routes.js:${line}:3)\n    at Layer.handle (/srv/app/src/server.js:1:1)`;
    const orders = fpOf("Error", "bad input", route("ordersRoute", 10));
    expect(orders).toEqual(["Error", "/srv/app/src/util.js:fail", "/srv/app/src/util.js:validate", "/srv/app/src/routes.js:ordersRoute"]);
    expect(fpOf("Error", "bad input", route("profileRoute", 10))).not.toEqual(orders);
  });

  it("fewer than three in-app frames means fewer parts; a frame that is not in-app is skipped", () => {
    const stack = "Error: x\n    at lib (/srv/app/node_modules/lib/index.js:1:1)\n    at run (/srv/app/src/a.js:3:1)";
    expect(fpOf("Error", "x", stack)).toEqual(["Error", "/srv/app/src/a.js:run"]);
  });
});

describe("F6: where the code was served or installed is not in the key", () => {
  const one = (file: string) => fpOf("TypeError", "x", `TypeError: x\n    at render (${file}:10:5)`);
  const PAIRS: Record<string, [string, string]> = {
    tenant_hosts: ["https://acme.shop.example.com/static/js/app.js", "https://globex.shop.example.com/static/js/app.js"],
    www_and_apex: ["https://example.com/static/js/app.js", "https://www.example.com/static/js/app.js"],
    cache_busting_query: ["https://cdn.example.com/app.js?v=20261126", "https://cdn.example.com/app.js?v=20261127"],
    preview_aliases: ["https://shop-git-fix-cart-acme.preview.example.app/app.js", "https://shop-9f3k2.preview.example.app/app.js"],
    electron_users: ["file:///C:/Users/alice/AppData/Local/Programs/shop/resources/app.asar/dist/renderer.js", "file:///C:/Users/bob/AppData/Local/Programs/shop/resources/app.asar/dist/renderer.js"],
    electron_os: ["file:///C:/Users/alice/AppData/Local/Programs/shop/resources/app.asar/dist/renderer.js", "/home/bob/shop/resources/app.asar/dist/renderer.js"],
    release_directories: ["/var/www/shop/releases/20261126120000/src/checkout.js", "/var/www/shop/releases/20261127090000/src/checkout.js"],
    ios_container: [
      "address at /private/var/containers/Bundle/Application/3F2A9C1E-8B7D-4E6F-A5B4-C3D2E1F0A9B8/Shop.app/main.jsbundle",
      "address at /private/var/containers/Bundle/Application/0A1B2C3D-4E5F-4A6B-8C9D-0E1F2A3B4C5D/Shop.app/main.jsbundle",
    ],
    android_data_dirs: ["/data/user/0/com.shop.app/files/bundle.js", "/data/data/com.shop.app/files/bundle.js"],
    webpack_content_hash: ["https://shop.example.com/static/js/main.3f2a9c1e.js", "https://shop.example.com/static/js/main.7b1d0e44.js"],
    vite_content_hash: ["https://shop.example.com/assets/index-8f2a1b3c.js", "https://shop.example.com/assets/index-Dk9wPz0L.js"],
  };

  it.each(Object.entries(PAIRS))("%s is one fingerprint", (_name, [a, b]) => {
    expect(one(a)).toEqual(one(b));
  });

  it("a plain word in a file name is kept", () => {
    expect(one("https://shop.example.com/assets/index-header.js")).not.toEqual(one("https://shop.example.com/assets/index-footer.js"));
    expect(one("https://shop.example.com/assets/vendor-react.js")[1]).toBe("/assets/vendor-react.js:render");
    expect(one("https://shop.example.com/assets/index-8f2a1b3c.js")[1]).toBe("/assets/index.js:render");
  });

  it("a path inside the app root (the working directory at init) is relative to it", () => {
    const at = (root: string) => fpOf("Error", "x", `Error: x\n    at run (${root}/src/cart.js:3:1)`);
    expect(at(process.cwd())).toEqual(["Error", "src/cart.js:run"]);
    expect(at("/srv/elsewhere")).toEqual(["Error", "/srv/elsewhere/src/cart.js:run"]);
  });

  it("the frames that are sent keep their file as it is", () => {
    const wire = captured(fail("Error", "x", "Error: x\n    at render (https://acme.shop.example.com/static/js/main.3f2a9c1e.js:1:5)")).event as unknown as { exception: { stacktrace: Array<{ filename: string }> } };
    expect(wire.exception.stacktrace[0]!.filename).toBe("https://acme.shop.example.com/static/js/main.3f2a9c1e.js");
  });
});

describe("frameless: the folded message is the key", () => {
  const frameless = (message: string, type = "Error") => captured(fail(type, message, `${type}: x`)).group.fingerprint;
  const messageEvent = (message: string) => sdkFingerprint({ id: "m", type: "message", timestamp: "t", level: "error", message });

  it("an error with no frame and a message event keep their message in the key", () => {
    expect(frameless("Payment provider is down")).toEqual(["Error", "Payment provider is down"]);
    expect(messageEvent("Payment provider is down")).toEqual(["Error", "Payment provider is down"]);
    expect(frameless("Payment provider is down")).not.toEqual(frameless("Inventory is down"));
    expect(messageEvent("Payment provider is down")).not.toEqual(messageEvent("Inventory is down"));
  });

  it("emails, quoted values, dates, durations, short hex, URL paths and numbers are folded", () => {
    const same = (a: string, b: string) => {
      expect(frameless(a)).toEqual(frameless(b));
      expect(messageEvent(a)).toEqual(messageEvent(b));
    };
    same("User alice@example.com already registered", "User bob@example.org already registered");
    same(`Product "Blue Shirt" is out of stock`, `Product "Red Hat" is out of stock`);
    same("Invalid enum value, received 'archived'", "Invalid enum value, received 'draft'");
    same("Expired at 2026-11-26T20:15:00.123Z", "Expired at 2026-12-01T08:00:59.999Z");
    same("Timed out after 250ms", "Timed out after 1.5s");
    same("Deploy a1b2c3d failed", "Deploy e4f5a6b failed");
    same("Job 3f2a9c1e8b7d4e6fa5b4c3d2e1f0a9b8 failed", "Job 0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d failed");
    same("Order 1001 not found", "Order 2002 not found");
    same("Failed to load https://acme.example.com/v1/orders/1001?token=abc", "Failed to load https://globex.example.net/v1/orders/2002?token=def");
  });

  it("the key is cut to 100 characters", () => {
    expect(frameless("connection lost ".repeat(40))[1]).toHaveLength(100);
  });

  it("a frameless error with causes still ends with the root cause's type", () => {
    const wrapped = (root: string) => {
      const e = fail("Error", "could not load the cart", "Error: x");
      return sdkFingerprint({
        id: "e", type: "error", timestamp: "t", level: "error",
        exception: { type: "Error", value: e.message, causes: [{ type: root, value: "boom", source: "cause", parent: -1 }] },
      });
    };
    expect(wrapped("TypeError")).toEqual(["Error", "could not load the cart", "TypeError"]);
    expect(wrapped("RangeError")).toEqual(["Error", "could not load the cart", "RangeError"]);
  });
});

/**
 * The key as the SDK computed it before v2 (`sdkFingerprint` at the base of this change), copied as it was: the oracle
 * the legacy key is compared with, element for element.
 */
function baseSdkFingerprint(event: WireSourceEvent): string[] {
  type Frame = { filename?: string; lineno?: number; in_app?: boolean };
  const inAppOf = (frames?: Frame[]): Frame | undefined => frames?.find((f) => f.in_app === true && f.filename);
  const exception = event.exception;
  const causes = exception?.causes?.length ? exception.causes : undefined;
  const parts: string[] = [exception?.type || "Error"];

  let inAppFrame = inAppOf(exception?.stacktrace);
  let message = exception?.value ?? event.message ?? "";
  if (!inAppFrame && causes) {
    const primary = causes.find((c) => inAppOf(c.stacktrace));
    if (primary) {
      inAppFrame = inAppOf(primary.stacktrace);
      message = primary.value ?? "";
    }
  }
  if (inAppFrame) parts.push(`${inAppFrame.filename}:${inAppFrame.lineno}`);

  parts.push(
    message
      .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, "<UUID>")
      .replace(/(?=[0-9a-f]*[a-f])[0-9a-f]{8,}/gi, "<ID>")
      .replace(/\d+/g, "<N>")
      .slice(0, 100),
  );

  if (causes) {
    let at = -1;
    for (let i = 0; i < causes.length; i++) {
      if (causes[i]!.parent === at && causes[i]!.source === "cause") at = i;
    }
    parts.push(causes[Math.max(at, 0)]!.type);
  }
  return parts;
}

describe("the legacy key", () => {
  // Node 22 stacks (paths shortened to /srv/app), as the review captured them.
  const NODE_TAIL =
    "    at Module._compile (node:internal/modules/cjs/loader:1705:14)\n    at Module._extensions..js (node:internal/modules/cjs/loader:1838:10)\n    at Module.load (node:internal/modules/cjs/loader:1441:32)\n    at Module._load (node:internal/modules/cjs/loader:1263:12)\n    at node:internal/main/run_main_module:36:49";
  const REAL: Record<string, [string, string, string]> = {
    release1: ["TypeError", "Card declined for order 1001", `TypeError: x\n    at Object.chargeCard (/srv/app/v1/checkout.js:2:9)\n    at Object.<anonymous> (/srv/app/src/gen-lines.cjs:3:40)\n${NODE_TAIL}`],
    release2: ["TypeError", "Card declined for order 1001", `TypeError: x\n    at Object.chargeCard (/srv/app/v2/checkout.js:3:9)\n    at Object.<anonymous> (/srv/app/src/gen-lines.cjs:3:40)\n${NODE_TAIL}`],
    json_parse: ["SyntaxError", `Unexpected token 'h', "hello world" is not valid JSON`, `SyntaxError: x\n    at JSON.parse (<anonymous>)\n    at parseBody (/srv/app/src/gen.cjs:17:36)\n${NODE_TAIL}`],
    invalid_url: ["TypeError", "Invalid URL", `TypeError: x\n    at new URL (node:internal/url:818:25)\n    at parseUrl (/srv/app/src/gen.cjs:16:30)\n${NODE_TAIL}`],
    promise_all: ["Error", "connection refused by 10.0.0.5:5432", `Error: x\n    at Object.query (/srv/app/node_modules/fakedb/index.js:4:9)\n    at async Promise.all (index 0)\n    at async ordersRoute (/srv/app/src/gen-all.cjs:3:47)`],
    browser: ["TypeError", "Cannot read properties of undefined (reading 'map')", "TypeError: x\n    at List (https://acme.shop.example.com/static/js/main.3f2a9c1e.js?v=1:1:2345)"],
    frameless: ["Error", "Order 3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8 for alice@example.com failed 3 times", "Error: x"],
  };

  it.each(Object.entries(REAL))("%s: legacyFingerprint is the base's key, element for element", (_name, [type, message, stack]) => {
    const wire = captured(fail(type, message, stack));
    expect(wire.group.legacyFingerprint).toEqual(baseSdkFingerprint(wire.event as unknown as WireSourceEvent));
    expect(wire.group.legacyFingerprint).toEqual(legacyFingerprint(wire.event as unknown as WireSourceEvent));
  });

  it("is the base's key for a real error thrown here, with source context on", () => {
    const wire = captured(new TypeError("Cannot read properties of undefined (reading 'id')"), { includeSourceContext: true });
    expect(wire.group.legacyFingerprint).toEqual(baseSdkFingerprint(wire.event as unknown as WireSourceEvent));
    expect(wire.group.legacyFingerprint![1]).toMatch(/grouping-v2\.test\.ts:\d+$/);
    expect(wire.group.fingerprint[1]).toMatch(/^src\/overseer\/__tests__\/grouping-v2\.test\.ts:/);
  });

  it("is the base's key for an error with a cause chain, and for a cause that holds the frame", () => {
    const causes = (frames?: Array<Record<string, unknown>>) => [
      { type: "RangeError", value: "inner 42", source: "cause", parent: -1, stacktrace: frames },
      { type: "TypeError", value: "root 7", source: "cause", parent: 0, stacktrace: frames },
    ];
    const frame = { filename: "/srv/app/src/db.ts", function: "query", lineno: 12, in_app: true };
    for (const [frames, own] of [[[frame], undefined], [undefined, [{ filename: "/srv/app/src/api.ts", function: "handler", lineno: 5, in_app: true }]]] as const) {
      const event = {
        id: "e", type: "error", timestamp: "t", level: "error",
        exception: { type: "Error", value: "could not load order 1001", stacktrace: own, causes: causes(frames as never) },
      } as WireSourceEvent;
      const wire = toWireEvent(event) as { group: Group & { legacyFingerprint: string[] } };
      expect(wire.group.legacyFingerprint).toEqual(baseSdkFingerprint(event));
      expect(wire.group.legacyFingerprint.at(-1)).toBe("TypeError");
      expect(wire.group.fingerprint.at(-1)).toBe("TypeError");
      expect(wire.group.fingerprint).not.toEqual(wire.group.legacyFingerprint);
    }
  });

  it("differs from the new key, and the new key is in group.fingerprint and event.fingerprint", () => {
    const wire = captured(fail("TypeError", "Card declined", "TypeError: x\n    at chargeCard (/srv/app/src/checkout.js:2:9)"));
    expect(wire.group.fingerprint).toEqual(["TypeError", "/srv/app/src/checkout.js:chargeCard"]);
    expect(wire.event.fingerprint).toEqual(wire.group.fingerprint);
    expect(wire.group.legacyFingerprint).toEqual(["TypeError", "/srv/app/src/checkout.js:2", "Card declined"]);
  });

  it("is on the body that is sent", () => {
    const event = { id: "e", type: "error", timestamp: "t", level: "error", exception: { type: "Error", value: "x 1", stacktrace: [{ filename: "/srv/app/a.js", function: "run", lineno: 4, in_app: true }] } };
    const body = JSON.parse(buildBody([event as never], {})) as { events: Array<{ group: Group & { legacyFingerprint: string[] } }> };
    expect(body.events[0]!.group.legacyFingerprint).toEqual(["Error", "/srv/app/a.js:4", "x <N>"]);
    expect(body.events[0]!.group.fingerprint).toEqual(["Error", "/srv/app/a.js:run"]);
  });
});

describe("the app's own key", () => {
  /** The first event of the body the real client posts, with `beforeSend` as the app wrote it. */
  async function sent(beforeSend: (e: OverseerEvent) => OverseerEvent): Promise<{ group: Record<string, unknown>; event: { fingerprint: string[] } }> {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => (bodies.push(String(init.body)), new Response("{}", { status: 200 }))));
    try {
      const c = new OverseerClient({ clientKey: "k", includeSourceContext: false, rateLimit: false, beforeSend });
      c.init();
      c.captureException(fail("Error", "x", "Error: x\n    at run (/srv/app/a.js:4:1)"));
      await c.flush();
      c.close();
    } finally {
      vi.unstubAllGlobals();
    }
    return JSON.parse(bodies[0]!).events[0];
  }

  it("an app-set fingerprint wins, and no legacy key is sent", async () => {
    const wire = await sent((e) => ({ ...e, fingerprint: ["checkout", "declined"] }));
    expect(wire.group.fingerprint).toEqual(["checkout", "declined"]);
    expect(wire.event.fingerprint).toEqual(["checkout", "declined"]);
    expect("legacyFingerprint" in wire.group).toBe(false);
    expect(JSON.stringify(wire)).not.toContain("legacyFingerprint");
  });

  it("with no fingerprint of its own, the body carries both keys", async () => {
    const wire = await sent((e) => e);
    expect(wire.group.fingerprint).toEqual(["Error", "/srv/app/a.js:run"]);
    expect(wire.group.legacyFingerprint).toEqual(["Error", "/srv/app/a.js:4", "x"]);
  });

  it("an empty fingerprint falls back to the computed one, with its legacy key", () => {
    const wire = toWireEvent({ id: "e", type: "error", timestamp: "t", level: "error", fingerprint: [], exception: { type: "Error", value: "x" } }) as { group: Group };
    expect(wire.group.fingerprint).toEqual(["Error", "x"]);
    expect(wire.group.legacyFingerprint).toEqual(["Error", "x"]);
  });
});

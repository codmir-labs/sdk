/**
 * Grouping v2: the fingerprint keys on the type, the first 3 in-app frames (a normalized file and function) and the
 * root cause's type; the message only when there is no frame. The old key travels beside it as `legacyFingerprint`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { normalizeFrameFile, setAppRoot } from "../frame-file";
import { OverseerClient, type OverseerEvent } from "../index";
import { normalizeFunctionName, sdkFingerprint, toWireEvent } from "../transport";

type Group = { fingerprint: string[]; message?: string; culprit?: string };

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

  const PAIRS: Record<string, [string, string]> = {
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

  it.each(Object.entries(PAIRS))("user text (%s) on one frame is one fingerprint", (_name, [a, b]) => {
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

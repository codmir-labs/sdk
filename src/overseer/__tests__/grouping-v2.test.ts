/**
 * Grouping v2: the fingerprint keys on the type, the first 3 in-app frames (a normalized file and function) and the
 * root cause's type; the message only when there is no frame. The old key travels beside it as `legacyFingerprint`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { normalizeFrameFile, setAppRoot } from "../frame-file";

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

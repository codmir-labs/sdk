/**
 * One server error is one event across `onRequestError` and `pages/_error.js`, and its digest is a tag. Next 16 awaits
 * `onRequestError` for a Pages Router render error and then renders `_error` with the same Error object; Next bundles
 * `instrumentation.ts` and each page apart, so two copies of this module may share one process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRequestError, captureRouterError, captureUnderscoreErrorException, close, flush, init } from "../index";

const DSN = "https://ingest.example.test/api/v1/overseer";
const SERVERLESS_ENV = ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "K_SERVICE"];
let bodies: any[];
const events = () => bodies.flatMap((b) => (b.events ?? []).filter((w: any) => w.type === "error").map((w: any) => w.event));

beforeEach(() => {
  bodies = [];
  for (const name of SERVERLESS_ENV) vi.stubEnv(name, "");
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, req?: RequestInit) => {
      bodies.push(JSON.parse(String(req?.body ?? "{}")));
      return Promise.resolve(new Response('{"received":true}', { status: 200 }));
    }),
  );
  init({ dsn: DSN, clientKey: "osk_test" });
});
afterEach(() => {
  close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const request = { path: "/orders/42", method: "GET", headers: { host: "shop.example.test" } };
const pagesContext = { routerKind: "Pages Router", routePath: "/orders/[id]", routeType: "render" } as any;
const underscore = (err: Error) => ({ err, req: { url: "/orders/42?x=1", method: "GET" } });

describe("one server error is one event", () => {
  it("onRequestError first, then _error: one event, and it has routerKind", async () => {
    const err = new Error("render failed");
    await captureRouterError(err, request, pagesContext);
    await captureUnderscoreErrorException(underscore(err));
    await flush();
    expect(events()).toHaveLength(1);
    expect(JSON.stringify(events()[0])).toContain("Pages Router");
  });

  it("_error first, then onRequestError: one event", async () => {
    const err = new Error("render failed");
    await captureUnderscoreErrorException(underscore(err));
    await captureRouterError(err, request, pagesContext);
    await flush();
    expect(events()).toHaveLength(1);
  });

  it("captureRequestError and captureRouterError share the identity", async () => {
    const err = new Error("handler failed");
    captureRequestError(err, { routePath: "/api/x" }, new Request("https://shop.example.test/api/x"));
    await captureRouterError(err, request, pagesContext);
    await flush();
    expect(events()).toHaveLength(1);
  });

  it("two copies of the module in one process share the set", async () => {
    const a = await import("../index");
    vi.resetModules();
    const b = await import("../index");
    expect(b).not.toBe(a);
    b.init({ dsn: DSN, clientKey: "osk_test" });
    const err = new Error("render failed");
    await a.captureRouterError(err, request, pagesContext);
    await b.captureUnderscoreErrorException(underscore(err));
    await a.flush();
    await b.flush();
    b.close();
    expect(events()).toHaveLength(1);
  });
});

describe("digest", () => {
  it("captureRouterError sends a string digest as the tag digest", async () => {
    const err = Object.assign(new Error("boom"), { digest: "1234567" });
    await captureRouterError(err, request, { routerKind: "App Router", routePath: "/orders/[id]", routeType: "render" } as any);
    await flush();
    expect(events()[0].tags?.digest).toBe("1234567");
  });

  it("captureRequestError sends it too, with and without a request", async () => {
    captureRequestError(Object.assign(new Error("a"), { digest: "111" }), { routePath: "/a" }, new Request("https://shop.example.test/a"));
    captureRequestError(Object.assign(new Error("b"), { digest: "222" }), { routePath: "/b" });
    await flush();
    expect(events().map((e) => e.tags?.digest).sort()).toEqual(["111", "222"]);
  });

  it("an error without a digest has no digest tag", async () => {
    await captureRouterError(new Error("boom"), request, { routerKind: "App Router", routePath: "/x", routeType: "render" } as any);
    await flush();
    expect(events()[0].tags?.digest).toBeUndefined();
  });
});

describe("a header Next hands over as a list", () => {
  it("captureRouterError reads its first value", async () => {
    const listed = { path: "/orders/42", method: "GET", headers: { host: ["shop.example.test", "other.example.test"], "x-forwarded-proto": ["https", "http"] } };
    await captureRouterError(new Error("render failed"), listed, pagesContext);
    await flush();
    expect(events()[0].request.url).toBe("https://shop.example.test/orders/42");
  });
});

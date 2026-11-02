/**
 * CSL-5639: no request, header, cookie, authorization, query, params or body reaches any event field, from any
 * integration or from a direct `captureException(err, { request })`. The sentinel SECRET appears in every place a
 * request carries something sensitive; the whole serialized event (extra, breadcrumbs, request, everything) must not hold it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as express from "../../express/index";
import * as nextjs from "../../nextjs/index";
import * as remix from "../../remix/index";
import { addBreadcrumb, captureException, close, type OverseerEvent } from "../index";
import { sanitizeExtra } from "../sanitize-extra";

let events: OverseerEvent[];
beforeAll(() => {
  // Express init also initialises the core; the old body opt-in is on, to prove it no longer reaches an event.
  express.init({ captureRequestBody: true, clientKey: "k", dsn: "http://127.0.0.1:9/never", includeSourceContext: false, beforeSend: (e) => (events.push(e), null) } as any);
});
afterAll(() => close());
beforeEach(() => {
  events = [];
});

const serialized = () => events.map((e) => JSON.stringify(e)).join("\n");
const expectClean = () => {
  const text = serialized();
  expect(events.length).toBeGreaterThan(0);
  expect(text).not.toContain("SECRET");
  for (const e of events) {
    const extra = e.extra ?? {};
    for (const k of ["request", "headers", "cookies", "query", "params", "body", "req"]) expect(extra).not.toHaveProperty(k);
  }
};

function expressReq(over: Record<string, unknown> = {}): any {
  return {
    method: "POST", url: "/orders/u-4242?token=SECRET", originalUrl: "/orders/u-4242?token=SECRET", path: "/orders/u-4242", baseUrl: "/api",
    route: { path: "/orders/:id" }, params: { id: "u-4242" }, query: { token: "SECRET" }, protocol: "https",
    headers: { host: "shop.example.com", cookie: "sid=SECRET", authorization: "Bearer SECRET", "x-custom": "SECRET" },
    body: { password: "SECRET", note: "SECRET" }, ip: "10.0.0.1", ...over,
  };
}

describe("express", () => {
  it("errorHandler (old body opt-in on) sends no header, cookie, authorization, query, params or body, but the url, method and route", () => {
    express.errorHandler()(new Error("boom"), expressReq(), {} as any, () => undefined);
    expectClean();
    expect(events[0]!.request).toEqual({ url: "https://shop.example.com/orders/u-4242", method: "POST" });
    expect(events[0]!.extra).toMatchObject({ mechanism: "express-error-handler", route: "/api/orders/:id" });
  });

  it("requestHandler's breadcrumb has the path only: no query or params", () => {
    express.requestHandler()(expressReq({ url: "/p?token=SECRET", originalUrl: "/p?token=SECRET", path: "/p" }), {} as any, () => captureException(new Error("x")));
    const crumb = events[0]!.breadcrumbs!.find((b) => b.category === "http.request")!;
    expect(crumb.message).toBe("POST /p");
    expect(crumb.data).toEqual({ method: "POST", url: "/p", path: "/p" });
    expect(serialized()).not.toContain("SECRET");
  });
});

describe("next.js", () => {
  const req = () => new Request("https://next.example.com/api/users/u-4242?token=SECRET", { method: "POST", headers: { cookie: "sid=SECRET", authorization: "Bearer SECRET" } });

  it("captureRequestError sends no headers, cookies or query; it keeps url, method and the route pattern", () => {
    nextjs.captureRequestError(new Error("a") as any, { routerKind: "App Router", routePath: "/api/users/[id]", routeType: "route" }, req());
    expectClean();
    expect(events[0]!.request).toEqual({ url: "https://next.example.com/api/users/u-4242", method: "POST" });
    expect(events[0]!.extra).toMatchObject({ mechanism: "server", route: "/api/users/[id]" });
  });

  it("captureRouterError sends no request object or headers", async () => {
    await nextjs.captureRouterError(new Error("b") as any, { path: "/p?token=SECRET", method: "GET", headers: { cookie: "sid=SECRET", Authorization: "Bearer SECRET" } }, { routerKind: "Pages Router", routePath: "/p", routeType: "render" } as any);
    expectClean();
    expect(events[0]!.extra).toMatchObject({ route: "/p" });
  });
});

describe("remix", () => {
  const request = () => ({
    url: "https://remix.example.com/u/u-4242?token=SECRET", method: "POST",
    headers: { get: () => "SECRET", forEach: (cb: (v: string, k: string) => void) => { cb("SECRET", "x-custom"); cb("sid=SECRET", "cookie"); } },
    formData: async () => ({ keys: () => ["note"][Symbol.iterator]() }),
  });

  it("handleError and captureRemixServerError send no request, headers or query", () => {
    remix.handleError(new Error("a"), { request: request() as any });
    remix.captureRemixServerError(new Error("b"), request() as any);
    expectClean();
  });

  it("wrapLoader and wrapAction (errors thrown) send no params or headers, in extra or in breadcrumbs", async () => {
    const args = { request: request() as any, params: { id: "u-4242" } };
    await remix.wrapLoader((async () => { throw new Error("loader"); }) as any)(args).catch(() => undefined);
    await remix.wrapAction((async () => { throw new Error("action"); }) as any)(args).catch(() => undefined);
    // The captured events carry the breadcrumbs: they must hold no params either.
    expectClean();
    expect(events.map((e) => (e.extra as any).mechanism)).toEqual(["remix-loader", "remix-action"]);
  });
});

describe("the core boundary", () => {
  it("drops a request, headers, cookies and the like from `extra`, whoever passes them", () => {
    captureException(new Error("x"), {
      request: { headers: { cookie: "SECRET" } }, headers: { a: "SECRET" }, cookies: "SECRET", query: { a: "SECRET" }, params: { a: "SECRET" }, body: "SECRET",
      authToken: "SECRET", apiSecret: "SECRET", Password: "SECRET", "Set-Cookie": "SECRET", nested: { deep: { Authorization: "SECRET", ok: 1 } }, list: [{ cookie: "SECRET", keep: "yes" }],
      kept: "fine", count: 3,
    });
    expectClean();
    expect(events[0]!.extra).toMatchObject({ kept: "fine", count: 3, nested: { deep: { ok: 1 } }, list: [{ keep: "yes" }] });
  });

  it("drops a Request, Headers or request-like object under any key, and survives a cycle", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    captureException(new Error("x"), {
      incoming: new Request("https://h.example.com/?t=SECRET", { headers: { cookie: "SECRET" } }),
      h: new Headers({ cookie: "SECRET" }),
      thing: { method: "GET", url: "/x", headers: { a: "SECRET" } },
      loop,
    });
    expectClean();
    expect(events[0]!.extra).toMatchObject({ loop: { a: 1, self: "[Circular]" } });
    expect(events[0]!.extra).not.toHaveProperty("incoming");
    expect(events[0]!.extra).not.toHaveProperty("h");
    expect(events[0]!.extra).not.toHaveProperty("thing");
  });

  it("a breadcrumb's data is cleaned the same way", () => {
    addBreadcrumb({ category: "x", message: "m", data: { url: "/a", headers: { a: "SECRET" }, authToken: "SECRET" } });
    captureException(new Error("x"));
    expectClean();
    expect(events[0]!.breadcrumbs!.find((b) => b.category === "x")!.data).toEqual({ url: "/a" });
  });

  it("sanitizeExtra keeps Dates, Errors and primitives, and tolerates undefined", () => {
    const d = new Date(0);
    const err = new Error("e");
    expect(sanitizeExtra({ d, err, n: null })).toEqual({ d, err, n: null });
    expect(sanitizeExtra(undefined)).toEqual({});
  });
});

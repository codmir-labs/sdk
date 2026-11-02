/**
 * CSL-5637: an error captured while an Express, Next.js or Hono handler serves a request carries that request's url
 * (origin and path) and method in `event.request`; never the query, headers or cookies; none outside a request; and two
 * requests in flight at once never see each other's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as express from "../../express/index";
import * as nextjs from "../../nextjs/index";
import { withCodmirTracing, withCodmirMiddleware } from "../../nextjs/server";
import { codmirTracing } from "../../hono/index";
import { captureException, close, init, type OverseerEvent } from "../index";
import { requestScopeFrom, getRequestScope } from "../request-scope";

let events: OverseerEvent[];
beforeAll(() => {
  init({ clientKey: "k", dsn: "http://127.0.0.1:9/never", beforeSend: (e) => (events.push(e), null) });
});
afterAll(() => close());
beforeEach(() => {
  events = [];
});

const SECRET = ["token=SECRET", "sid=SECRET", "Bearer SECRET"];
const noSecrets = (e: OverseerEvent) => {
  const json = JSON.stringify(e.request ?? null);
  for (const s of SECRET) expect(json).not.toContain(s);
  expect(json).not.toMatch(/SECRET|headers|cookie|authorization|query/i);
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("requestScopeFrom", () => {
  it("origin and path from an absolute URL; the query, fragment and credentials go", () => {
    expect(requestScopeFrom({ url: "https://u:p@api.example.com:8443/a/b?token=SECRET#frag", method: "post" })).toEqual({ url: "https://api.example.com:8443/a/b", method: "POST" });
  });
  it("a path takes its origin from a plain host; a hostile host or none gives the path alone", () => {
    expect(requestScopeFrom({ url: "/a/b?x=1", method: "GET", host: "app.example.com", protocol: "https" }).url).toBe("https://app.example.com/a/b");
    expect(requestScopeFrom({ url: "/a/b?x=1", method: "GET", host: "evil.com/x?y", protocol: "https" }).url).toBe("/a/b");
    expect(requestScopeFrom({ url: "/a/b?x=1", method: "GET" }).url).toBe("/a/b");
  });
});

function expressReq(path: string, extra: Record<string, unknown> = {}): any {
  return {
    method: "GET", url: path, originalUrl: path, path: path.split("?")[0], baseUrl: "", params: {}, query: { token: "SECRET" }, protocol: "https",
    headers: { host: "shop.example.com", cookie: "sid=SECRET", authorization: "Bearer SECRET" }, ...extra,
  };
}

describe("express", () => {
  it("an error captured inside a handler (after an await) carries url and method, no query, headers or cookies", async () => {
    await new Promise<void>((resolve) => {
      express.requestHandler()(expressReq("/checkout/pay?token=SECRET"), {} as any, () => {
        setTimeout(() => {
          captureException(new Error("in handler"));
          resolve();
        }, 5);
      });
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.request).toEqual({ url: "https://shop.example.com/checkout/pay", method: "GET" });
    noSecrets(events[0]!);
  });

  it("errorHandler's own capture carries the request even outside the async flow", () => {
    const next = () => undefined;
    express.errorHandler()(new Error("boom"), expressReq("/orders/7?token=SECRET", { method: "DELETE" }), {} as any, next);
    expect(events[0]!.request).toEqual({ url: "https://shop.example.com/orders/7", method: "DELETE" });
    noSecrets(events[0]!);
  });

  it("an error outside any request has none", () => {
    captureException(new Error("outside"));
    expect(events[0]!).not.toHaveProperty("request");
    expect(getRequestScope()).toBeUndefined();
  });

  it("two requests in flight never leak into each other", async () => {
    const run = (path: string, wait: number) =>
      new Promise<void>((resolve) => {
        express.requestHandler()(expressReq(path), {} as any, () => {
          setTimeout(async () => {
            await tick(wait);
            captureException(new Error(path));
            resolve();
          }, 1);
        });
      });
    await Promise.all([run("/a", 20), run("/b", 5)]);
    const byMessage = Object.fromEntries(events.map((e) => [e.message, e.request?.url]));
    expect(byMessage).toEqual({ "/a": "https://shop.example.com/a", "/b": "https://shop.example.com/b" });
  });
});

describe("next.js", () => {
  const req = (path: string) => new Request(`https://next.example.com${path}`, { method: "POST", headers: { cookie: "sid=SECRET", authorization: "Bearer SECRET" } });

  it("withCodmirTracing: an error captured inside the handler carries url and method, no query, headers or cookies", async () => {
    const handler = withCodmirTracing(async (r: Request) => {
      await tick(2);
      captureException(new Error("in route"));
      return Response.json({ ok: true, from: r.url });
    });
    await handler(req("/api/users/42?token=SECRET"));
    expect(events[0]!.request).toEqual({ url: "https://next.example.com/api/users/42", method: "POST" });
    noSecrets(events[0]!);
  });

  it("withCodmirMiddleware does the same, and returns nothing without error", async () => {
    await withCodmirMiddleware(async (r: Request) => {
      captureException(new Error("in middleware"));
      return undefined;
    })(req("/dashboard?token=SECRET"));
    expect(events[0]!.request).toEqual({ url: "https://next.example.com/dashboard", method: "POST" });
  });

  it("captureRequestError and captureRouterError set the event's request without headers", async () => {
    nextjs.captureRequestError(new Error("a") as any, {}, req("/api/x?token=SECRET"));
    await nextjs.captureRouterError(new Error("b") as any, { path: "/p/9?token=SECRET", method: "get", headers: { Host: "next.example.com", "X-Forwarded-Proto": "https", cookie: "sid=SECRET" } }, { routerKind: "App Router" } as any);
    expect(events[0]!.request).toEqual({ url: "https://next.example.com/api/x", method: "POST" });
    expect(events[1]!.request).toEqual({ url: "https://next.example.com/p/9", method: "GET" });
    events.forEach(noSecrets);
  });

  it("outside any request, and for a capture without a request, none", () => {
    captureException(new Error("outside"));
    nextjs.captureRequestError(new Error("no req") as any, {});
    expect(events).toHaveLength(2);
    for (const e of events) expect(e).not.toHaveProperty("request");
  });

  it("two requests in flight never leak into each other", async () => {
    const h = withCodmirTracing(async (r: Request) => {
      await tick(r.url.endsWith("/a") ? 20 : 5);
      captureException(new Error(new URL(r.url).pathname));
      return Response.json({});
    });
    await Promise.all([h(req("/a")), h(req("/b"))]);
    expect(Object.fromEntries(events.map((e) => [e.message, e.request?.url]))).toEqual({ "/a": "https://next.example.com/a", "/b": "https://next.example.com/b" });
  });
});

describe("hono", () => {
  function app() {
    const a = new Hono();
    a.use(codmirTracing());
    a.get("/users/:id", async (c) => {
      await tick(c.req.param("id") === "1" ? 20 : 5);
      captureException(new Error(`user ${c.req.param("id")}`));
      return c.json({});
    });
    return a;
  }

  it("an error captured inside a handler carries url and method, no query, headers or cookies", async () => {
    await app().request("https://hono.example.com/users/9?token=SECRET", { headers: { cookie: "sid=SECRET", authorization: "Bearer SECRET" } });
    expect(events[0]!.request).toEqual({ url: "https://hono.example.com/users/9", method: "GET" });
    noSecrets(events[0]!);
  });

  it("an error outside any request has none", () => {
    captureException(new Error("outside"));
    expect(events[0]!).not.toHaveProperty("request");
  });

  it("two requests in flight never leak into each other", async () => {
    const a = app();
    await Promise.all([a.request("https://hono.example.com/users/1"), a.request("https://hono.example.com/users/2")]);
    expect(Object.fromEntries(events.map((e) => [e.message, e.request?.url]))).toEqual({
      "user 1": "https://hono.example.com/users/1",
      "user 2": "https://hono.example.com/users/2",
    });
  });
});

/**
 * @codmir/sdk/hono (CSL-5586): `http.server` transactions for Hono.
 *
 * ```ts
 * import { Hono } from "hono";
 * import { codmirTracing } from "@codmir/sdk/hono";
 *
 * const app = new Hono();
 * app.use(codmirTracing());
 * app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
 * ```
 *
 * Node (and any runtime that provides `node:async_hooks`). Continues an incoming `traceparent`; nothing is
 * sent unless `tracesSampleRate` is above 0 (default 0). `hono` itself is an optional peer dependency.
 */

import type { MiddlewareHandler } from "hono";
import { pathOf, traceServerRequest } from "../tracing/server";

/**
 * Names the transaction by the matched route (`GET /users/:id`), falling back to the URL path. A handler that
 * throws is caught by Hono's `onError`, so a 5xx response or a captured `c.error` both mark the transaction
 * `error`.
 */
export function codmirTracing(): MiddlewareHandler {
  return async (c, next) => {
    const request = c.req.raw;
    await traceServerRequest(
      {
        method: request.method,
        route: pathOf(request.url),
        traceparent: request.headers.get("traceparent"),
      },
      async (tx) => {
        await next();
        // Hono turns a handler's throw into c.error plus the onError response; make the cause explicit.
        if (c.error) tx.setStatus("error");
        // Answer with the response's status, which onError may not have set on `c.res` until now.
        return c.res;
      },
      () => {
        // The last matched route is the handler; an earlier one is a middleware pattern like "/*".
        const matched = c.req.matchedRoutes;
        const handler = matched.length > 0 ? matched[matched.length - 1].path : undefined;
        return handler && handler !== "/*" ? handler : undefined;
      },
    );
  };
}

/**
 * @codmir/sdk/remix/server (CSL-5586): `http.server` transactions for Remix. Node only.
 *
 * ```ts
 * // server.ts: the whole request, loaders and actions included
 * import { createRequestHandler } from "@remix-run/express";
 * import { withCodmirRequestHandler } from "@codmir/sdk/remix/server";
 * const handle = withCodmirRequestHandler(createRequestHandler({ build }));
 *
 * // or per route
 * import { withCodmirTracing } from "@codmir/sdk/remix/server";
 * export const loader = withCodmirTracing(async ({ params }) => json({ id: params.id }), {
 *   route: "/users/:id",
 * });
 * ```
 *
 * Typed against minimal structural shapes, so Remix is not a dependency of the SDK. Continues an incoming
 * `traceparent`; nothing is sent unless `tracesSampleRate` is above 0 (default 0). A thrown `Response`
 * (`throw redirect()`, `throw json(..., 404)`) is classified by its status and rethrown, not counted as an error.
 */

import { pathOf, traceServerRequest } from "../tracing/server";

export interface WithCodmirTracingOptions {
  /** The route pattern, e.g. `/users/:id`. Without it the transaction is named after the URL path. */
  route?: string;
}

function describe(request: Request, options?: WithCodmirTracingOptions) {
  return {
    method: request.method,
    route: options?.route ?? pathOf(request.url),
    traceparent: request.headers.get("traceparent"),
  };
}

/** Wraps a loader or action: any function whose first argument carries the `request`. */
export function withCodmirTracing<A extends { request: Request }, R>(
  fn: (args: A) => R,
  options?: WithCodmirTracingOptions,
): (args: A) => Promise<Awaited<R>> {
  return (args: A) => traceServerRequest(describe(args.request, options), () => fn(args) as Promise<Awaited<R>>);
}

/** Wraps the request handler `createRequestHandler(...)` returns, so one transaction covers the whole request. */
export function withCodmirRequestHandler<A extends [Request, ...any[]]>(
  handler: (...args: A) => Response | Promise<Response>,
  options?: WithCodmirTracingOptions,
): (...args: A) => Promise<Response> {
  return (...args: A) => traceServerRequest(describe(args[0], options), () => handler(...args));
}

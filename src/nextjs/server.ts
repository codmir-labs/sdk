/**
 * @codmir/sdk/nextjs/server (CSL-5586): `http.server` transactions for Next.js App Router route handlers and
 * middleware. Node runtime only: it needs `node:async_hooks`, so do not import it from an Edge route
 * (`export const runtime = "edge"`) or from Edge middleware; Next 15.5+ Node.js middleware is fine.
 *
 * ```ts
 * // app/api/users/[id]/route.ts
 * import { withCodmirTracing } from "@codmir/sdk/nextjs/server";
 *
 * export const GET = withCodmirTracing(async (request, { params }) => Response.json({ ok: true }), {
 *   route: "/api/users/[id]",
 * });
 * ```
 *
 * Continues an incoming `traceparent`. Nothing is sent unless `tracesSampleRate` is above 0 (default 0).
 */

import { pathOf, traceServerRequest } from "../tracing/server";

export interface WithCodmirTracingOptions {
  /**
   * The route pattern, e.g. `/api/users/[id]`. Next does not hand a route handler its own pattern, so pass it
   * to group by route; without it the transaction is named after the URL path, one per distinct id.
   */
  route?: string;
}

function describe(request: Request, options?: WithCodmirTracingOptions) {
  return {
    method: request.method,
    route: options?.route ?? pathOf(request.url),
    traceparent: request.headers.get("traceparent"),
  };
}

/**
 * Wraps an App Router route handler (`GET`, `POST`, ...). A 5xx response sets status `error`; a thrown error
 * sets `error` and is rethrown for Next to turn into its 500.
 */
export function withCodmirTracing<A extends [Request, ...any[]], R extends Response | Promise<Response>>(
  handler: (...args: A) => R,
  options?: WithCodmirTracingOptions,
): (...args: A) => Promise<Awaited<R>> {
  return (...args: A) => traceServerRequest(describe(args[0], options), () => handler(...args) as unknown as Promise<Awaited<R>>);
}

/**
 * Wraps `middleware.ts`'s function. Its transaction covers the middleware only (Next runs the route in a
 * separate invocation), and continues the caller's `traceparent`. A middleware may return nothing.
 */
export function withCodmirMiddleware<A extends [Request, ...any[]], R>(
  middleware: (...args: A) => R,
  options?: WithCodmirTracingOptions,
): (...args: A) => Promise<Awaited<R>> {
  return (...args: A) => traceServerRequest(describe(args[0], options), () => middleware(...args) as unknown as Promise<Awaited<R>>);
}

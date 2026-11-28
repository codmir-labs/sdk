/**
 * Shared core of the server request tracing wrappers: `@codmir/sdk/nextjs/server`, `/hono` and
 * `/remix/server`. Needs `AsyncLocalStorage` (Node, Bun, Deno, Next.js Edge, Workers with `nodejs_als` or `nodejs_compat`): it installs it as
 * the active-span store so concurrent requests never see each other's span. Not re-exported from `tracing/index` because that entry is also bundled for
 * browsers, which have no `node:async_hooks`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { setContextStrategy, withActiveSpan } from "./context";
import { requestScopeFrom, shareRequestScopeStore, withRequestScope, type RequestScope } from "../overseer/request-scope";
import { flushInBackground, isServerlessRuntime } from "../overseer/flush-in-background";
import { startTransaction } from "./index";
import type { Span, Transaction } from "./span";

export { flushInBackground } from "../overseer/flush-in-background";

let als: AsyncLocalStorage<Span> | undefined;
const STORE_SLOT = Symbol.for("codmir.tracing.store");

/**
 * The one place a Node async context strategy is installed: Express, Next.js, Hono and Remix all call
 * this on their first request. Idempotent, so any mix of wrappers in one process shares one AsyncLocalStorage and
 * agrees on the active span. Ids come from `globalThis.crypto`, so this module imports no Node built-in but `node:async_hooks`.
 */
export function installNodeTracingContext(): void {
  if (als) return;
  // One store per process, in a slot, so a copy of this module that comes second (Next.js bundles one per layer) shares it.
  const slots = globalThis as Record<symbol, AsyncLocalStorage<Span> | undefined>;
  const store = slots[STORE_SLOT] ?? (slots[STORE_SLOT] = new AsyncLocalStorage<Span>());
  als = store;
  setContextStrategy({ get: () => store.getStore(), run: (span, fn) => store.run(span, fn) });
  // The request an error is captured under rides the same install, so it is per async flow too.
  shareRequestScopeStore(() => new AsyncLocalStorage<RequestScope>());
}

export interface ServerRequestInfo {
  method: string;
  /** The route pattern when known (`/users/:id`), else the request path. Never a query string. */
  route: string;
  /** The incoming `traceparent` header value, if any. */
  traceparent?: string | null;
  /** The request URL: errors captured while `fn` runs carry its origin and path, never its query. */
  url?: string | null;
  /**
   * Send the transaction before the request's promise settles. Default: on a serverless runtime only (`VERCEL`,
   * `AWS_LAMBDA_FUNCTION_NAME`, `NETLIFY`, `K_SERVICE`, or a Next.js request with `waitUntil`); a long-running server
   * does not flush per request.
   */
  flushOnEnd?: boolean;
}

/** Anything with a numeric `status`: a fetch `Response`, a Hono/Next response. */
function statusOf(value: unknown): number | undefined {
  const status = (value as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/** Applies the response status to the transaction: 5xx is `error`, everything else `ok`. */
export function finishWithStatus(tx: Transaction, status: number | undefined): void {
  if (status !== undefined) tx.setData("http.response.status_code", status);
  tx.setStatus(status !== undefined && status >= 500 ? "error" : "ok");
  tx.end();
}

/** The path of a request URL, without query string or fragment; `/` for something unparseable. */
export function pathOf(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname || "/";
  } catch {
    return "/";
  }
}

/**
 * Opens an `http.server` transaction (continuing `info.traceparent`) named `METHOD route`, runs `fn` inside it,
 * and ends it with the result's status. A result or a thrown value that carries a `status` (a `Response`, as
 * Remix throws for redirects and 4xx) is classified by that status and, if thrown, rethrown. Any other throw
 * marks the transaction `error` and rethrows. Whether it is sent is `startTransaction`'s call (`tracesSampler`, else `tracesSampleRate`).
 *
 * `resolveRoute` lets the caller refine the name once `fn` has run (Hono knows its matched route only then).
 */
export async function traceServerRequest<T>(
  info: ServerRequestInfo,
  fn: (tx: Transaction) => T | Promise<T>,
  resolveRoute?: () => string | undefined,
): Promise<T> {
  installNodeTracingContext();
  const method = info.method.toUpperCase();
  const tx = startTransaction({
    op: "http.server",
    name: `${method} ${info.route}`,
    traceparent: info.traceparent,
    data: { "http.request.method": method },
    ...(info.url ? { request: { method, url: info.url.split(/[?#]/)[0] } } : {}),
  });
  const rename = (): void => {
    const route = resolveRoute?.();
    if (route) tx.name = `${method} ${route}`;
  };

  // One scope for the whole request, so the transaction ends with the tags the request set.
  const scope = info.url ? requestScopeFrom({ url: info.url, method }) : undefined;
  const inScope = <R>(f: () => R): R => (scope ? withRequestScope(scope, f) : f());

  const flushAfter = async (): Promise<void> => {
    if (info.flushOnEnd ?? isServerlessRuntime()) await flushInBackground(2000);
  };

  let result: T;
  try {
    result = await inScope(() => withActiveSpan(tx, () => fn(tx)));
  } catch (err) {
    inScope(() => {
      rename();
      const thrownStatus = statusOf(err);
      if (thrownStatus !== undefined) finishWithStatus(tx, thrownStatus);
      else {
        tx.setStatus("error");
        tx.end();
      }
    });
    await flushAfter();
    throw err;
  }
  inScope(() => {
    rename();
    finishWithStatus(tx, statusOf(result));
  });
  await flushAfter();
  return result;
}

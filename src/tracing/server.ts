/**
 * Shared core of the server request tracing wrappers (CSL-5586): `@codmir/sdk/nextjs/server`, `/hono` and
 * `/remix/server`. Node only: it installs AsyncLocalStorage as the active-span store so concurrent requests
 * never see each other's span. Not re-exported from `tracing/index` because that entry is also bundled for
 * browsers, which have no `node:async_hooks`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomFillSync } from "node:crypto";
import { setRandomFill } from "./propagation";
import { setContextStrategy, withActiveSpan } from "./context";
import { startTransaction } from "./index";
import type { Span, Transaction } from "./span";

let als: AsyncLocalStorage<Span> | undefined;

/** Idempotent. Node 18 has no `globalThis.crypto`, so ids need `randomFillSync` too. */
export function installNodeTracingContext(): void {
  if (als) return;
  setRandomFill((buf) => void randomFillSync(buf));
  const store = new AsyncLocalStorage<Span>();
  als = store;
  setContextStrategy({ get: () => store.getStore(), run: (span, fn) => store.run(span, fn) });
}

export interface ServerRequestInfo {
  method: string;
  /** The route pattern when known (`/users/:id`), else the request path. Never a query string. */
  route: string;
  /** The incoming `traceparent` header value, if any. */
  traceparent?: string | null;
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
 * marks the transaction `error` and rethrows. Whether it is sent is `startTransaction`'s call (`tracesSampleRate`).
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
  });
  const rename = (): void => {
    const route = resolveRoute?.();
    if (route) tx.name = `${method} ${route}`;
  };

  let result: T;
  try {
    result = await withActiveSpan(tx, () => fn(tx));
  } catch (err) {
    rename();
    const thrownStatus = statusOf(err);
    if (thrownStatus !== undefined) finishWithStatus(tx, thrownStatus);
    else {
      tx.setStatus("error");
      tx.end();
    }
    throw err;
  }
  rename();
  finishWithStatus(tx, statusOf(result));
  return result;
}

/**
 * CSL-5637: the request a server handler is serving, so an error captured inside it carries `request.url` (origin and
 * path) and `request.method`. Never the query string, a fragment, credentials, headers, cookies or a body.
 *
 * Browser-safe: this module imports nothing from Node. The storage is a strategy, like the tracing context's: the
 * default is a synchronous "current" slot, enough for `captureException` (which builds its event synchronously) when
 * the caller wraps it in `withRequestScope`; `installNodeTracingContext` (tracing/server.ts) swaps in AsyncLocalStorage,
 * so a capture anywhere in the handler's async tail sees its own request and never another's.
 */

export interface RequestScope {
  /** Origin and path, or just the path when the origin is unknown. No query, no fragment, no credentials. */
  url: string;
  /** Upper-case HTTP method. */
  method: string;
}

export interface RequestScopeStrategy {
  get(): RequestScope | undefined;
  run<T>(scope: RequestScope, fn: () => T): T;
}

let current: RequestScope | undefined;
const slotStrategy: RequestScopeStrategy = {
  get: () => current,
  run(scope, fn) {
    const previous = current;
    current = scope;
    try {
      return fn();
    } finally {
      current = previous;
    }
  },
};

let strategy: RequestScopeStrategy = slotStrategy;

export function setRequestScopeStrategy(next: RequestScopeStrategy): void {
  strategy = next;
}

/** The request in scope, or undefined outside any request. */
export function getRequestScope(): RequestScope | undefined {
  return strategy.get();
}

/** Runs `fn` with `scope` as the current request. */
export function withRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return strategy.run(scope, fn);
}

const cutAtQuery = (s: string): string => s.split(/[?#]/)[0] ?? "";

/**
 * A scope from a request URL, absolute (`https://h/p?q`, a fetch `Request`) or just a path (`/p?q`, Express's
 * `originalUrl`). `host` and `protocol` give the origin to a path-only URL.
 */
export function requestScopeFrom(input: { url: string; method: string; host?: string | null; protocol?: string | null }): RequestScope {
  const method = (input.method || "GET").toUpperCase();
  let url: string;
  try {
    const u = new URL(input.url);
    url = `${u.origin === "null" ? `${u.protocol}//` : u.origin}${u.pathname}`;
  } catch {
    const path = cutAtQuery(input.url) || "/";
    // A Host header is the caller's own text: take only a plain host[:port], never anything with a path or credentials.
    const host = input.host && /^[A-Za-z0-9.-]+(:\d+)?$|^\[[0-9A-Fa-f:]+\](:\d+)?$/.test(input.host) ? input.host : null;
    const proto = input.protocol === "https" || input.protocol === "http" ? input.protocol : "http";
    url = host ? `${proto}://${host}${path.startsWith("/") ? path : `/${path}`}` : path;
  }
  return { url, method };
}

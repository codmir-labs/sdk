/**
 * The request a server handler is serving, so an error captured inside it carries `request.url` (origin and
 * path) and `request.method`. Never the query string, a fragment, credentials, headers, cookies or a body.
 *
 * Browser-safe: this module imports nothing from Node. The storage is a strategy, like the tracing context's: the
 * default is a synchronous "current" slot, enough for `captureException` (which builds its event synchronously) when
 * the caller wraps it in `withRequestScope`; `installNodeTracingContext` (tracing/server.ts) swaps in AsyncLocalStorage,
 * so a capture anywhere in the handler's async tail sees its own request and never another's.
 *
 * The scope also holds the request's user, tags, breadcrumbs, conversation id and session id, so `setUser`, `setTag`, `setTags`, `addBreadcrumb`, `setConversationId` and `setSessionId`
 * inside a request never reach another one, and an event or transaction takes the process-wide state with the request's on
 * top. Where the scope does not survive an `await` (no `installNodeTracingContext`), a later write is outside it and is the
 * client's.
 */

import type { Breadcrumb, UserContext } from "./index";

export interface RequestScope {
  /** Origin and path, or just the path when the origin is unknown. No query, no fragment, no credentials. */
  url: string;
  /** Upper-case HTTP method. */
  method: string;
  /**
   * Who this request is for. `undefined`: not known, so an event takes the client's own user. `null`: nobody, and an
   * event inside the request has no user, never the client's. `setUser` inside the request sets it; the client's is left alone.
   */
  user?: UserContext | null;
  /** The request's own tags, set by `setTag` and `setTags` inside it. They win over the process-wide tags, key by key. */
  tags?: Record<string, string>;
  /** The request's own breadcrumbs, at most the newest 20, which an event carries after the process-wide ones. */
  breadcrumbs?: Breadcrumb[];
  /** The request's conversation id, set by `setConversationId` inside it. `undefined`: not set, so the client's is used; `null`: none. */
  conversationId?: string | null;
  /** The request's session id, set by `setSessionId` inside it, read as `conversationId` is. A batch never carries it. */
  sessionId?: string | null;
  /** Set on a scope a setter opened on its own (see `scopeForWrite`): the generation it belongs to, which `close` ends. */
  openedAt?: number;
  /** Brings `user` up to date at the moment an event is built (Express: `req.user` may have been set since the scope opened). Must not throw. */
  refreshUser?: () => void;
}

export interface RequestScopeStrategy {
  get(): RequestScope | undefined;
  run<T>(scope: RequestScope, fn: () => T): T;
}

/**
 * The AsyncLocalStorage that holds the requests: one per process, in a `Symbol.for` slot, because a bundler may load
 * this module more than once (Next.js: instrumentation and each route) and a scope opened by one copy must be seen by
 * the others. This module cannot import Node, so `installNodeTracingContext` hands the store over.
 */
interface RequestStore {
  getStore(): RequestScope | undefined;
  run<T>(scope: RequestScope, fn: () => T): T;
  enterWith?(scope: RequestScope): void;
}
const STORE_SLOT = Symbol.for("codmir.request-scope.store");
const slots = globalThis as Record<symbol, RequestStore | undefined>;

/** Creates the process's request store on first use; every later call, from any copy of the module, keeps it. */
export function shareRequestScopeStore(create: () => RequestStore): void {
  if (!slots[STORE_SLOT]) slots[STORE_SLOT] = create();
}

/**
 * Set by `@codmir/sdk/nextjs` on a server: a setter (`setUser`, `setTag`, `setTags`, `addBreadcrumb`, `setConversationId`,
 * `setSessionId`) that runs with no request scope then opens one for the rest of its async context instead of writing
 * the process-wide state. A Next.js route handler, server action or server component the app did not wrap has no scope,
 * and two of them in flight would otherwise hand each other's user to every later event.
 */
const OPEN_ON_WRITE_SLOT = Symbol.for("codmir.request-scope.open-on-write");

/** The generation of opened scopes, in a slot like the store so every copy of this module agrees. `close` ends it. */
const GENERATION_SLOT = Symbol.for("codmir.request-scope.generation");
const generation = (): number => ((globalThis as Record<symbol, unknown>)[GENERATION_SLOT] as number | undefined) ?? 0;

/** Ends every scope a setter opened on its own: `close` and a second `init` start clean, as they do for the client's own state. */
export function retireOpenedScopes(): void {
  (globalThis as Record<symbol, unknown>)[GENERATION_SLOT] = generation() + 1;
}

/** From now on a setter with no request scope in effect opens its own (see {@link scopeForWrite}). */
export function openScopeOnWrite(): void {
  (globalThis as Record<symbol, unknown>)[OPEN_ON_WRITE_SLOT] = true;
}

/**
 * The scope a setter writes to: the request's, else, when `openScopeOnWrite` was called and the process has a request
 * store, a new one entered with `enterWith`, so the write and every later read in this async context and what it starts
 * see it and no other request does. Else undefined, and the setter writes the process-wide state, as it always did.
 * The scope it opens has no `url` and no `method`: it is not a request, so an event has no `request` for it.
 */
export function scopeForWrite(): RequestScope | undefined {
  const own = getRequestScope();
  if (own) return own;
  const store = slots[STORE_SLOT];
  if (!store?.enterWith || !(globalThis as Record<symbol, unknown>)[OPEN_ON_WRITE_SLOT]) return undefined;
  const fresh: RequestScope = { url: "", method: "", openedAt: generation() };
  store.enterWith(fresh);
  return fresh;
}

let current: RequestScope | undefined;
const slotStrategy: RequestScopeStrategy = {
  get: () => slots[STORE_SLOT]?.getStore() ?? current,
  run(scope, fn) {
    const store = slots[STORE_SLOT];
    if (store) return store.run(scope, fn);
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
  const scope = strategy.get();
  return scope?.openedAt !== undefined && scope.openedAt !== generation() ? undefined : scope;
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

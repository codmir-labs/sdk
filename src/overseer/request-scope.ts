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
  /** Set on a scope the server gave a request on its own (see `withOwnRequestScope`): the generation it belongs to, which `close` ends. */
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
}
const STORE_SLOT = Symbol.for("codmir.request-scope.store");
const slots = globalThis as Record<symbol, RequestStore | undefined>;

/** Creates the process's request store on first use; every later call, from any copy of the module, keeps it. */
export function shareRequestScopeStore(create: () => RequestStore): void {
  if (!slots[STORE_SLOT]) slots[STORE_SLOT] = create();
}

/**
 * Installs the process's request store when none is installed yet, and says whether the process has one. Node 20.16+ and
 * 22.3+ hand `AsyncLocalStorage` over through `process.getBuiltinModule`, so this module imports nothing from Node; an
 * older Node or an edge runtime has none to give and the answer is false. Never throws.
 */
export function installRequestScopeStore(): boolean {
  if (slots[STORE_SLOT]) return true;
  try {
    const getBuiltinModule = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
    const hooks = getBuiltinModule?.("node:async_hooks") as { AsyncLocalStorage?: new () => RequestStore } | undefined;
    const Store = hooks?.AsyncLocalStorage;
    if (Store) shareRequestScopeStore(() => new Store());
  } catch {
    // no process.getBuiltinModule here
  }
  return !!slots[STORE_SLOT];
}

/** Whether the process has an async store, so a scope opened now is still there after an `await`. */
export function requestScopeSurvivesAwait(): boolean {
  return !!slots[STORE_SLOT];
}

/**
 * Set by `@codmir/sdk/nextjs` on a server: each request of the HTTP server then runs with a scope of its own (see
 * {@link withOwnRequestScope}), so a setter (`setUser`, `setTag`, `setTags`, `addBreadcrumb`, `setConversationId`,
 * `setSessionId`) inside a request the app did not wrap writes to that request, and two in flight never hand each
 * other's user to a later event. Outside any request a setter stays process-wide.
 */
const OPEN_ON_WRITE_SLOT = Symbol.for("codmir.request-scope.open-on-write");

/** The generation of opened scopes, in a slot like the store so every copy of this module agrees. `close` ends it. */
const GENERATION_SLOT = Symbol.for("codmir.request-scope.generation");
const generation = (): number => ((globalThis as Record<symbol, unknown>)[GENERATION_SLOT] as number | undefined) ?? 0;

/** Ends every scope a setter opened on its own: `close` and a second `init` start clean, as they do for the client's own state. */
export function retireOpenedScopes(): void {
  (globalThis as Record<symbol, unknown>)[GENERATION_SLOT] = generation() + 1;
}

/** From now on `withOwnRequestScope` gives its callback a scope of its own. */
export function openScopeOnWrite(): void {
  (globalThis as Record<symbol, unknown>)[OPEN_ON_WRITE_SLOT] = true;
}

/**
 * The scope a setter writes to: the request's, else undefined, and the setter writes the process-wide state, as it always
 * did. A setter outside any request (module top level, `register()`, a startup script, a timer) is the process's, so
 * every request that starts after it carries its value. Nothing here opens a scope with `enterWith`: that would run
 * outside a request too and no request would ever see it.
 */
export function scopeForWrite(): RequestScope | undefined {
  return getRequestScope();
}

/**
 * Runs `fn` as one request with an empty scope of its own, whatever the caller's async context held, when
 * `openScopeOnWrite` was called and the process has a request store; else `fn` runs as it is. A setter inside `fn` finds
 * the scope and writes to it, so it never reaches another request, and `close` retires it (`openedAt`). The scope is not
 * a request: it has no `url` and no `method`, so an event has no `request` for it.
 */
export function withOwnRequestScope<T>(fn: () => T): T {
  const store = slots[STORE_SLOT];
  if (!store || !(globalThis as Record<symbol, unknown>)[OPEN_ON_WRITE_SLOT]) return fn();
  return store.run({ url: "", method: "", openedAt: generation() }, fn);
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

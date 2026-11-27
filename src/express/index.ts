/**
 * @codmir/sdk/express - Express.js Integration
 *
 * Automatic error tracking, request context enrichment, and performance
 * monitoring for Express.js applications.
 *
 * @example
 * ```typescript
 * import * as Codmir from '@codmir/sdk/express';
 * import express from 'express';
 *
 * Codmir.init({
 *   dsn: process.env.CODMIR_DSN,
 *   environment: process.env.NODE_ENV,
 *   extractUser: (req) => (req.user ? { id: req.user.id } : null),
 * });
 *
 * const app = express();
 *
 * // Must be first middleware
 * app.use(Codmir.requestHandler());
 * app.use(Codmir.tracingHandler());
 *
 * // Your routes...
 * app.get('/', (req, res) => res.send('OK'));
 *
 * // Must be after all routes
 * app.use(Codmir.errorHandler());
 * ```
 */

import {
  init as coreInit,
  captureException as coreCaptureException,
  captureMessage as coreCaptureMessage,
  setUser as coreSetUser,
  setTag as coreSetTag,
  setTags as coreSetTags,
  addBreadcrumb as coreAddBreadcrumb,
  flush as coreFlush,
  close as coreClose,
  getClient,
  sendsDefaultPii,
  type OverseerConfig,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
} from "../overseer/index";
import { Stops } from "../overseer/lifecycle";
import { withHint, crash } from "../overseer/capture-hint";
import { instrumentFetch } from "../tracing/fetch";
import { startTransaction, withActiveSpan, type Span } from "../tracing/index";
import { installNodeTracingContext } from "../tracing/server";
import { getRequestScope, requestScopeFrom, withRequestScope, type RequestScope } from "../overseer/request-scope";
import { bindEmitter } from "./bind-emitter";

// =============================================================================
// Inline Express Types (no @types/express dependency)
// =============================================================================

interface ExpressRequest {
  method: string;
  url: string;
  originalUrl: string;
  path: string;
  baseUrl: string;
  params: Record<string, string>;
  route?: { path?: unknown };
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  /** `http` or `https`; set by Express (and by `trust proxy` from X-Forwarded-Proto). */
  protocol?: string;
  body?: unknown;
  ip?: string;
  user?: Record<string, unknown>;
  /** Codmir context attached by requestHandler */
  _codmir?: CodemirRequestContext;
}

interface ExpressResponse {
  statusCode: number;
  on(event: string, listener: (...args: unknown[]) => void): ExpressResponse;
}

type NextFunction = (err?: unknown) => void;

type RequestMiddleware = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction
) => void;

type ErrorMiddleware = (
  err: unknown,
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction
) => void;

// =============================================================================
// Types
// =============================================================================

export interface ExpressConfig extends OverseerConfig {
  /**
   * Capture uncaught exceptions and unhandled rejections as fatal and send the queue before the process ends, and flush
   * on SIGTERM and SIGINT. See `OverseerConfig.captureProcessErrors`. Unlike the core `init`, this is on here unless
   * set to `false`.
   * @default true
   */
  captureProcessErrors?: boolean;

  /**
   * @deprecated Ignored: a request body is never put in an error report, because it may hold
   * credentials and personal data. Kept so existing `init({ captureRequestBody })` calls still type-check.
   */
  captureRequestBody?: boolean;

  /**
   * Capture response body in error reports.
   * Disabled by default for privacy — may contain sensitive data.
   * @default false
   */
  captureResponseBody?: boolean;

  /**
   * Extract user context from the request object.
   * Called when `requestHandler()` runs, and again, at most once per change of `req.user`, when an event is captured in
   * the request after a later middleware (an auth check) has set `req.user`. A user set with `setUser` in the request wins. The answer is this request's user and no other request's: `null` (or `undefined`) means
   * nobody, not the process-wide user. One that throws leaves the request without a user.
   *
   * @example
   * ```typescript
   * extractUser: (req) => (req.user ? { id: req.user.id } : null)
   * ```
   *
   * An event sends the user's `id` and `username` only (the `email` when there is no `id`). Other keys, such as
   * `ip_address: req.ip`, are sent only with `sendDefaultPii: true`.
   */
  extractUser?: (req: ExpressRequest) => UserContext | null;
}

interface CodemirRequestContext {
  startTime: number;
  eventId?: string;
  /** The `http.server` transaction opened by tracingHandler. */
  span?: Span;
  /** The request's scope: its url, method and user, the one every capture in its async tail sees. */
  scope?: RequestScope;
  /** What `req.user` was when `extractUser` last ran, to tell a later `req.user` from it. */
  userSeen?: unknown;
  /** What `extractUser` last put in the scope, to tell a user `setUser` set since from it. */
  userExtracted?: UserContext | null;
}

/** Headers stripped from error reports to avoid leaking secrets */
// =============================================================================
// Express-Specific Initialization
// =============================================================================

let isInitialized = false;
let expressConfig: ExpressConfig = {};
/** What `init` started, ended by `close`. */
const stops = new Stops();

/**
 * Initialize the Codmir SDK for Express.js.
 * Must be called before creating middleware handlers.
 */
export function init(config: ExpressConfig = {}): void {
  if (isInitialized) return;

  const {
    captureRequestBody = false,
    captureResponseBody = false,
    extractUser,
    captureProcessErrors = true,
    ...coreConfig
  } = config;

  // Store Express-specific config for middleware use
  expressConfig = {
    captureRequestBody,
    captureResponseBody,
    extractUser,
  };

  // Initialize core
  coreInit({ ...coreConfig, captureProcessErrors });
  isInitialized = true;

  // Tracing: outgoing fetches become child spans and carry traceparent.
  stops.add(instrumentFetch({ breadcrumbs: false }));
}

/**
 * Ends what `init` started: the `fetch` patch (put back when it is still on top, and otherwise passing calls on) and the
 * core client, which sends what it holds. A later `init` starts clean, with its own config. An error captured after
 * `close` and before the next `init` is sent once, without retries. Also removes the process hooks `init` installed.
 * Resolves `true` when the queue was sent within `timeoutMs` (default 2000), so a shutdown hook can wait for it.
 */
export function close(timeoutMs?: number): Promise<boolean> {
  stops.run();
  isInitialized = false;
  expressConfig = {};
  return coreClose(timeoutMs);
}

/** The request's path, never its query string or fragment: a breadcrumb or transaction name is an event field too. */
function pathOnly(req: ExpressRequest): string {
  return (req.originalUrl || req.url).split(/[?#]/)[0] || "/";
}

/** Origin and path of the request, and its method. Never the query string, headers or cookies (the Host header only names the origin). */
function scopeOf(req: ExpressRequest): RequestScope {
  const host = req.headers.host;
  return requestScopeFrom({
    url: req.originalUrl || req.url,
    method: req.method,
    host: Array.isArray(host) ? host[0] : host,
    protocol: req.protocol,
  });
}

// =============================================================================
// Request Handler Middleware
// =============================================================================

/**
 * Request handler middleware — must be the first Codmir middleware.
 *
 * Adds a breadcrumb for each incoming request, attaches Codmir context
 * to the request object, and extracts user context if configured.
 *
 * @example
 * ```typescript
 * app.use(Codmir.requestHandler());
 * ```
 */
export function requestHandler(): RequestMiddleware {
  return (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    // Attach context for downstream middleware
    const scope = scopeOf(req);
    req._codmir = {
      startTime: Date.now(),
      scope,
    };
    // `req.user` is usually set by a middleware after this one: an event captured later looks the user up again.
    scope.refreshUser = () => refreshUser(req, scope);

    // Add request breadcrumb, inside the request's scope so it belongs to this request only
    withRequestScope(scope, () =>
      coreAddBreadcrumb({
        type: "http",
        category: "http.request",
        message: `${req.method} ${pathOnly(req)}`,
        data: {
          method: req.method,
          url: pathOnly(req),
          path: req.path,
        },
        level: "info",
      }),
    );

    // The request's own user, from `extractUser`: nobody when it answers nothing or throws.
    if (expressConfig.extractUser) extractInto(req, scope);

    // Everything downstream, async tail included, captures under this request.
    installNodeTracingContext();
    // A listener on `req` or `res` runs where its event is emitted, in the HTTP parser's context. Bound at the moment it is
    // added, it keeps the scope and the active span of whoever added it, so a middleware that continues from `req.on("end")`
    // (an upload parser, a body reader, a pipe callback) hands the rest of the request on with both.
    if (isInitialized) {
      bindEmitter(req, () => isInitialized);
      bindEmitter(res, () => isInitialized);
    }
    withRequestScope(scope, () => next());
  };
}

/**
 * Makes the listeners added to `emitter` from now on keep the request's scope and active span, as the ones on `req` and
 * `res` do. Call it, inside a request, on an emitter a middleware makes (a busboy stream, say). Outside a request it changes
 * nothing.
 *
 * @example
 * ```typescript
 * app.use((req, res, next) => {
 *   const form = bindToRequest(busboy({ headers: req.headers }));
 *   form.on('close', next);
 *   req.pipe(form);
 * });
 * ```
 */
export function bindToRequest<T extends object>(emitter: T): T {
  if (isInitialized && getRequestScope()) bindEmitter(emitter, () => isInitialized);
  return emitter;
}

/** Sets the request's user to what `extractUser` answers, and never lets it break the request. */
function extractInto(req: ExpressRequest, scope: RequestScope): void {
  const ctx = req._codmir;
  if (ctx) ctx.userSeen = req.user;
  try {
    scope.user = expressConfig.extractUser?.(req) || null;
  } catch {
    scope.user = null;
  }
  if (ctx) ctx.userExtracted = scope.user;
}

/**
 * Runs `extractUser` again when `req.user` is not what it was at the last run, so an event captured after an auth
 * middleware has the signed-in user. A user `setUser` has put in the scope since the last run is kept.
 */
function refreshUser(req: ExpressRequest, scope: RequestScope): void {
  const ctx = req._codmir;
  if (!ctx || !expressConfig.extractUser || req.user === ctx.userSeen) return;
  if (scope.user !== ctx.userExtracted) {
    ctx.userSeen = req.user;
    return;
  }
  extractInto(req, scope);
}

/** The HTTP status an error carries (`status`, `statusCode`, or `output.statusCode` as a boom error has it), 100 to 599, else undefined. */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  try {
    const e = err as { status?: unknown; statusCode?: unknown; output?: { statusCode?: unknown } | null };
    for (const v of [e.status, e.statusCode, e.output?.statusCode]) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599) return v;
    }
  } catch {
    // a throwing getter means no status
  }
  return undefined;
}

const defaultShouldHandleError = (err: unknown): boolean => {
  const status = statusOf(err);
  return status === undefined || status >= 500;
};

export interface ErrorHandlerOptions {
  /**
   * Decides whether an error reaching `errorHandler()` is sent. Default: only an error with no HTTP status, or a status of
   * 500 or more (read from `status`, then `statusCode`, then `output.statusCode`). Whatever it answers, the error is passed on
   * with `next(err)`. One that throws counts as `false`.
   */
  shouldHandleError?: (error: unknown, req: ExpressRequest, res: ExpressResponse) => boolean;
}

// =============================================================================
// Error Handler Middleware
// =============================================================================

/**
 * Error handler middleware — must be registered after all routes.
 *
 * Captures exceptions with full request context including method, URL,
 * headers (with sensitive values stripped), query parameters, and route params.
 * Calls `next(err)` so the error is not swallowed. An error with a 4xx status is passed on and not sent, unless
 * `shouldHandleError` says so.
 *
 * @example
 * ```typescript
 * // After all route definitions
 * app.use(Codmir.errorHandler());
 * ```
 */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorMiddleware {
  const shouldHandle = options.shouldHandleError ?? defaultShouldHandleError;
  return (
    err: unknown,
    req: ExpressRequest,
    res: ExpressResponse,
    next: NextFunction
  ): void => {
    let handle = false;
    try {
      handle = shouldHandle(err, req, res);
    } catch {
      // a predicate that throws sends nothing, and the error still goes on
    }
    if (!handle) {
      next(err);
      return;
    }
    // Never the request's headers, cookies, query, params or body. The event's `request` (origin, path, method)
    // comes from the scope below; the route pattern is the one safe thing to add.
    const requestContext: Record<string, unknown> = withHint({}, crash("express-error-handler"));
    if (typeof req.route?.path === "string") requestContext.route = `${req.baseUrl ?? ""}${req.route.path}`;

    // The request's scope is the one `requestHandler` made, with the user `setUser` or `extractUser` gave it.
    const scope = req._codmir?.scope ?? scopeOf(req);
    // `extractUser` runs again only when a later middleware has set `req.user` since.
    if (expressConfig.extractUser) {
      if (req._codmir?.scope) refreshUser(req, scope);
      else extractInto(req, scope);
    }
    if (expressConfig.extractUser && scope.user) requestContext.user = scope.user;

    // The client IP is personal data: only with `sendDefaultPii: true`.
    if (req.ip && sendsDefaultPii()) {
      requestContext.clientIp = req.ip;
    }

    // Capture the exception
    const eventId = withRequestScope(scope, () => coreCaptureException(err, requestContext));

    // Store event ID on request for downstream access
    if (req._codmir) {
      req._codmir.eventId = eventId;
    }

    // Do not swallow the error — pass to next error handler
    next(err);
  };
}

// =============================================================================
// Tracing Handler Middleware
// =============================================================================

/**
 * Tracing handler middleware for performance monitoring.
 *
 * Continues an incoming W3C `traceparent` (or starts a new trace), opens an `http.server` transaction named
 * `METHOD /route`, runs the rest of the chain inside it so spans and outgoing fetches nest under it, and
 * finishes it when the response ends. Whether it is sent is decided by `tracesSampleRate` (default 0) and
 * the incoming sampled flag. Also records the response duration as a breadcrumb.
 *
 * @example
 * ```typescript
 * app.use(Codmir.requestHandler());
 * app.use(Codmir.tracingHandler());
 * ```
 */
export function tracingHandler(): RequestMiddleware {
  return (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    // Node has async context; the browser-safe default stack would mix up concurrent requests. The one shared
    // strategy is installed on the first request any server wrapper sees, and never again.
    installNodeTracingContext();
    const startTime = req._codmir?.startTime ?? Date.now();
    const header = req.headers["traceparent"];
    const tx = startTransaction({
      op: "http.server",
      name: `${req.method} ${pathOnly(req)}`,
      traceparent: Array.isArray(header) ? header[0] : header,
      data: { "http.request.method": req.method },
    });
    if (req._codmir) req._codmir.span = tx;

    const scope = req._codmir?.scope ?? scopeOf(req);
    let finished = false;
    // "finish" and "close" may fire outside the request's async context: end the transaction and add the response
    // breadcrumb inside its scope, so they carry this request's tags and breadcrumbs only.
    const finish = (): void => {
      if (finished) return;
      finished = true;
      withRequestScope(scope, end);
    };
    const end = (): void => {
      const duration = Date.now() - startTime;

      // The route pattern, never the raw URL: `/users/:id` groups, `/users/42` would be one transaction per id.
      const routePath = typeof req.route?.path === "string" ? req.route.path : undefined;
      tx.name = `${req.method} ${routePath ? `${req.baseUrl ?? ""}${routePath}` : req.path || req.url}`;
      tx.setData("http.response.status_code", res.statusCode);
      tx.setStatus(res.statusCode >= 500 ? "error" : "ok");
      tx.end();

      coreAddBreadcrumb({
        type: "http",
        category: "http.response",
        message: `${req.method} ${pathOnly(req)} ${res.statusCode}`,
        data: {
          method: req.method,
          url: pathOnly(req),
          statusCode: res.statusCode,
          durationMs: duration,
        },
        level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warning" : "info",
      });
    };
    res.on("finish", finish);
    // A client that hangs up never gets a "finish".
    res.on("close", finish);

    withRequestScope(scope, () => withActiveSpan(tx, () => next()));
  };
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  getClient,
  type OverseerConfig,
  type OverseerEvent,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
} from "../overseer/index";

// Alias core functions for direct use
export const captureException = coreCaptureException;
export const captureMessage = coreCaptureMessage;
export const setUser = coreSetUser;
export const setTag = coreSetTag;
export const setTags = coreSetTags;
export const addBreadcrumb = coreAddBreadcrumb;
export const flush = coreFlush;

/**
 * Check if Overseer is initialized for Express
 */
export function isOverseerInitialized(): boolean {
  return isInitialized && getClient() !== null;
}

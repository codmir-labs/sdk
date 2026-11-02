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
 *   extractUser: (req) => ({ id: req.user?.id, email: req.user?.email }),
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
  type OverseerConfig,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
} from "../overseer/index";
import { instrumentFetch } from "../tracing/fetch";
import { startTransaction, withActiveSpan, type Span } from "../tracing/index";
import { installNodeTracingContext } from "../tracing/server";
import { requestScopeFrom, withRequestScope, type RequestScope } from "../overseer/request-scope";

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
   * Capture request body in error reports.
   * Disabled by default for privacy — may contain sensitive data.
   * @default false
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
   * Called on each request to populate Overseer user context.
   *
   * @example
   * ```typescript
   * extractUser: (req) => ({
   *   id: req.user?.id,
   *   email: req.user?.email,
   *   ip_address: req.ip,
   * })
   * ```
   */
  extractUser?: (req: ExpressRequest) => UserContext | null;
}

interface CodemirRequestContext {
  startTime: number;
  eventId?: string;
  /** The `http.server` transaction opened by tracingHandler. */
  span?: Span;
}

/** Headers stripped from error reports to avoid leaking secrets */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

// =============================================================================
// Express-Specific Initialization
// =============================================================================

let isInitialized = false;
let expressConfig: ExpressConfig = {};

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
    ...coreConfig
  } = config;

  // Store Express-specific config for middleware use
  expressConfig = {
    captureRequestBody,
    captureResponseBody,
    extractUser,
  };

  // Initialize core
  coreInit(coreConfig);
  isInitialized = true;

  // Tracing: outgoing fetches become child spans and carry traceparent (CSL-5575).
  instrumentFetch({ breadcrumbs: false });
}

/** CSL-5637: origin and path of the request, and its method. Never the query string, headers or cookies (the Host header only names the origin). */
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
  return (req: ExpressRequest, _res: ExpressResponse, next: NextFunction): void => {
    // Attach context for downstream middleware
    req._codmir = {
      startTime: Date.now(),
    };

    // Add request breadcrumb
    coreAddBreadcrumb({
      type: "http",
      category: "http.request",
      message: `${req.method} ${req.originalUrl || req.url}`,
      data: {
        method: req.method,
        url: req.originalUrl || req.url,
        path: req.path,
        params: Object.keys(req.params).length > 0 ? req.params : undefined,
        query: Object.keys(req.query).length > 0 ? req.query : undefined,
      },
      level: "info",
    });

    // Extract and set user context if configured
    if (expressConfig.extractUser) {
      const user = expressConfig.extractUser(req);
      if (user) {
        coreSetUser(user);
      }
    }

    // Everything downstream, async tail included, captures under this request (CSL-5637).
    installNodeTracingContext();
    withRequestScope(scopeOf(req), () => next());
  };
}

// =============================================================================
// Error Handler Middleware
// =============================================================================

/**
 * Error handler middleware — must be registered after all routes.
 *
 * Captures exceptions with full request context including method, URL,
 * headers (with sensitive values stripped), query parameters, and route params.
 * Calls `next(err)` so the error is not swallowed.
 *
 * @example
 * ```typescript
 * // After all route definitions
 * app.use(Codmir.errorHandler());
 * ```
 */
export function errorHandler(): ErrorMiddleware {
  return (
    err: unknown,
    req: ExpressRequest,
    _res: ExpressResponse,
    next: NextFunction
  ): void => {
    // Build sanitized headers
    const sanitizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!SENSITIVE_HEADERS.has(key.toLowerCase()) && value !== undefined) {
        sanitizedHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    // Build request context
    const requestContext: Record<string, unknown> = {
      mechanism: "express-error-handler",
      request: {
        method: req.method,
        url: req.originalUrl || req.url,
        path: req.path,
        baseUrl: req.baseUrl,
        headers: sanitizedHeaders,
        query: req.query,
        params: req.params,
      },
    };

    // Optionally include request body
    if (expressConfig.captureRequestBody && req.body !== undefined) {
      (requestContext.request as Record<string, unknown>).body = req.body;
    }

    // Extract user context if configured
    if (expressConfig.extractUser) {
      const user = expressConfig.extractUser(req);
      if (user) {
        coreSetUser(user);
        requestContext.user = user;
      }
    }

    // Add client IP if available
    if (req.ip) {
      requestContext.clientIp = req.ip;
    }

    // Capture the exception
    const eventId = withRequestScope(scopeOf(req), () => coreCaptureException(err, requestContext));

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
    // strategy is installed on the first request any server wrapper sees, and never again (CSL-5593).
    installNodeTracingContext();
    const startTime = req._codmir?.startTime ?? Date.now();
    const header = req.headers["traceparent"];
    const tx = startTransaction({
      op: "http.server",
      name: `${req.method} ${req.originalUrl || req.url}`,
      traceparent: Array.isArray(header) ? header[0] : header,
      data: { "http.request.method": req.method },
    });
    if (req._codmir) req._codmir.span = tx;

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
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
        message: `${req.method} ${req.originalUrl || req.url} ${res.statusCode}`,
        data: {
          method: req.method,
          url: req.originalUrl || req.url,
          statusCode: res.statusCode,
          durationMs: duration,
        },
        level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warning" : "info",
      });
    };
    res.on("finish", finish);
    // A client that hangs up never gets a "finish".
    res.on("close", finish);

    withRequestScope(scopeOf(req), () => withActiveSpan(tx, () => next()));
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
export const close = coreClose;

/**
 * Check if Overseer is initialized for Express
 */
export function isOverseerInitialized(): boolean {
  return isInitialized && getClient() !== null;
}

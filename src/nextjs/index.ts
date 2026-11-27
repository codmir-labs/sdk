/**
 * @codmir/sdk/nextjs - Next.js Integration
 *
 * Automatic error tracking, session replay, and performance
 * monitoring for Next.js applications.
 *
 * @example
 * ```typescript
 * // instrumentation.ts
 * import * as Codmir from '@codmir/sdk/nextjs';
 *
 * Codmir.init({
 *   dsn: process.env.NEXT_PUBLIC_CODMIR_DSN,
 *   environment: process.env.NODE_ENV,
 * });
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
import { detectNextClientHost } from "../overseer/detect";
import { listen, Stops } from "../overseer/lifecycle";
import { withHint, crash, eventFrame } from "../overseer/capture-hint";
import { installBrowserBreadcrumbs, type ConsoleMethod } from "../overseer/browser-breadcrumbs";
import { scrubUrl } from "../overseer/url-scrub";
import { getRequestScope, requestScopeFrom, withRequestScope, type RequestScope } from "../overseer/request-scope";
import { flushInBackground, isServerlessRuntime } from "../overseer/flush-in-background";

// =============================================================================
// Types
// =============================================================================

export interface NextjsConfig extends OverseerConfig {
  /** Automatically capture unhandled errors */
  captureUnhandledErrors?: boolean;
  /** Automatically capture unhandled promise rejections */
  captureUnhandledRejections?: boolean;
  /** Track route changes as breadcrumbs. The older name of `trackNavigation`, which wins when both are set. */
  trackRouteChanges?: boolean;
  /** Track clicks as `ui.click` breadcrumbs (default: true) */
  trackClicks?: boolean;
  /** Track inputs as `ui.input` breadcrumbs, never the value (default: false) */
  trackInputs?: boolean;
  /** Track `fetch` and XHR requests as breadcrumbs (default: true) */
  trackRequests?: boolean;
  /** Track route changes as breadcrumbs (default: true) */
  trackNavigation?: boolean;
  /** Track console output as breadcrumbs: `true` is `["error", "warn"]` (default), or list the methods */
  trackConsole?: boolean | ConsoleMethod[];
  /** Enable session replay */
  enableReplay?: boolean;
}

export interface RequestError {
  digest?: string;
  message?: string;
  name?: string;
  stack?: string;
}

export interface ErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
  renderSource?: string;
  revalidateReason?: string;
}

// =============================================================================
// Next.js Specific Initialization
// =============================================================================

let isInitialized = false;
/**
 * Error objects already sent, by identity, so one error is one event and nothing is kept alive. One set per process, in a
 * `Symbol.for` slot, because Next.js bundles `instrumentation.ts` and each page separately and may load this module more
 * than once: the copy that sent an error and the copy that sees it again must share the set.
 */
const SENT_SLOT = Symbol.for("codmir.nextjs.sent-errors");
const slots = globalThis as Record<symbol, WeakSet<object> | undefined>;
/** True when `error` was sent before; otherwise marks it as sent. A value that is not an object is never remembered. */
function alreadySent(error: unknown): boolean {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return false;
  const sent = (slots[SENT_SLOT] ??= new WeakSet<object>());
  if (sent.has(error)) return true;
  sent.add(error);
  return false;
}
/** Next's `error.digest` when it is a non-empty string: the hash that a server error and its client report share. */
function digestOf(error: unknown): string | undefined {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest;
  return typeof digest === "string" && digest ? digest : undefined;
}
/** `scope` with the tag `digest` added when the error has one. */
function withDigest(scope: RequestScope, error: unknown): RequestScope {
  const digest = digestOf(error);
  return digest ? { ...scope, tags: { ...scope.tags, digest } } : scope;
}
/** What `init` started in a browser, ended by `close`. */
const stops = new Stops();

export function init(config: NextjsConfig = {}): void {
  if (isInitialized) return;

  const {
    captureUnhandledErrors = true,
    captureUnhandledRejections = true,
    trackRouteChanges = true,
    trackNavigation = trackRouteChanges,
    trackClicks,
    trackInputs,
    trackRequests,
    trackConsole,
    enableReplay = false,
    ...coreConfig
  } = config;

  // Vercel exposes these two to client bundles when system environment variables are exposed. Each is read on its own,
  // as a literal, so the bundler inlines it even where there is no `process`; an explicit value, and on a server the
  // plain variables, win.
  const host = typeof window !== "undefined" ? detectNextClientHost() : { release: "", environment: "" };
  const release = coreConfig.release || host.release;
  const environment = coreConfig.environment || host.environment;

  // Initialize core
  coreInit({
    ...coreConfig,
    ...(release?.trim() ? { release: release.trim() } : {}),
    ...(environment?.trim() ? { environment: environment.trim() } : {}),
  });
  isInitialized = true;

  // Browser-only setup
  if (typeof window !== "undefined") {
    // Global error handler
    if (captureUnhandledErrors) {
      stops.add(
        listen(window, "error", (event: ErrorEvent) => {
          if (alreadySent(event.error)) return;
          coreCaptureException(event.error || event.message, withHint({}, crash("onerror", undefined, eventFrame(event))));
        }),
      );
    }

    // Unhandled rejection handler
    if (captureUnhandledRejections) {
      stops.add(
        listen(window, "unhandledrejection", (event: PromiseRejectionEvent) => {
          if (alreadySent(event.reason)) return;
          coreCaptureException(event.reason, withHint({}, crash("onunhandledrejection", undefined, "none")));
        }),
      );
    }

    // Clicks, inputs, requests, route changes and console output: the set every browser entry records.
    stops.add(installBrowserBreadcrumbs({ trackClicks, trackInputs, trackRequests, trackNavigation, trackConsole }));
  }
}

/**
 * Ends what `init` started: the global handlers and the breadcrumbs (the `console`, `fetch`, XHR and `history` patches go back when they are
 * still on top, and otherwise only pass calls on), then the core client, which sends what it holds. A later `init`
 * starts clean, with its own config. An error captured after `close` and before the next `init` is sent once, without
 * retries.
 */
export function close(): void {
  stops.run();
  isInitialized = false;
  coreClose();
}

// =============================================================================
// Server-Side Helpers
// =============================================================================

/**
 * Capture a server-side request error (App Router). One Error object is sent once across this, `captureRouterError` and
 * `captureUnderscoreErrorException`, and Next's `error.digest` goes as the tag `digest`. The event is only queued: `await flushRequestError()` before the
 * response on a serverless platform, or the function may be frozen first.
 */
export function captureRequestError(
  error: RequestError,
  errorContext: Partial<ErrorContext>,
  request?: Request
): string {
  // No request object, headers or cookies in the context. The event's `request` (origin, path, method) comes from
  // the scope below; the route pattern is `errorContext.routePath`.
  if (alreadySent(error)) return "";
  const capture = (): string =>
    coreCaptureException(
      error,
      withHint(
        { ...errorContext, ...(errorContext.routePath ? { route: errorContext.routePath } : {}) },
        crash("server"),
      ),
    );
  if (request) return withRequestScope(withDigest(requestScopeFrom({ url: request.url, method: request.method }), error), capture);
  const digest = digestOf(error);
  if (!digest) return capture();
  const base = getRequestScope();
  return withRequestScope({ url: base?.url ?? "", method: base?.method ?? "GET", ...base, tags: { ...base?.tags, digest } }, capture);
}

/** Sends what `captureRequestError` queued: awaited, or handed to Next's `waitUntil` when the request has one. */
export const flushRequestError = (): Promise<void> => flushInBackground(2000);

/**
 * Handler for Next.js App Router errors
 * Use in instrumentation.ts: export const onRequestError = captureRouterError
 *
 * Next awaits it and a serverless function is frozen right after, so there the event is sent before it returns (2 s at
 * most), or handed to Next's `waitUntil` when the request has one. A long-running server keeps its send timer, so its
 * error responses never wait for the network.
 */
export async function captureRouterError(
  error: RequestError,
  request: { path: string; method: string; headers: Record<string, string> },
  context: ErrorContext
): Promise<void> {
  // For a Pages Router render error Next calls this first and then renders `_error` with the same object: this event,
  // which has the router kind, route and type, is the one that stays.
  if (alreadySent(error)) return;
  const header = (name: string): string | undefined => {
    const key = Object.keys(request.headers ?? {}).find((k) => k.toLowerCase() === name);
    return key ? request.headers[key] : undefined;
  };
  // Origin from Host and X-Forwarded-Proto, path without its query; no header is sent in the event's `request`.
  const scope = withDigest(
    requestScopeFrom({ url: request.path, method: request.method, host: header("host"), protocol: header("x-forwarded-proto") }),
    error,
  );
  withRequestScope(scope, () =>
    coreCaptureException(
      error,
      withHint(
        {
          routerKind: context.routerKind,
          routePath: context.routePath,
          routeType: context.routeType,
          route: context.routePath,
        },
        crash("nextjs-router"),
      ),
    ),
  );
  if (isServerlessRuntime()) await flushInBackground(2000);
}

/**
 * Track router transition start (for performance)
 */
export function captureRouterTransitionStart(route: string): void {
  coreAddBreadcrumb({
    category: "navigation",
    message: `Navigating to ${route}`,
    data: { route },
  });
}

// =============================================================================
// Error boundaries
// =============================================================================

/**
 * Capture an error an error boundary caught: call it from `app/error.tsx` and `app/global-error.tsx`. In a production
 * build Next hands such an error to `console.error` only, so neither the window handlers nor `onRequestError` see it.
 *
 * `handled` is false: the boundary shows an error page in place of the UI, and no code of the app dealt with the error
 * (it did not retry, recover or choose a fallback), so it counts as a crash like one the window handler would send.
 *
 * Next's `error.digest` (a hash that also appears with the matching server error) is sent as the tag `digest`. One Error
 * object is sent once: a second call with it, or the window handler seeing it first (or after), sends nothing.
 */
export function captureBoundaryError(error: Error & { digest?: string }, info?: { componentStack?: string | null }): string {
  if (alreadySent(error)) return "";
  const digest = digestOf(error);
  const base = getRequestScope() ?? (typeof location !== "undefined" ? requestScopeFrom({ url: location.href, method: "GET" }) : undefined);
  const capture = (): string =>
    coreCaptureException(
      error,
      withHint(info?.componentStack ? { componentStack: info.componentStack } : {}, crash("nextjs-error-boundary")),
    );
  if (!digest) return capture();
  return withRequestScope({ url: base?.url ?? "", method: base?.method ?? "GET", ...base, tags: { ...base?.tags, digest } }, capture);
}

/** What Next hands `getInitialProps` of `pages/_error.js`. */
export interface UnderscoreErrorContext {
  err?: (Error & { digest?: string }) | null;
  req?: { url?: string; method?: string } | null;
  statusCode?: number;
}

/**
 * Capture the error `pages/_error.js` is rendered for (Pages Router): `await` it in `getInitialProps(ctx)`. Next hands
 * every client render error to `console.error`, and the server one to this page. A 404 with no `err` sends nothing.
 * The event carries the request's method and path when `ctx.req` is there, never headers or a query. On a serverless
 * runtime it resolves after the event is sent, like `captureRouterError`.
 */
export async function captureUnderscoreErrorException(ctx: UnderscoreErrorContext): Promise<void> {
  const err = ctx?.err;
  if (!err || alreadySent(err)) return;
  const capture = (): string => coreCaptureException(err, withHint({}, crash("nextjs-error-page")));
  const req = ctx.req;
  if (req && typeof req.url === "string") withRequestScope(requestScopeFrom({ url: req.url, method: req.method ?? "GET" }), capture);
  else capture();
  if (isServerlessRuntime()) await flushInBackground(2000);
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

// The same functions under the plain names an error-tracking SDK usually exports
export const captureException = coreCaptureException;
export const captureMessage = coreCaptureMessage;
export const setUser = coreSetUser;
export const setTag = coreSetTag;
export const setTags = coreSetTags;
export const addBreadcrumb = coreAddBreadcrumb;
export const flush = coreFlush;

/**
 * Check if Overseer is initialized
 */
export function isOverseerInitialized(): boolean {
  return isInitialized && getClient() !== null;
}

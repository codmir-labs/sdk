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
import { listen, Stops } from "../overseer/lifecycle";
import { trackNavigation } from "../overseer/navigation";
import { scrubUrl } from "../overseer/url-scrub";
import { requestScopeFrom, withRequestScope } from "../overseer/request-scope";

// =============================================================================
// Types
// =============================================================================

export interface NextjsConfig extends OverseerConfig {
  /** Automatically capture unhandled errors */
  captureUnhandledErrors?: boolean;
  /** Automatically capture unhandled promise rejections */
  captureUnhandledRejections?: boolean;
  /** Track route changes as breadcrumbs */
  trackRouteChanges?: boolean;
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
/** What `init` started in a browser, ended by `close`. */
const stops = new Stops();

export function init(config: NextjsConfig = {}): void {
  if (isInitialized) return;

  const {
    captureUnhandledErrors = true,
    captureUnhandledRejections = true,
    trackRouteChanges = true,
    enableReplay = false,
    ...coreConfig
  } = config;

  // Initialize core
  coreInit(coreConfig);
  isInitialized = true;

  // Browser-only setup
  if (typeof window !== "undefined") {
    // Global error handler
    if (captureUnhandledErrors) {
      stops.add(
        listen(window, "error", (event: ErrorEvent) => {
          coreCaptureException(event.error || event.message, {
            handled: false,
            mechanism: "onerror",
          });
        }),
      );
    }

    // Unhandled rejection handler
    if (captureUnhandledRejections) {
      stops.add(
        listen(window, "unhandledrejection", (event: PromiseRejectionEvent) => {
          coreCaptureException(event.reason, {
            handled: false,
            mechanism: "onunhandledrejection",
          });
        }),
      );
    }

    // Route change tracking
    if (trackRouteChanges) {
      stops.add(trackNavigation());
    }
  }
}

/**
 * Ends what `init` started: the global handlers and the route breadcrumbs (the `history` patches go back when they are
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
 * Capture a server-side request error (App Router)
 */
export function captureRequestError(
  error: RequestError,
  errorContext: Partial<ErrorContext>,
  request?: Request
): string {
  // No request object, headers or cookies in the context. The event's `request` (origin, path, method) comes from
  // the scope below; the route pattern is `errorContext.routePath`.
  const capture = (): string =>
    coreCaptureException(error, {
      mechanism: "server",
      ...errorContext,
      ...(errorContext.routePath ? { route: errorContext.routePath } : {}),
    });
  return request ? withRequestScope(requestScopeFrom({ url: request.url, method: request.method }), capture) : capture();
}

/**
 * Handler for Next.js App Router errors
 * Use in instrumentation.ts: export const onRequestError = captureRouterError
 */
export async function captureRouterError(
  error: RequestError,
  request: { path: string; method: string; headers: Record<string, string> },
  context: ErrorContext
): Promise<void> {
  const header = (name: string): string | undefined => {
    const key = Object.keys(request.headers ?? {}).find((k) => k.toLowerCase() === name);
    return key ? request.headers[key] : undefined;
  };
  // Origin from Host and X-Forwarded-Proto, path without its query; no header is sent in the event's `request`.
  const scope = requestScopeFrom({ url: request.path, method: request.method, host: header("host"), protocol: header("x-forwarded-proto") });
  withRequestScope(scope, () =>
    coreCaptureException(error, {
      mechanism: "nextjs-router",
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      route: context.routePath,
    }),
  );
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

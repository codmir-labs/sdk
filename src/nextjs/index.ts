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
      window.addEventListener("error", (event) => {
        coreCaptureException(event.error || event.message, {
          handled: false,
          mechanism: "onerror",
        });
      });
    }

    // Unhandled rejection handler
    if (captureUnhandledRejections) {
      window.addEventListener("unhandledrejection", (event) => {
        coreCaptureException(event.reason, {
          handled: false,
          mechanism: "onunhandledrejection",
        });
      });
    }

    // Route change tracking
    if (trackRouteChanges) {
      setupRouteTracking();
    }
  }
}

// =============================================================================
// Route Tracking
// =============================================================================

function setupRouteTracking(): void {
  if (typeof window === "undefined") return;

  // Track initial page load
  coreAddBreadcrumb({
    category: "navigation",
    message: window.location.pathname,
    data: {
      from: document.referrer || undefined,
      to: window.location.href,
    },
  });

  // Track history changes (SPA navigation)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    coreAddBreadcrumb({
      category: "navigation",
      message: "pushState",
      data: { to: args[2] as string },
    });
    return result;
  };

  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    coreAddBreadcrumb({
      category: "navigation",
      message: "replaceState",
      data: { to: args[2] as string },
    });
    return result;
  };

  window.addEventListener("popstate", () => {
    coreAddBreadcrumb({
      category: "navigation",
      message: "popstate",
      data: { to: window.location.href },
    });
  });
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
  const eventId = coreCaptureException(error, {
    mechanism: "server",
    ...errorContext,
    request: request
      ? {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
        }
      : undefined,
  });

  return eventId;
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
  coreCaptureException(error, {
    mechanism: "nextjs-router",
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
    request,
  });
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

// Alias for Sentry compatibility
export const captureException = coreCaptureException;
export const captureMessage = coreCaptureMessage;
export const setUser = coreSetUser;
export const setTag = coreSetTag;
export const setTags = coreSetTags;
export const addBreadcrumb = coreAddBreadcrumb;
export const flush = coreFlush;
export const close = coreClose;

/**
 * Check if Overseer is initialized
 */
export function isOverseerInitialized(): boolean {
  return isInitialized && getClient() !== null;
}

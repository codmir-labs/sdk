/**
 * @codmir/sdk/remix - Remix Integration
 *
 * Automatic error tracking, breadcrumbs, and performance
 * monitoring for Remix applications.
 *
 * @example
 * ```typescript
 * // entry.server.tsx
 * import * as Codmir from '@codmir/sdk/remix';
 *
 * Codmir.init({
 *   dsn: process.env.CODMIR_DSN,
 *   environment: process.env.NODE_ENV,
 * });
 *
 * export const handleError = Codmir.handleError;
 * ```
 *
 * @example
 * ```typescript
 * // app/routes/dashboard.tsx
 * import { wrapLoader, wrapAction } from '@codmir/sdk/remix';
 *
 * export const loader = wrapLoader(async ({ request }) => {
 *   return json({ user: await getUser(request) });
 * });
 *
 * export const action = wrapAction(async ({ request }) => {
 *   const form = await request.formData();
 *   return json({ ok: true });
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

export interface RemixConfig extends OverseerConfig {
  /** Automatically capture errors thrown in loaders (default: true) */
  captureLoaderErrors?: boolean;
  /** Automatically capture errors thrown in actions (default: true) */
  captureActionErrors?: boolean;
  /** Track route changes as breadcrumbs (default: true) */
  captureRouteChanges?: boolean;
  /** Capture Response errors with status >= 400 (default: true) */
  captureResponseErrors?: boolean;
}

/** Minimal Request interface — no Remix imports needed */
interface RemixRequest {
  url: string;
  method: string;
  headers: { get(name: string): string | null; forEach(cb: (value: string, key: string) => void): void };
  formData?(): Promise<{ keys(): IterableIterator<string> }>;
}

/** Minimal Response interface for error handling */
interface RemixResponse {
  status: number;
  statusText: string;
}

/** Remix loader/action function args */
interface DataFunctionArgs {
  request: RemixRequest;
  params: Record<string, string | undefined>;
  context?: unknown;
}

/** Remix loader/action function signature */
type DataFunction = (args: DataFunctionArgs) => Promise<unknown> | unknown;

/** Headers that should never be captured */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

// =============================================================================
// Internal State
// =============================================================================

let isInitialized = false;
let remixConfig: Required<Pick<RemixConfig, "captureLoaderErrors" | "captureActionErrors" | "captureRouteChanges" | "captureResponseErrors">> = {
  captureLoaderErrors: true,
  captureActionErrors: true,
  captureRouteChanges: true,
  captureResponseErrors: true,
};

// =============================================================================
// Remix Specific Initialization
// =============================================================================

export function init(config: RemixConfig = {}): void {
  if (isInitialized) return;

  const {
    captureLoaderErrors = true,
    captureActionErrors = true,
    captureRouteChanges = true,
    captureResponseErrors = true,
    ...coreConfig
  } = config;

  // Initialize core
  coreInit(coreConfig);
  isInitialized = true;

  remixConfig = {
    captureLoaderErrors,
    captureActionErrors,
    captureRouteChanges,
    captureResponseErrors,
  };
}

// =============================================================================
// handleError — Remix's handleError export for entry.server.tsx
// =============================================================================

/**
 * Drop-in for Remix's `handleError` export.
 * Captures server-side errors with full request context.
 *
 * @example
 * ```typescript
 * // entry.server.tsx
 * export const handleError = Codmir.handleError;
 * ```
 */
export function handleError(
  error: unknown,
  { request }: { request: RemixRequest }
): void {
  const context: Record<string, unknown> = {
    mechanism: "remix-handleError",
    request: extractRequestContext(request),
  };

  // Response errors carry status information
  if (isResponseLike(error)) {
    if (!remixConfig.captureResponseErrors) return;

    context.responseStatus = error.status;
    context.responseStatusText = error.statusText;

    coreCaptureException(
      new Error(`Response Error: ${error.status} ${error.statusText}`),
      context
    );
    return;
  }

  // Standard Error instances
  if (error instanceof Error) {
    coreCaptureException(error, context);
    return;
  }

  // Unknown error shape — wrap it
  coreCaptureException(
    new Error(typeof error === "string" ? error : "Unknown Remix server error"),
    { ...context, originalError: error }
  );
}

// =============================================================================
// wrapLoader
// =============================================================================

/**
 * Wraps a Remix loader function with error tracking and breadcrumbs.
 * Errors are captured then re-thrown so Remix error boundaries still work.
 *
 * @example
 * ```typescript
 * export const loader = wrapLoader(async ({ request, params }) => {
 *   const user = await getUser(params.userId);
 *   return json({ user });
 * });
 * ```
 */
export function wrapLoader<T extends DataFunction>(loader: T): T {
  const wrapped = async function wrappedLoader(args: DataFunctionArgs) {
    const url = safeParseUrl(args.request.url);

    coreAddBreadcrumb({
      category: "loader",
      message: `Loader: ${args.request.method} ${url}`,
      data: {
        url,
        method: args.request.method,
        params: args.params,
      },
    });

    try {
      return await loader(args);
    } catch (error) {
      if (remixConfig.captureLoaderErrors) {
        coreCaptureException(error instanceof Error ? error : new Error(String(error)), {
          mechanism: "remix-loader",
          request: extractRequestContext(args.request),
          params: args.params,
        });
      }
      throw error;
    }
  };

  return wrapped as T;
}

// =============================================================================
// wrapAction
// =============================================================================

/**
 * Wraps a Remix action function with error tracking and breadcrumbs.
 * Captures form data keys (never values) for debugging context.
 *
 * @example
 * ```typescript
 * export const action = wrapAction(async ({ request }) => {
 *   const form = await request.formData();
 *   await updateUser(form);
 *   return json({ ok: true });
 * });
 * ```
 */
export function wrapAction<T extends DataFunction>(action: T): T {
  const wrapped = async function wrappedAction(args: DataFunctionArgs) {
    const url = safeParseUrl(args.request.url);

    coreAddBreadcrumb({
      category: "action",
      message: `Action: ${args.request.method} ${url}`,
      data: {
        url,
        method: args.request.method,
        params: args.params,
      },
    });

    try {
      return await action(args);
    } catch (error) {
      if (remixConfig.captureActionErrors) {
        const context: Record<string, unknown> = {
          mechanism: "remix-action",
          request: extractRequestContext(args.request),
          params: args.params,
        };

        // Capture form data keys (not values) for context
        try {
          if (args.request.formData) {
            const formData = await args.request.formData();
            context.formDataKeys = Array.from(formData.keys());
          }
        } catch {
          // formData() may fail if body was already consumed — that's fine
        }

        coreCaptureException(error instanceof Error ? error : new Error(String(error)), context);
      }
      throw error;
    }
  };

  return wrapped as T;
}

// =============================================================================
// captureRemixServerError — for entry.server.tsx rendering errors
// =============================================================================

/**
 * Capture server-side rendering errors in entry.server.tsx.
 * Use this in your entry.server's error handling path.
 *
 * @example
 * ```typescript
 * // entry.server.tsx
 * export default function handleRequest(request, status, headers, remixContext) {
 *   return new Promise((resolve, reject) => {
 *     const stream = renderToPipeableStream(
 *       <RemixServer context={remixContext} url={request.url} />,
 *       {
 *         onError(error) {
 *           Codmir.captureRemixServerError(error, request);
 *         },
 *       }
 *     );
 *   });
 * }
 * ```
 */
export function captureRemixServerError(error: unknown, request: RemixRequest): string {
  const context: Record<string, unknown> = {
    mechanism: "remix-server-render",
    request: extractRequestContext(request),
  };

  if (error instanceof Error) {
    return coreCaptureException(error, context);
  }

  return coreCaptureException(
    new Error(typeof error === "string" ? error : "Remix server rendering error"),
    { ...context, originalError: error }
  );
}

// =============================================================================
// Browser-Side Tracking
// =============================================================================

/**
 * Set up browser-side tracking for Remix client entry.
 * Tracks route changes via history API and captures unhandled errors.
 *
 * @example
 * ```typescript
 * // entry.client.tsx
 * import * as Codmir from '@codmir/sdk/remix';
 *
 * Codmir.init({ dsn: window.ENV.CODMIR_DSN });
 * Codmir.setupBrowserTracking();
 *
 * startTransition(() => {
 *   hydrateRoot(document, <RemixBrowser />);
 * });
 * ```
 */
export function setupBrowserTracking(): void {
  if (typeof window === "undefined") return;

  // Global error handler
  window.addEventListener("error", (event) => {
    coreCaptureException(event.error || event.message, {
      handled: false,
      mechanism: "onerror",
    });
  });

  // Unhandled rejection handler
  window.addEventListener("unhandledrejection", (event) => {
    coreCaptureException(event.reason, {
      handled: false,
      mechanism: "onunhandledrejection",
    });
  });

  // Route change tracking
  if (remixConfig.captureRouteChanges) {
    setupRouteTracking();
  }
}

// =============================================================================
// Route Tracking (Browser)
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
// Helpers
// =============================================================================

function extractRequestContext(request: RemixRequest): Record<string, unknown> {
  const headers: Record<string, string> = {};

  request.headers.forEach((value, key) => {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  });

  return {
    url: request.url,
    method: request.method,
    headers,
  };
}

function safeParseUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isResponseLike(value: unknown): value is RemixResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "statusText" in value &&
    typeof (value as RemixResponse).status === "number"
  );
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

// Alias for direct usage
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

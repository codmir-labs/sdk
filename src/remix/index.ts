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
import { listen, Stops } from "../overseer/lifecycle";
import { withHint, crash, eventFrame } from "../overseer/capture-hint";
import { installBrowserBreadcrumbs, type BrowserBreadcrumbOptions, type ConsoleMethod } from "../overseer/browser-breadcrumbs";
import { scrubUrl } from "../overseer/url-scrub";

// =============================================================================
// Types
// =============================================================================

export interface RemixConfig extends OverseerConfig {
  /** Automatically capture errors thrown in loaders (default: true) */
  captureLoaderErrors?: boolean;
  /** Automatically capture errors thrown in actions (default: true) */
  captureActionErrors?: boolean;
  /** Track route changes as breadcrumbs (default: true). The older name of `trackNavigation`, which wins when both are set. */
  captureRouteChanges?: boolean;
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
// =============================================================================
// Internal State
// =============================================================================

let isInitialized = false;
/** What `setupBrowserTracking` started, ended by `close`. */
const stops = new Stops();
let remixConfig: Required<Pick<RemixConfig, "captureLoaderErrors" | "captureActionErrors" | "captureRouteChanges" | "captureResponseErrors">> = {
  captureLoaderErrors: true,
  captureActionErrors: true,
  captureRouteChanges: true,
  captureResponseErrors: true,
};
/** What `setupBrowserTracking` records, from `init`'s options. */
let browserBreadcrumbs: BrowserBreadcrumbOptions = {};

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
    trackNavigation = captureRouteChanges,
    trackClicks,
    trackInputs,
    trackRequests,
    trackConsole,
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
  browserBreadcrumbs = { trackClicks, trackInputs, trackRequests, trackNavigation, trackConsole };
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
  const context: Record<string, unknown> = withHint({}, crash("remix-handleError"));

  // Response errors carry status information
  if (isResponseLike(error)) {
    captureThrownResponse(error, context);
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
      },
    });

    try {
      return await loader(args);
    } catch (error) {
      if (isResponseLike(error)) {
        if (remixConfig.captureLoaderErrors) {
          captureThrownResponse(error, withHint({}, crash("remix-loader", undefined, "none")));
        }
        throw error;
      }
      if (remixConfig.captureLoaderErrors) {
        coreCaptureException(error, withHint({}, crash("remix-loader", undefined, "none")));
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
      },
    });

    try {
      return await action(args);
    } catch (error) {
      if (isResponseLike(error)) {
        if (remixConfig.captureActionErrors) {
          captureThrownResponse(error, withHint({}, crash("remix-action", undefined, "none")));
        }
        throw error;
      }
      if (remixConfig.captureActionErrors) {
        const context: Record<string, unknown> = withHint({}, crash("remix-action", undefined, "none"));

        // Capture form data keys (not values) for context
        try {
          if (args.request.formData) {
            const formData = await args.request.formData();
            context.formDataKeys = Array.from(formData.keys());
          }
        } catch {
          // formData() may fail if body was already consumed — that's fine
        }

        coreCaptureException(error, context);
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
  const context: Record<string, unknown> = withHint({}, crash("remix-server-render"));

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
 * Records the browser breadcrumbs (clicks, inputs, `fetch` and XHR, route changes, console output; see `RemixConfig`)
 * and captures unhandled errors.
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
  stops.add(
    listen(window, "error", (event: ErrorEvent) => {
      coreCaptureException(event.error || event.message, withHint({}, crash("onerror", undefined, eventFrame(event))));
    }),
  );

  // Unhandled rejection handler
  stops.add(
    listen(window, "unhandledrejection", (event: PromiseRejectionEvent) => {
      coreCaptureException(event.reason, withHint({}, crash("onunhandledrejection", undefined, "none")));
    }),
  );

  // Clicks, inputs, requests, route changes and console output: the set every browser entry records.
  stops.add(installBrowserBreadcrumbs(browserBreadcrumbs));
}

/**
 * Ends what `init` and `setupBrowserTracking` started: the global handlers and the breadcrumbs (the `console`, `fetch`, XHR and `history`
 * patches go back when they are still on top, and otherwise only pass calls on), then the core client, which sends what
 * it holds. A later `init` starts clean, with its own config. An error captured after `close` and before the next `init`
 * is sent once, without retries.
 */
export function close(): void {
  stops.run();
  isInitialized = false;
  remixConfig = { captureLoaderErrors: true, captureActionErrors: true, captureRouteChanges: true, captureResponseErrors: true };
  browserBreadcrumbs = {};
  coreClose();
}

// =============================================================================
// Helpers
// =============================================================================

function safeParseUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Thrown responses already sent, so a wrapper and `handleError` seeing the same object send it once. */
const sentResponses = new WeakSet<object>();

/**
 * A thrown `Response` is control flow (a redirect, a 404) unless it is a server error: only a status of 500 or more is
 * sent, once per object, and only with `captureResponseErrors` on.
 */
function captureThrownResponse(response: RemixResponse, context: Record<string, unknown>): void {
  if (!remixConfig.captureResponseErrors || response.status < 500) return;
  if (sentResponses.has(response)) return;
  sentResponses.add(response);

  context.responseStatus = response.status;
  context.responseStatusText = response.statusText;

  coreCaptureException(new Error(`Response Error: ${response.status} ${response.statusText}`), context);
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

/**
 * Check if Overseer is initialized
 */
export function isOverseerInitialized(): boolean {
  return isInitialized && getClient() !== null;
}

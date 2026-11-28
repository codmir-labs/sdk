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
 *   clientKey: process.env.CODMIR_CLIENT_KEY,
 *   environment: process.env.NODE_ENV,
 * });
 *
 * export const handleError = Codmir.handleError;
 * ```
 *
 * @example
 * ```typescript
 * // app/routes/dashboard.tsx
 * import { json } from '@remix-run/node';
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
import { getRequestScope, requestScopeFrom, withRequestScope } from "../overseer/request-scope";

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

/** Minimal Response interface for error handling */
interface RemixResponse {
  status: number;
  statusText: string;
}

/** Remix loader/action function args */
interface DataFunctionArgs {
  /** The fetch `Request` Remix gives every loader and action. */
  request: Request;
  params: { readonly [name: string]: string | undefined };
  /** `any`, so a function typed with Remix's own `LoaderFunctionArgs` or `ActionFunctionArgs` (whose `context` is required) is accepted. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}

/** Remix loader/action function signature: any function the framework's own args type fits, kept as the caller typed it. */
type DataFunction = (args: DataFunctionArgs) => unknown;

/** Headers that should never be captured */
// =============================================================================
// Internal State
// =============================================================================

let isInitialized = false;
/** What `setupBrowserTracking` started, ended by `close`. */
const stops = new Stops();
/** True from `setupBrowserTracking` to `close`: a second call has nothing to add. */
let tracking = false;
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
 * import * as Codmir from '@codmir/sdk/remix';
 *
 * export const handleError = Codmir.handleError;
 * ```
 */
export function handleError(
  error: unknown,
  { request }: { request: Request }
): void {
  inRequestScope(request, () => captureHandledError(error));
}

function captureHandledError(error: unknown): void {
  const context: Record<string, unknown> = withHint({}, crash("remix-handleError"));

  // Response errors carry status information
  if (isResponseLike(error)) {
    captureThrownResponse(error, context);
    return;
  }

  // An object a wrapper already sent is not sent again
  if (alreadySent(error)) return;

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
 * import { json } from '@remix-run/node';
 * import { wrapLoader } from '@codmir/sdk/remix';
 *
 * export const loader = wrapLoader(async ({ params }) => {
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
      if (remixConfig.captureLoaderErrors && !alreadySent(error)) {
        coreCaptureException(error, withHint({}, crash("remix-loader", undefined, "none")));
      }
      throw error;
    }
  };

  return wrapped as unknown as T;
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
 * import { json } from '@remix-run/node';
 * import { wrapAction } from '@codmir/sdk/remix';
 *
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

    // What the action's own `request.formData()` parses is kept here, so its keys survive the body being consumed.
    const form = watchFormData(args.request);
    try {
      return await action(args);
    } catch (error) {
      form.stop();
      if (isResponseLike(error)) {
        if (remixConfig.captureActionErrors) {
          const context: Record<string, unknown> = withHint({}, crash("remix-action", undefined, "none"));
          if (remixConfig.captureResponseErrors && error.status >= 500) await addFormDataKeys(context, args.request, form.keys);
          captureThrownResponse(error, context);
        }
        throw error;
      }
      if (remixConfig.captureActionErrors && !alreadySent(error)) {
        const context: Record<string, unknown> = withHint({}, crash("remix-action", undefined, "none"));
        await addFormDataKeys(context, args.request, form.keys);
        coreCaptureException(error, context);
      }
      throw error;
    } finally {
      form.stop();
    }
  };

  return wrapped as unknown as T;
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
 * import type { EntryContext } from '@remix-run/node';
 * import { RemixServer } from '@remix-run/react';
 * import { renderToPipeableStream } from 'react-dom/server';
 * import * as Codmir from '@codmir/sdk/remix';
 *
 * export default function handleRequest(request: Request, status: number, headers: Headers, remixContext: EntryContext) {
 *   return new Promise((resolve, reject) => {
 *     const stream = renderToPipeableStream(
 *       <RemixServer context={remixContext} url={request.url} />,
 *       {
 *         onError(error: unknown) {
 *           Codmir.captureRemixServerError(error, request);
 *         },
 *       }
 *     );
 *   });
 * }
 * ```
 */
export function captureRemixServerError(error: unknown, request: Request): string {
  const context: Record<string, unknown> = withHint({}, crash("remix-server-render"));
  // The event's `request` is the method and the URL without its query, the way the Express and Next.js captures give it.
  const capture = (): string =>
    error instanceof Error
      ? coreCaptureException(error, context)
      : coreCaptureException(new Error(typeof error === "string" ? error : "Remix server rendering error"), { ...context, originalError: error });
  return inRequestScope(request, capture);
}

/**
 * Runs `fn` in the request scope that is already open, which has the request's user, tags and breadcrumbs; only when none is
 * open is a scope made from `request`, since `withRequestScope` replaces the scope it finds instead of forking it.
 */
function inRequestScope<T>(request: Request | undefined, fn: () => T): T {
  if (!request || getRequestScope()) return fn();
  return withRequestScope(requestScopeFrom({ url: request.url, method: request.method }), fn);
}

// =============================================================================
// Browser-Side Tracking
// =============================================================================

/**
 * Set up browser-side tracking for Remix client entry.
 * Records the browser breadcrumbs (clicks, inputs, `fetch` and XHR, route changes, console output; see `RemixConfig`)
 * and captures unhandled errors. A second call before `close` is ignored.
 *
 * @example
 * ```typescript
 * // entry.client.tsx
 * import * as Codmir from '@codmir/sdk/remix';
 *
 * Codmir.init({ clientKey: window.ENV.CODMIR_CLIENT_KEY });
 * Codmir.setupBrowserTracking();
 *
 * startTransition(() => {
 *   hydrateRoot(document, <RemixBrowser />);
 * });
 * ```
 */
export function setupBrowserTracking(): void {
  if (typeof window === "undefined" || tracking) return;
  tracking = true;

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
  tracking = false;
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

/**
 * Objects already sent, by identity, so one thrown object is one event and nothing is kept alive. One set per process, in a
 * `Symbol.for` slot, so two copies of this module share it: the copy that sent an object and the copy that sees it again
 * (a wrapper, then `handleError`) must agree.
 */
const SENT_SLOT = Symbol.for("codmir.remix.sent-errors");
const slots = globalThis as Record<symbol, WeakSet<object> | undefined>;
/** True when `value` was sent before; otherwise marks it as sent. A value that is not an object is never remembered. */
function alreadySent(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const sent = (slots[SENT_SLOT] ??= new WeakSet<object>());
  if (sent.has(value)) return true;
  sent.add(value);
  return false;
}

/**
 * Watches the `request.formData()` of one action call, on the request itself and without a clone (a clone whose body is never read
 * is buffered whole, so every upload would cost its size again): the field names it parses are kept in `keys`, and `stop` puts the
 * method back. A request whose method cannot be replaced (a frozen object) is left as it is, and `keys` stays undefined.
 */
function watchFormData(request: Request): { readonly keys: string[] | undefined; stop(): void } {
  const watch: { keys: string[] | undefined; stop(): void } = { keys: undefined, stop() {} };
  try {
    const original = request.formData;
    if (typeof original !== "function") return watch;
    const own = Object.getOwnPropertyDescriptor(request, "formData");
    Object.defineProperty(request, "formData", {
      configurable: true,
      writable: true,
      value: function formData(this: unknown, ...rest: []): Promise<FormData> {
        const parsed = original.apply(this ?? request, rest);
        parsed.then(
          (form) => {
            try {
              watch.keys ??= Array.from(form.keys());
            } catch {
              // not a form we can list: nothing is kept
            }
          },
          () => {},
        );
        return parsed;
      },
    });
    watch.stop = () => {
      watch.stop = () => {};
      try {
        if (own) Object.defineProperty(request, "formData", own);
        else delete (request as { formData?: unknown }).formData;
      } catch {
        // left in place: it only passes the call on
      }
    };
  } catch {
    // a frozen request: today's behaviour
  }
  return watch;
}

/**
 * Adds the form's field names (never values) to `context`: the `keys` the action's own read parsed, else a read of the body here,
 * which adds nothing when the body is already consumed.
 */
async function addFormDataKeys(context: Record<string, unknown>, request: Request, keys?: string[]): Promise<void> {
  if (keys) {
    context.formDataKeys = keys;
    return;
  }
  try {
    const formData = await request.formData();
    context.formDataKeys = Array.from(formData.keys());
  } catch {
    // formData() may fail if body was already consumed — that's fine
  }
}

/**
 * A thrown `Response` is control flow (a redirect, a 404) unless it is a server error: only a status of 500 or more is
 * sent, once per object, and only with `captureResponseErrors` on.
 */
function captureThrownResponse(response: RemixResponse, context: Record<string, unknown>): void {
  if (!remixConfig.captureResponseErrors || response.status < 500) return;
  if (alreadySent(response)) return;

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

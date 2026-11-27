/**
 * @codmir/sdk/browser - Browser-Only Integration
 *
 * Lightweight error tracking for vanilla JavaScript/TypeScript
 * browser applications.
 *
 * @example
 * ```html
 * <script type="module">
 *   import { init, captureException } from '@codmir/sdk/browser';
 *
 *   init({
 *     dsn: 'https://www.codmir.com/api/v1/overseer',
 *   });
 *
 *   window.onerror = (msg, url, line, col, error) => {
 *     captureException(error);
 *   };
 * </script>
 * ```
 */

import {
  init as coreInit,
  captureException as coreCaptureException,
  captureMessage as coreCaptureMessage,
  setUser as coreSetUser,
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
import { listen, patch, Stops } from "../overseer/lifecycle";
import { withHint, crash, eventFrame } from "../overseer/capture-hint";
import { frameFilename } from "../overseer/stack";
import { installBrowserBreadcrumbs, consoleText, type BrowserBreadcrumbOptions } from "../overseer/browser-breadcrumbs";
import { startBrowserTracing, type BrowserTracingOptions } from "../tracing/browser";

// =============================================================================
// Types
// =============================================================================

export interface BrowserConfig extends OverseerConfig, BrowserBreadcrumbOptions {
  /** Automatically capture global errors */
  captureGlobalErrors?: boolean;
  /** Automatically capture unhandled promise rejections */
  captureUnhandledRejections?: boolean;
  /** Automatically capture console.error */
  captureConsoleErrors?: boolean;
  /**
   * Pageload and navigation transactions. Default: on when `tracesSampleRate` is above 0, otherwise
   * off. `true` or an options object turns it on (sampling still follows `tracesSampleRate`); `false` turns it off.
   */
  browserTracing?: boolean | BrowserTracingOptions;
}

// =============================================================================
// Browser Specific Initialization
// =============================================================================

let isInitialized = false;
/** What `init` started, ended by `close`. */
const stops = new Stops();

/**
 * Starts the browser integration: the core client, global error and rejection handlers, `console.error` capture,
 * click, input, request, navigation and console breadcrumbs, `fetch` and XHR spans, and the pageload and navigation transactions.
 * A second call before `close` is ignored. Where `window`, `document`, `location` or `history` is missing (React Native,
 * a worker) the parts that need it are skipped.
 */
export function init(config: BrowserConfig = {}): void {
  if (typeof window === "undefined") {
    console.warn("[@codmir/sdk/browser] Cannot initialize in non-browser environment");
    return;
  }

  if (isInitialized) return;

  const {
    captureGlobalErrors = true,
    captureUnhandledRejections = true,
    captureConsoleErrors = false,
    trackClicks = true,
    trackInputs = false,
    trackRequests = true,
    trackNavigation = true,
    trackConsole,
    browserTracing,
    ...coreConfig
  } = config;

  // Initialize core
  coreInit(coreConfig);
  isInitialized = true;

  // Global error handler
  if (captureGlobalErrors) {
    stops.add(
      listen(window, "error", (event: ErrorEvent) => {
        coreCaptureException(
          event.error || event.message,
          // With no error of its own, the event's place is the one frame: the SDK has none to give.
          withHint({ filename: typeof event.filename === "string" ? frameFilename(event.filename) : event.filename, lineno: event.lineno, colno: event.colno }, crash("onerror", undefined, eventFrame(event))),
        );
      }),
    );
  }

  // Unhandled rejection handler
  if (captureUnhandledRejections) {
    stops.add(
      listen(window, "unhandledrejection", (event: PromiseRejectionEvent) => {
        coreCaptureException(event.reason, withHint({}, crash("onunhandledrejection", undefined, "none")));
      }),
    );
  }

  // Console.error capture
  if (captureConsoleErrors) {
    stops.add(
      patch(console, "error", (originalError) => (...args: unknown[]) => {
        coreCaptureMessage(consoleText(args), "error");
        originalError.apply(console, args);
      }),
    );
  }

  // Clicks, inputs, requests, route changes and console output: the set every browser entry records. After the
  // console.error capture above, so a console call is a breadcrumb before it is captured.
  stops.add(installBrowserBreadcrumbs({ trackClicks, trackInputs, trackRequests, trackNavigation, trackConsole }));

  // Pageload / navigation roots. Started after fetch is instrumented so early requests become child spans.
  const tracingOn = browserTracing === undefined ? (getClient()?.getTracesSampleRate() ?? 0) > 0 : browserTracing !== false;
  if (tracingOn) {
    stops.add(startBrowserTracing(typeof browserTracing === "object" ? browserTracing : {}));
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Ends what `init` started: the global handlers, the click and input listeners, the `console`, `fetch`, XHR and
 * `history` patches, the pageload and navigation transactions (the open one ends and is sent), and the core client,
 * which sends what it holds. A later `init` starts clean, with its own config. A patch another copy of the SDK put over
 * one of these stays in place and only passes the calls on. An error captured after `close` and before the next `init`
 * is sent once, without retries.
 */
export function close(): void {
  stops.run();
  isInitialized = false;
  coreClose();
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  coreCaptureException as captureException,
  coreCaptureMessage as captureMessage,
  coreSetUser as setUser,
  coreSetTags as setTags,
  coreAddBreadcrumb as addBreadcrumb,
  coreFlush as flush,
  getClient,
};

export { startBrowserTracing } from "../tracing/browser";
export type { BrowserTracingOptions } from "../tracing/browser";
export type { ConsoleMethod } from "../overseer/browser-breadcrumbs";

export type {
  OverseerConfig,
  UserContext,
  Breadcrumb,
  SeverityLevel,
} from "../overseer/index";

/**
 * Check if Overseer is initialized
 */
export function isOverseerInitialized(): boolean {
  return isInitialized && getClient() !== null;
}

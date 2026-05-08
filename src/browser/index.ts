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
 *     dsn: 'https://your-project.codmir.com/api/overseer',
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

// =============================================================================
// Types
// =============================================================================

export interface BrowserConfig extends OverseerConfig {
  /** Automatically capture global errors */
  captureGlobalErrors?: boolean;
  /** Automatically capture unhandled promise rejections */
  captureUnhandledRejections?: boolean;
  /** Automatically capture console.error */
  captureConsoleErrors?: boolean;
  /** Track user clicks as breadcrumbs */
  trackClicks?: boolean;
  /** Track user inputs as breadcrumbs (values are masked) */
  trackInputs?: boolean;
  /** Track XHR/fetch requests as breadcrumbs */
  trackRequests?: boolean;
}

// =============================================================================
// Browser Specific Initialization
// =============================================================================

let isInitialized = false;

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
    ...coreConfig
  } = config;

  // Initialize core
  coreInit(coreConfig);
  isInitialized = true;

  // Global error handler
  if (captureGlobalErrors) {
    window.addEventListener("error", (event) => {
      coreCaptureException(event.error || event.message, {
        handled: false,
        mechanism: "onerror",
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
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

  // Console.error capture
  if (captureConsoleErrors) {
    const originalError = console.error;
    console.error = (...args) => {
      coreCaptureMessage(args.map(String).join(" "), "error");
      originalError.apply(console, args);
    };
  }

  // Click tracking
  if (trackClicks) {
    document.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (!target) return;

      const breadcrumb: Breadcrumb = {
        category: "ui.click",
        message: getElementDescription(target),
        data: {
          tag: target.tagName.toLowerCase(),
          id: target.id || undefined,
          class: target.className || undefined,
        },
      };

      coreAddBreadcrumb(breadcrumb);
    });
  }

  // Input tracking (masked)
  if (trackInputs) {
    document.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (!target) return;

      const breadcrumb: Breadcrumb = {
        category: "ui.input",
        message: getElementDescription(target),
        data: {
          tag: target.tagName.toLowerCase(),
          type: target.type || "text",
          // Never log actual values
        },
      };

      coreAddBreadcrumb(breadcrumb);
    });
  }

  // Fetch/XHR tracking
  if (trackRequests) {
    setupRequestTracking();
  }
}

// =============================================================================
// Helpers
// =============================================================================

function getElementDescription(el: HTMLElement): string {
  let description = el.tagName.toLowerCase();

  if (el.id) {
    description += `#${el.id}`;
  } else if (el.className) {
    description += `.${el.className.split(" ")[0]}`;
  }

  // Add text content for buttons/links
  if (el.tagName === "BUTTON" || el.tagName === "A") {
    const text = el.textContent?.trim().slice(0, 50);
    if (text) {
      description += ` "${text}"`;
    }
  }

  return description;
}

function setupRequestTracking(): void {
  // Track fetch
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method || "GET";
    const startTime = Date.now();

    try {
      const response = await originalFetch.call(window, input, init);

      coreAddBreadcrumb({
        category: "fetch",
        message: `${method} ${url}`,
        data: {
          method,
          url,
          status: response.status,
          duration: Date.now() - startTime,
        },
        level: response.ok ? "info" : "error",
      });

      return response;
    } catch (error) {
      coreAddBreadcrumb({
        category: "fetch",
        message: `${method} ${url}`,
        data: {
          method,
          url,
          error: error instanceof Error ? error.message : "Network error",
          duration: Date.now() - startTime,
        },
        level: "error",
      });

      throw error;
    }
  };

  // Track XHR
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL) {
    (this as any).__codmir = { method, url: url.toString(), startTime: 0 };
    return originalXHROpen.apply(this, arguments as any);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const data = (this as any).__codmir;
    if (data) {
      data.startTime = Date.now();

      this.addEventListener("loadend", () => {
        coreAddBreadcrumb({
          category: "xhr",
          message: `${data.method} ${data.url}`,
          data: {
            method: data.method,
            url: data.url,
            status: this.status,
            duration: Date.now() - data.startTime,
          },
          level: this.status >= 400 ? "error" : "info",
        });
      });
    }

    return originalXHRSend.call(this, body);
  };
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
  coreClose as close,
  getClient,
};

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

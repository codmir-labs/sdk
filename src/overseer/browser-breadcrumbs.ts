/**
 * The breadcrumbs every browser entry records: clicks, inputs (never their values), `fetch` and XHR, route changes and
 * console output. One installer, called by `/browser`, `/nextjs` and `/remix`, so the three cannot record different
 * things. Browser-safe: every part copes with a global that is missing (React Native, a worker, a server bundle).
 */

import { addBreadcrumb, addRepeatedBreadcrumb, type Breadcrumb } from "./index";
import { listen, patch, type Stop } from "./lifecycle";
import { trackNavigation as startNavigation } from "./navigation";
import { redactSecrets } from "../logs/redact";
import { instrumentFetch } from "../tracing/fetch";
import { instrumentXhr } from "../tracing/xhr";

export type ConsoleMethod = "error" | "warn" | "info" | "log" | "debug";

/** What the browser entries accept, under these names, to choose their breadcrumbs. */
export interface BrowserBreadcrumbOptions {
  /** `ui.click` breadcrumbs (default: true) */
  trackClicks?: boolean;
  /** `ui.input` breadcrumbs: the element and its type, never the value (default: false) */
  trackInputs?: boolean;
  /** `fetch` and XHR breadcrumbs, `http.client` spans and `traceparent` (default: true) */
  trackRequests?: boolean;
  /** `navigation` breadcrumbs: the first page, `pushState`, `replaceState` and `popstate` (default: true) */
  trackNavigation?: boolean;
  /**
   * `console` breadcrumbs for these methods: `true` is `["error", "warn"]`, `false` is none (default: `["error", "warn"]`).
   * The message is the arguments joined, scrubbed of secrets and cut to 200 characters; an identical message in a row is
   * one breadcrumb with a `count`.
   */
  trackConsole?: boolean | ConsoleMethod[];
}

const DEFAULT_CONSOLE: ConsoleMethod[] = ["error", "warn"];
const LEVEL: Record<ConsoleMethod, NonNullable<Breadcrumb["level"]>> = { error: "error", warn: "warning", info: "info", log: "info", debug: "debug" };
const MAX_MESSAGE = 200;
/** Only this much of the arguments is scrubbed: the message is cut to 200 anyway. */
const MAX_SCRUBBED = 4000;

/** Console arguments as one text, as `captureConsoleErrors` joins them; a value with no text of its own never throws. */
export function consoleText(args: readonly unknown[]): string {
  return args
    .map((arg) => {
      try {
        return String(arg);
      } catch {
        return "[unprintable]";
      }
    })
    .join(" ");
}

/** Starts the breadcrumbs `options` choose, and returns the function that ends them all. */
export function installBrowserBreadcrumbs(options: BrowserBreadcrumbOptions = {}): Stop {
  const { trackClicks = true, trackInputs = false, trackRequests = true, trackNavigation = true, trackConsole = true } = options;
  const stops: Stop[] = [];
  if (trackClicks) stops.push(listen(typeof document === "undefined" ? undefined : document, "click", onClick));
  if (trackInputs) stops.push(listen(typeof document === "undefined" ? undefined : document, "input", onInput));
  if (trackRequests) {
    // Fetch and XHR: breadcrumbs plus http.client spans and traceparent propagation.
    stops.push(instrumentFetch({ breadcrumbs: true }), instrumentXhr({ breadcrumbs: true }));
  }
  if (trackNavigation) stops.push(startNavigation());
  const methods = trackConsole === true ? DEFAULT_CONSOLE : trackConsole === false ? [] : trackConsole;
  if (methods.length) stops.push(trackConsoleCalls(methods));
  return () => {
    for (const stop of stops.reverse()) {
      try {
        stop();
      } catch {
        // nothing left to undo for this one
      }
    }
  };
}

function onClick(event: Event): void {
  try {
    const target = event.target as HTMLElement;
    if (typeof target?.tagName !== "string") return;
    addBreadcrumb({
      category: "ui.click",
      message: getElementDescription(target),
      data: { tag: target.tagName.toLowerCase(), id: target.id || undefined, class: classOf(target) || undefined },
    });
  } catch {
    // a listener of the SDK never throws into the page
  }
}

function onInput(event: Event): void {
  try {
    const target = event.target as HTMLInputElement;
    if (typeof target?.tagName !== "string") return;
    addBreadcrumb({
      category: "ui.input",
      message: getElementDescription(target),
      // Never log actual values
      data: { tag: target.tagName.toLowerCase(), type: target.type || "text" },
    });
  } catch {
    // a listener of the SDK never throws into the page
  }
}

/** A console call becomes a breadcrumb before it reaches what was there first; the call itself is never changed. */
function trackConsoleCalls(methods: readonly ConsoleMethod[]): Stop {
  // A console call made while a breadcrumb is being added (the SDK's own debug output) is not recorded: no loop.
  let adding = false;
  const stops = [...new Set(methods)].map((method) =>
    patch(typeof console === "undefined" ? undefined : console, method, (original) =>
      function (this: Console, ...args: unknown[]) {
        if (!adding && !isOwnOutput(args)) {
          adding = true;
          try {
            const message = redactSecrets(consoleText(args).slice(0, MAX_SCRUBBED)).slice(0, MAX_MESSAGE);
            addRepeatedBreadcrumb({ category: "console", level: LEVEL[method], message });
          } catch {
            // a console call never throws because of the SDK
          } finally {
            adding = false;
          }
        }
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as Console[ConsoleMethod],
    ),
  );
  return () => stops.reverse().forEach((stop) => stop());
}

/** The SDK's own debug lines (`[Overseer] ...`) are not the app's console output. */
const isOwnOutput = (args: readonly unknown[]): boolean => typeof args[0] === "string" && args[0].startsWith("[Overseer]");

/** The class attribute as a string: on an SVG element `className` is an object, not a string. */
function classOf(el: Element): string {
  return el.getAttribute?.("class") ?? "";
}

function getElementDescription(el: HTMLElement): string {
  let description = el.tagName.toLowerCase();
  const cls = classOf(el);

  if (el.id) {
    description += `#${el.id}`;
  } else if (cls) {
    description += `.${cls.split(" ")[0]}`;
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

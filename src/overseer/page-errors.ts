/**
 * The two page listeners every browser `init` installs: `error` and `unhandledrejection`. `@codmir/sdk` and
 * `@codmir/sdk/browser` both call this, so what they capture and how can never differ. Browser-safe, no Node import.
 */
import { captureException } from "./index";
import { listen, type Stops } from "./lifecycle";
import { withHint, crash, eventFrame } from "./capture-hint";
import { frameFilename } from "./stack";

export interface PageErrorOptions {
  /** Install the `error` listener. Default `true`. */
  errors?: boolean;
  /** Install the `unhandledrejection` listener. Default `true`. */
  rejections?: boolean;
}

const slots = globalThis as Record<symbol, unknown>;

/**
 * One flag per listener, on `globalThis` and not in a module: the root and browser bundles are separate files, and a
 * page that calls both `init`s must still capture each error once. The flag holds the handler that owns it.
 */
const FLAG_ERROR = Symbol.for("codmir.page-errors.error");
const FLAG_REJECTION = Symbol.for("codmir.page-errors.unhandledrejection");

/** Adds `handler` as a `window` listener unless another entry already has one; `stops` undoes it and clears the flag. */
function once(stops: Stops, flag: symbol, type: string, handler: (event: never) => void): void {
  if (slots[flag] !== undefined) return;
  const stop = listen(window, type, handler);
  slots[flag] = handler;
  stops.add(() => {
    stop();
    if (slots[flag] === handler) delete slots[flag];
  });
}

/** Whether this runtime has a `window` that takes listeners: not Node, a worker, or React Native without events. */
export function hasPageEvents(): boolean {
  return typeof window !== "undefined" && typeof (window as Partial<Window>).addEventListener === "function";
}

/**
 * Starts the listeners in `window` that capture an uncaught error and an unhandled rejection; `stops` ends them.
 * Does nothing without a `window` that has `addEventListener`, and for a listener another entry already installed.
 */
export function installPageErrors(stops: Stops, { errors = true, rejections = true }: PageErrorOptions = {}): void {
  if (!hasPageEvents()) return;
  if (errors) {
    once(stops, FLAG_ERROR, "error", (event: ErrorEvent) => {
      captureException(
        event.error || event.message,
        // With no error of its own, the event's place is the one frame: the SDK has none to give.
        withHint({ filename: typeof event.filename === "string" ? frameFilename(event.filename) : event.filename, lineno: event.lineno, colno: event.colno }, crash("onerror", undefined, eventFrame(event))),
      );
    });
  }
  if (rejections) {
    once(stops, FLAG_REJECTION, "unhandledrejection", (event: PromiseRejectionEvent) => {
      captureException(event.reason, withHint({}, crash("onunhandledrejection", undefined, "none")));
    });
  }
}

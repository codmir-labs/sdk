/**
 * The two page listeners every browser `init` installs: `error` and `unhandledrejection`. `@codmir/sdk`,
 * `@codmir/sdk/browser`, `/nextjs` and `/remix` all call this, so what they capture and how can never differ.
 * Browser-safe, no Node import.
 */
import { captureException } from "./index";
import { listen, type Stops } from "./lifecycle";
import { withHint, crash, eventFrame } from "./capture-hint";
import { frameFilename } from "./stack";
import { FLAG_ERROR, FLAG_REJECTION, type PageSlot } from "./page-flags";

export interface PageErrorOptions {
  /** Install the `error` listener. Default `true`. */
  errors?: boolean;
  /** Install the `unhandledrejection` listener. Default `true`. */
  rejections?: boolean;
  /**
   * Called with an event's `error` (or a rejection's `reason`); `true` leaves that event out. It holds for the listener
   * on the page even when another entry installed it, until `stops` runs.
   */
  skip?: (value: unknown) => boolean;
}

const slots = globalThis as Record<symbol, unknown>;

/**
 * Adds a `window` listener for `type` unless another entry already has one; `stops` undoes it and clears the flag.
 * One flag per listener, on `globalThis` and not in a module: the bundles are separate files, and a page that calls two
 * `init`s must still capture each error once. The flag holds a `PageSlot`, which ends its listener, so a core `close`
 * can end the listener of an entry that is not the one closing. When a listener is there, only `skip` joins it.
 */
function once(
  stops: Stops,
  flag: symbol,
  type: string,
  skip: ((value: unknown) => boolean) | undefined,
  handler: (event: never, slot: PageSlot) => void,
): void {
  const held = slots[flag] as Partial<PageSlot> | undefined;
  if (held !== undefined) {
    // A slot of this shape takes the check; one an older copy of the SDK set (a bare handler) has no list to join.
    if (skip && Array.isArray(held.skips)) {
      const skips = held.skips;
      skips.push(skip);
      stops.add(() => {
        const at = skips.indexOf(skip);
        if (at >= 0) skips.splice(at, 1);
      });
    }
    return;
  }
  const slot: PageSlot = { skips: skip ? [skip] : [], stop: () => {} };
  const stopListener = listen(window, type, (event: never) => handler(event, slot));
  let stopped = false;
  slot.stop = () => {
    // The core `close` and the installing entry's own stops both call this: the listener comes off once.
    if (!stopped) {
      stopped = true;
      stopListener();
    }
    if (slots[flag] === slot) delete slots[flag];
  };
  slots[flag] = slot;
  stops.add(slot.stop);
}

const skipped = (slot: PageSlot, value: unknown): boolean => slot.skips.some((skip) => skip(value));

/** Whether this runtime has a `window` that takes listeners: not Node, a worker, or React Native without events. */
export function hasPageEvents(): boolean {
  return typeof window !== "undefined" && typeof (window as Partial<Window>).addEventListener === "function";
}

/**
 * Starts the listeners in `window` that capture an uncaught error and an unhandled rejection; `stops` ends them.
 * Does nothing without a `window` that has `addEventListener`, and for a listener another entry already installed.
 */
export function installPageErrors(stops: Stops, { errors = true, rejections = true, skip }: PageErrorOptions = {}): void {
  if (!hasPageEvents()) return;
  if (errors) {
    once(stops, FLAG_ERROR, "error", skip, (event: ErrorEvent, slot) => {
      if (skipped(slot, event.error)) return;
      captureException(
        event.error || event.message,
        // With no error of its own, the event's place is the one frame: the SDK has none to give.
        withHint({ filename: typeof event.filename === "string" ? frameFilename(event.filename) : event.filename, lineno: event.lineno, colno: event.colno }, crash("onerror", undefined, eventFrame(event))),
      );
    });
  }
  if (rejections) {
    once(stops, FLAG_REJECTION, "unhandledrejection", skip, (event: PromiseRejectionEvent, slot) => {
      if (skipped(slot, event.reason)) return;
      captureException(event.reason, withHint({}, crash("onunhandledrejection", undefined, "none")));
    });
  }
}

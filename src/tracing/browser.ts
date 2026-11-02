/**
 * Browser root transactions (CSL-5584): one `pageload` transaction for the document and one `navigation`
 * transaction per client-side route change, so `fetch` calls made outside any `startSpan` still land in a trace.
 *
 * A root stays the active span until it goes idle (no open child span for `idleTimeout` ms) or `finalTimeout`
 * ms pass, whichever is first. A route change ends the current root and starts the next. Routes are detected by
 * patching `history.pushState` / `replaceState` and listening to `popstate`; a change counts only when
 * `location.pathname` differs, so a query-only or same-path update does not split the trace.
 */

import { releaseTrace, setStandingRoot } from "./context";
import { startTransaction } from "./index";
import type { Span, Transaction } from "./span";
import { observeWebVitals, type WebVitals, type WebVitalsObserver } from "./web-vitals";

export type RootKind = "pageload" | "navigation";

export interface BrowserTracingOptions {
  /** Ms with no open child span before a root ends. Default 1000. */
  idleTimeout?: number;
  /** Ms after which a root ends regardless of open spans, which are ended `cancelled`. Default 30000. */
  finalTimeout?: number;
  /** Names a root from its pathname, e.g. `/orders/42` to `/orders/:id`. Return nothing to keep the pathname. */
  routeName?: (pathname: string, kind: RootKind) => string | undefined;
  /**
   * Called with a pageload transaction just before it ends, while it can still be changed, after LCP, INP, CLS,
   * TTFB and FCP have been recorded on it. INP and CLS are a snapshot taken at this moment, not final values: they
   * settle when the page is hidden, which is usually after the pageload ends. On hide the final INP and CLS go out
   * as a small `web-vitals` transaction in the pageload's trace (see `FINAL_VITALS_OP`).
   */
  onPageloadEnd?: (transaction: Transaction) => void;
}

/** Op of the one extra transaction sent on page hide: its `parent_span_id` is the pageload root, same `trace_id`. */
export const FINAL_VITALS_OP = "web-vitals";
const DEFAULT_IDLE_TIMEOUT = 1000;
const DEFAULT_FINAL_TIMEOUT = 30000;
const HISTORY_PATCHED = Symbol.for("@codmir/sdk.history-patched");

type PatchedHistoryFn = History["pushState"] & { [HISTORY_PATCHED]?: History["pushState"] };

let teardownActive: (() => void) | undefined;

function pageloadStart(): number {
  const origin = typeof performance !== "undefined" ? performance.timeOrigin : undefined;
  if (typeof origin === "number" && origin > 0) return origin;
  const nav = (typeof performance !== "undefined" ? (performance as { timing?: { navigationStart?: number } }).timing : undefined)
    ?.navigationStart;
  return nav && nav > 0 ? nav : Date.now();
}

/**
 * Starts pageload and navigation transactions. Browser only: returns a no-op outside one. Calling it again
 * while active also returns a no-op, so only the first caller can tear it down. The returned function ends the
 * current root, unpatches history and removes the listeners.
 */
export function startBrowserTracing(options: BrowserTracingOptions = {}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  if (teardownActive) return () => {};

  const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
  const finalTimeout = options.finalTimeout ?? DEFAULT_FINAL_TIMEOUT;

  let current: { tx: Transaction; finish: (endTimeMs?: number) => void } | undefined;
  let lastPath = window.location.pathname;
  const vitals: WebVitalsObserver = observeWebVitals();
  // What the finished pageload carried, so the hide send can say what changed since. Set when the pageload ends.
  let pageload: { traceparent: string; name: string; inp?: number; cls?: number } | undefined;
  let hideHandled = false;

  function begin(kind: RootKind, ready: boolean): void {
    const pathname = window.location.pathname;
    const tx = startTransaction({
      op: kind,
      name: options.routeName?.(pathname, kind) || pathname,
      startTime: kind === "pageload" ? pageloadStart() : undefined,
      data: { url: window.location.href },
    });
    const open = new Set<Span>();
    let lastActivity = Date.now();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let isReady = ready;
    let done = false;

    const finish = (endTimeMs?: number): void => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(finalTimer);
      for (const span of open) {
        span.setStatus("cancelled");
        span.end(endTimeMs);
      }
      open.clear();
      // A startSpan whose promise never settles is still on the context stack: end it as cancelled, and drop it so
      // the next root starts clean.
      for (const span of releaseTrace(tx)) {
        if (span.isEnded) continue;
        span.setStatus("cancelled");
        span.end(endTimeMs);
      }
      if (kind === "pageload") {
        const snapshot = vitals.read();
        for (const [name, value] of Object.entries(snapshot)) tx.setMeasurement(name as keyof WebVitals, value);
        pageload = { traceparent: tx.toTraceparent(), name: tx.name, inp: snapshot.inp, cls: snapshot.cls };
        options.onPageloadEnd?.(tx);
      }
      tx.end(endTimeMs);
      if (current?.tx === tx) {
        current = undefined;
        setStandingRoot(undefined);
      }
    };

    const heartbeat = (): void => {
      clearTimeout(idleTimer);
      if (done || !isReady || open.size > 0) return;
      idleTimer = setTimeout(() => finish(lastActivity), idleTimeout);
    };

    // Only direct children matter: a child's own children end before it does, in any code that nests properly.
    const startChild = tx.startChild.bind(tx);
    tx.startChild = (childOptions) => {
      const child = startChild(childOptions);
      open.add(child);
      lastActivity = Date.now();
      clearTimeout(idleTimer);
      const end = child.end.bind(child);
      child.end = (endTimeMs?: number) => {
        end(endTimeMs);
        if (open.delete(child)) {
          lastActivity = Date.now();
          heartbeat();
        }
      };
      return child;
    };

    const finalTimer = setTimeout(() => finish(), finalTimeout);
    current = { tx, finish };
    setStandingRoot(tx);

    if (kind === "pageload" && !ready) {
      const onLoad = (): void => {
        isReady = true;
        lastActivity = Date.now();
        heartbeat();
      };
      window.addEventListener("load", onLoad, { once: true });
    } else {
      heartbeat();
    }
  }

  const onRouteChange = (): void => {
    const pathname = window.location.pathname;
    if (pathname === lastPath) return;
    lastPath = pathname;
    current?.finish();
    begin("navigation", true);
  };

  // Page hidden, once per page: INP and CLS are final now. A pageload still open ends here and carries them itself;
  // after it, a `web-vitals` transaction in its trace sends them when they moved. Registered on `window` in the
  // capture phase so it runs before the client's own document-level flush and its event is already queued.
  const onHide = (): void => {
    if (hideHandled || document.visibilityState !== "hidden") return;
    hideHandled = true;
    if (!pageload) {
      current?.finish();
      return;
    }
    const final = vitals.read();
    if (final.inp === pageload.inp && final.cls === pageload.cls) return;
    const tx = startTransaction({ op: FINAL_VITALS_OP, name: pageload.name, traceparent: pageload.traceparent });
    if (final.inp !== undefined) tx.setMeasurement("inp", final.inp);
    if (final.cls !== undefined) tx.setMeasurement("cls", final.cls);
    tx.end();
  };
  window.addEventListener("visibilitychange", onHide, true);

  const restore: Array<() => void> = [];
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method] as PatchedHistoryFn;
    if (original[HISTORY_PATCHED]) continue;
    const patched: PatchedHistoryFn = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      onRouteChange();
      return result;
    };
    patched[HISTORY_PATCHED] = original;
    window.history[method] = patched;
    restore.push(() => {
      if (window.history[method] === patched) window.history[method] = original;
    });
  }
  window.addEventListener("popstate", onRouteChange);

  begin("pageload", document.readyState === "complete");

  const teardown = (): void => {
    if (teardownActive !== teardown) return;
    teardownActive = undefined;
    current?.finish();
    vitals.stop();
    window.removeEventListener("popstate", onRouteChange);
    window.removeEventListener("visibilitychange", onHide, true);
    for (const undo of restore) undo();
  };
  teardownActive = teardown;
  return teardown;
}

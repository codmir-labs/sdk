/**
 * Browser root transactions: one `pageload` transaction for the document and one `navigation`
 * transaction per client-side route change, so `fetch` calls made outside any `startSpan` still land in a trace.
 *
 * A root stays the active span until it goes idle (no open child span for `idleTimeout` ms) or `finalTimeout`
 * ms pass, whichever is first. A route change ends the current root and starts the next. Routes are detected by
 * patching `history.pushState` / `replaceState` and listening to `popstate`; a change counts only when
 * `location.pathname` differs, so a query-only or same-path update does not split the trace.
 */

import { releaseTrace, setStandingRoot } from "./context";
import { isLive, listen, Stops, type Installed } from "../overseer/lifecycle";
import { routeFragment, scrubUrl } from "../overseer/url-scrub";
import { startTransaction } from "./index";
import type { Span, Transaction } from "./span";
import { observeWebVitals, type WebVitals, type WebVitalsObserver } from "./web-vitals";

/** The page's origin with a renamed route as its path: a rename never leaves the raw path in `data.url`. */
function routeUrl(route: string): string {
  const path = route.startsWith("/") ? route : `/${route}`;
  try {
    const u = new URL(window.location.href);
    return `${u.origin === "null" ? `${u.protocol}//` : u.origin}${path}`;
  } catch {
    return path;
  }
}

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

type PatchedHistoryFn = History["pushState"] & { [HISTORY_PATCHED]?: Installed };

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
  // No window, document or location (React Native, a worker, a server bundle): no pageload, no throw.
  if (typeof window === "undefined" || typeof document === "undefined" || !window.location) return () => {};
  if (teardownActive) return () => {};

  const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
  const finalTimeout = options.finalTimeout ?? DEFAULT_FINAL_TIMEOUT;

  const stops = new Stops();
  let current: { tx: Transaction; finish: (endTimeMs?: number) => void } | undefined;
  // The path and the route fragment: a hash router moves only the fragment, and that is a navigation too.
  const routeKey = (): string => `${window.location.pathname}${routeFragment(window.location.hash)}`;
  let lastPath = routeKey();
  const vitals: WebVitalsObserver = observeWebVitals();
  // What the finished pageload carried, so the hide send can say what changed since. Set when the pageload ends.
  let pageload: { traceparent: string; name: string; inp?: number; cls?: number } | undefined;
  let hideHandled = false;

  function begin(kind: RootKind, ready: boolean): void {
    const pathname = window.location.pathname;
    const route = options.routeName?.(pathname, kind) || undefined;
    const tx = startTransaction({
      op: kind,
      name: route || pathname,
      startTime: kind === "pageload" ? pageloadStart() : undefined,
      data: { url: route ? routeUrl(route) : scrubUrl(window.location.href) },
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
      stops.add(listen(window, "load", onLoad, { once: true }));
    } else {
      heartbeat();
    }
  }

  const onRouteChange = (): void => {
    const key = routeKey();
    if (key === lastPath) return;
    lastPath = key;
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
  stops.add(listen(window, "visibilitychange", onHide, true));

  // A patch that another copy of the SDK put over this one stays in place, passing the calls on, once this one ends.
  const history = window.history as History | undefined;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history?.[method] as PatchedHistoryFn | undefined;
    if (!history || typeof original !== "function" || isLive(original, HISTORY_PATCHED)) continue;
    const installed: Installed = { active: true };
    const patched: PatchedHistoryFn = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      if (installed.active) onRouteChange();
      return result;
    };
    patched[HISTORY_PATCHED] = installed;
    history[method] = patched;
    stops.add(() => {
      installed.active = false;
      if (history[method] === patched) history[method] = original;
    });
  }
  stops.add(listen(window, "popstate", onRouteChange));

  begin("pageload", document.readyState === "complete");

  const teardown = (): void => {
    if (teardownActive !== teardown) return;
    teardownActive = undefined;
    current?.finish();
    vitals.stop();
    stops.run();
  };
  teardownActive = teardown;
  return teardown;
}

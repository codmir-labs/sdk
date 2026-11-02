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

export type RootKind = "pageload" | "navigation";

export interface BrowserTracingOptions {
  /** Ms with no open child span before a root ends. Default 1000. */
  idleTimeout?: number;
  /** Ms after which a root ends regardless of open spans, which are ended `cancelled`. Default 30000. */
  finalTimeout?: number;
  /** Names a root from its pathname, e.g. `/orders/42` to `/orders/:id`. Return nothing to keep the pathname. */
  routeName?: (pathname: string, kind: RootKind) => string | undefined;
  /**
   * Called with a pageload transaction just before it ends, while it can still be changed. Hook point for web
   * vitals (CSL-5587); nothing calls it with measurements yet.
   */
  onPageloadEnd?: (transaction: Transaction) => void;
}

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
      if (kind === "pageload") options.onPageloadEnd?.(tx);
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
    window.removeEventListener("popstate", onRouteChange);
    for (const undo of restore) undo();
  };
  teardownActive = teardown;
  return teardown;
}

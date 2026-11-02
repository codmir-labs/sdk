/** The "active span": which span new spans and fetches nest under. */

import type { Span } from "./span";

/** How the "active span" is stored. The one Node strategy is AsyncLocalStorage, installed once by `installNodeTracingContext` in server.ts. */
export interface ContextStrategy {
  get(): Span | undefined;
  run<T>(span: Span, fn: () => T): T;
  /** Drops every span of `traceId` still held, returning them. Only the browser's stack holds spans past their `fn`. */
  release?(traceId: string): Span[];
}

/**
 * Default for browsers, which have no async context: a stack. A span stays on it until `fn` returns, or, when
 * `fn` returns a promise, until that settles, so code after an `await` still nests. Two flows running at once
 * can therefore see each other's span; on Node, the first request through any server wrapper installs AsyncLocalStorage instead (`installNodeTracingContext`).
 */
function stackStrategy(): ContextStrategy {
  const stack: Span[] = [];
  const remove = (span: Span): void => {
    const i = stack.lastIndexOf(span);
    if (i >= 0) stack.splice(i, 1);
  };
  return {
    get: () => stack[stack.length - 1],
    release(traceId) {
      const dropped = stack.filter((span) => span.traceId === traceId);
      for (const span of dropped) remove(span);
      return dropped;
    },
    run(span, fn) {
      stack.push(span);
      let result: ReturnType<typeof fn>;
      try {
        result = fn();
      } catch (err) {
        remove(span);
        throw err;
      }
      if (isThenable(result)) {
        const done = (): void => remove(span);
        result.then(done, done);
      } else {
        remove(span);
      }
      return result;
    },
  };
}

let strategy: ContextStrategy = stackStrategy();

export function setContextStrategy(next: ContextStrategy): void {
  strategy = next;
}

/**
 * Drops from the context every span still held for `root`'s trace and returns them, so a `startSpan` whose promise
 * never settles cannot stay active once its transaction has ended. A no-op where the strategy holds nothing
 * (AsyncLocalStorage on Node).
 */
export function releaseTrace(root: Span): Span[] {
  return strategy.release?.(root.traceId) ?? [];
}

/** A root that stays active until cleared, for the browser's pageload and navigation transactions. */
let standingRoot: Span | undefined;

export function setStandingRoot(span: Span | undefined): void {
  standingRoot = span;
}

/** The span in scope, else the standing root, so work started outside any `startSpan` still nests under the page. */
export function getActiveSpan(): Span | undefined {
  return strategy.get() ?? standingRoot;
}

/** Runs `fn` with `span` as the active span, without ending it. */
export function withActiveSpan<T>(span: Span, fn: () => T): T {
  return strategy.run(span, fn);
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

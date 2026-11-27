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

/**
 * The strategy, the default stack and the standing root are one per process, in `Symbol.for` slots: a bundler may load
 * this module more than once (Next.js: instrumentation and each route; each entry point of this package is its own file
 * too), and a span made active by one copy must be the active span of the others, error capture included.
 */
const STRATEGY_SLOT = Symbol.for("codmir.tracing.strategy");
const DEFAULT_SLOT = Symbol.for("codmir.tracing.default");
const ROOT_SLOT = Symbol.for("codmir.tracing.root");
const slots = globalThis as Record<symbol, unknown>;
const strategy = (): ContextStrategy =>
  (slots[STRATEGY_SLOT] as ContextStrategy | undefined) ??
  ((slots[DEFAULT_SLOT] as ContextStrategy | undefined) ?? (slots[DEFAULT_SLOT] = stackStrategy())) as ContextStrategy;

export function setContextStrategy(next: ContextStrategy): void {
  slots[STRATEGY_SLOT] = next;
}

/**
 * Drops from the context every span still held for `root`'s trace and returns them, so a `startSpan` whose promise
 * never settles cannot stay active once its transaction has ended. A no-op where the strategy holds nothing
 * (AsyncLocalStorage on Node).
 */
export function releaseTrace(root: Span): Span[] {
  return strategy().release?.(root.traceId) ?? [];
}

/** A root that stays active until cleared, for the browser's pageload and navigation transactions. */
export function setStandingRoot(span: Span | undefined): void {
  slots[ROOT_SLOT] = span;
}

/** The span in scope, else the standing root, so work started outside any `startSpan` still nests under the page. */
export function getActiveSpan(): Span | undefined {
  return strategy().get() ?? (slots[ROOT_SLOT] as Span | undefined);
}

/** Runs `fn` with `span` as the active span, without ending it. */
export function withActiveSpan<T>(span: Span, fn: () => T): T {
  return strategy().run(span, fn);
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

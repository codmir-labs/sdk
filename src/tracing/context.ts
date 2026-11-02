/** The "active span": which span new spans and fetches nest under. */

import type { Span } from "./span";

/** How the "active span" is stored. Node entry points swap in AsyncLocalStorage; see `setContextStrategy`. */
export interface ContextStrategy {
  get(): Span | undefined;
  run<T>(span: Span, fn: () => T): T;
}

/**
 * Default for browsers, which have no async context: a stack. A span stays on it until `fn` returns, or, when
 * `fn` returns a promise, until that settles, so code after an `await` still nests. Two flows running at once
 * can therefore see each other's span; on Node, `@codmir/sdk/express` installs AsyncLocalStorage instead.
 */
function stackStrategy(): ContextStrategy {
  const stack: Span[] = [];
  const remove = (span: Span): void => {
    const i = stack.lastIndexOf(span);
    if (i >= 0) stack.splice(i, 1);
  };
  return {
    get: () => stack[stack.length - 1],
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

export function getActiveSpan(): Span | undefined {
  return strategy.get();
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

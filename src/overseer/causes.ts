import { normalizeThrown } from "./thrown-value";
import { parseStackTrace } from "./stack";
import type { ExceptionCause } from "./index";

/** Entries kept in all, the deepest path followed, and inner errors read from one `AggregateError`. */
export const MAX_CAUSES = 10;
export const MAX_CAUSE_DEPTH = 5;
export const MAX_AGGREGATE_ERRORS = 10;
/** Frames kept per entry. */
export const MAX_CAUSE_FRAMES = 30;

const isErrorObject = (value: unknown): value is Error =>
  value instanceof Error || (value !== null && typeof value === "object" && Object.prototype.toString.call(value) === "[object Error]");

/** An `AggregateError`, a subclass of it, or one from another realm: only its `errors` are inner errors, any other error's are its own data. */
const isAggregateError = (value: unknown): boolean =>
  (typeof AggregateError === "function" && value instanceof AggregateError) || read(value as object, "name") === "AggregateError";

/** A property read that never throws: a getter on an error may. */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The error a captured value holds (an `ErrorEvent`, a `PromiseRejectionEvent`), as `normalizeThrown` unwraps it; else the value. */
function unwrap(value: unknown): unknown {
  for (let i = 0; i < 3 && value !== null && typeof value === "object" && !isErrorObject(value); i++) {
    const error = read(value, "error");
    const reason = read(value, "reason");
    if (error !== null && typeof error === "object") value = error;
    else if (reason !== undefined && "promise" in value) value = reason;
    else break;
  }
  return value;
}

/**
 * The errors behind `thrown`, breadth first over `cause` and, on an `AggregateError` only, `errors`, in walk order.
 * Cycle-safe by object identity; at most {@link MAX_CAUSE_DEPTH} deep along a path, {@link MAX_AGGREGATE_ERRORS}
 * inner errors per aggregate and {@link MAX_CAUSES} entries. A cause that is not an error goes through
 * `normalizeThrown`. Frames use `appOrigins` like the top exception's. Returns `undefined` when there is nothing to walk.
 */
export function collectCauses(thrown: unknown, appOrigins?: string[]): ExceptionCause[] | undefined {
  const top = unwrap(thrown);
  if (!isErrorObject(top)) return undefined;

  const out: ExceptionCause[] = [];
  const seen = new Set<unknown>([top]);
  const queue: Array<{ node: unknown; index: number; depth: number }> = [{ node: top, index: -1, depth: 0 }];

  for (let head = 0; head < queue.length && out.length < MAX_CAUSES; head++) {
    const { node, index, depth } = queue[head]!;
    if (depth >= MAX_CAUSE_DEPTH || !isErrorObject(node)) continue;

    const children: Array<{ value: unknown; source: string }> = [];
    const cause = read(node, "cause");
    if (cause !== undefined && cause !== null) children.push({ value: cause, source: "cause" });
    const errors = isAggregateError(node) ? read(node, "errors") : undefined;
    if (Array.isArray(errors)) {
      errors.slice(0, MAX_AGGREGATE_ERRORS).forEach((value, i) => children.push({ value, source: `errors[${i}]` }));
    }

    for (const child of children) {
      if (out.length >= MAX_CAUSES) break;
      if (child.value !== null && typeof child.value === "object") {
        if (seen.has(child.value)) continue;
        seen.add(child.value);
      }
      const err = normalizeThrown(child.value);
      const frames = parseStackTrace(err.stack, appOrigins).slice(0, MAX_CAUSE_FRAMES);
      out.push({
        type: err.name,
        value: err.message,
        ...(frames.length ? { stacktrace: frames } : {}),
        source: child.source,
        parent: index,
      });
      queue.push({ node: child.value, index: out.length - 1, depth: depth + 1 });
    }
  }
  return out.length ? out : undefined;
}

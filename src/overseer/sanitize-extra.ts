/**
 * CSL-5639: the one place an event's `extra` is cleaned, at the core `captureException` boundary, so an integration
 * (or a caller) can never put a request, its headers, cookies, authorization, query, params or body on the wire.
 * What is wanted from a request is `event.request` (origin, path, method) and a route pattern, set elsewhere.
 *
 * Dropped, at any depth: a key matching {@link SENSITIVE_KEY}; a key that names request data ({@link REQUEST_KEYS});
 * a `Request`, `Headers`, `URLSearchParams` or `FormData` value; and any object that looks like a request (it has
 * `headers` and a `method` or `url`). Everything else is kept as it was. Depth is capped and cycles are cut.
 */

export const SENSITIVE_KEY = /cookie|authorization|set-cookie|token|secret|password/i;
const REQUEST_KEYS = new Set(["request", "req", "headers", "header", "cookies", "query", "querystring", "query_string", "params", "body", "rawbody", "formdata"]);
const MAX_DEPTH = 6;

function isRequestLike(value: object): boolean {
  const g = globalThis as Record<string, unknown>;
  for (const name of ["Request", "Headers", "URLSearchParams", "FormData"]) {
    const ctor = g[name];
    if (typeof ctor === "function" && value instanceof (ctor as new () => object)) return true;
  }
  const o = value as Record<string, unknown>;
  return "headers" in o && ("method" in o || "url" in o);
}

function clean(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isRequestLike(value)) return undefined;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((v) => clean(v, depth + 1, seen)).filter((v) => v !== undefined);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // Date, Error, Map, class instances: kept as they are
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || REQUEST_KEYS.has(key.toLowerCase())) continue;
    const cleaned = clean(v, depth + 1, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** A copy of `context` safe to send as `extra`. The container itself is never judged, only its entries. */
export function sanitizeExtra(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {};
  const seen = new WeakSet<object>([context]);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(context)) {
    if (SENSITIVE_KEY.test(key) || REQUEST_KEYS.has(key.toLowerCase())) continue;
    const cleaned = clean(v, 1, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

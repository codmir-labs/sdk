import { isSecretKey } from "./secret-keys";
import { scrubUrl } from "./url-scrub";

/**
 * The one place an event's `extra` is cleaned, at the core `captureException` boundary, so an integration
 * (or a caller) can never put a request, its headers, cookies, authorization, query, params or body on the wire.
 * What is wanted from a request is `event.request` (origin, path, method) and a route pattern, set elsewhere.
 *
 * Dropped, at any depth: a key that names a secret ({@link isSecretKey}); a key that names request data ({@link REQUEST_KEYS});
 * a `Request`, `Headers`, `URLSearchParams` or `FormData` value; and any object that looks like a request (it has
 * `headers` and a `method` or `url`). An `Error` becomes `{ name, message, cause }`, a `URL` its origin and path, and a
 * class instance its `toJSON()` or its own properties, each cleaned by the same rules. A `Date`, `Map`, `Set`, typed array
 * and the like are kept as they are. Depth is capped and cycles are cut.
 */

const REQUEST_KEYS = new Set(["request", "req", "headers", "header", "cookies", "query", "querystring", "query_string", "params", "body", "rawbody", "formdata"]);
const MAX_DEPTH = 6;
/** Built-in objects that are kept as they are: they hold no field a secret could sit in by name. */
const KEPT_TAGS = new Set(["[object Date]", "[object RegExp]", "[object Map]", "[object Set]", "[object WeakMap]", "[object WeakSet]", "[object Promise]", "[object ArrayBuffer]", "[object SharedArrayBuffer]"]);

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
  if (proto !== Object.prototype && proto !== null) {
    if (KEPT_TAGS.has(Object.prototype.toString.call(value)) || ArrayBuffer.isView(value)) return value;
    seen.add(value);
    return cleanInstance(value, depth, seen);
  }
  seen.add(value);
  // A plain object with a `toJSON` is written by it, so what it returns is what must be cleaned.
  return typeof (value as { toJSON?: unknown }).toJSON === "function" ? cleanInstance(value, depth, seen) : cleanEntries(value, depth, seen);
}

function cleanEntries(value: object, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (isSecretKey(key) || REQUEST_KEYS.has(key.toLowerCase()) || key === "toJSON") continue;
    const cleaned = clean(v, depth + 1, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** An `Error`, a `URL` or any other class instance, as a value that holds no secret field. */
function cleanInstance(value: object, depth: number, seen: WeakSet<object>): unknown {
  try {
    if (value instanceof Error) {
      const out: Record<string, unknown> = { name: value.name, message: value.message };
      const cause = (value as { cause?: unknown }).cause;
      if (cause !== undefined) {
        const cleaned = clean(cause, depth + 1, seen);
        if (cleaned !== undefined) out.cause = cleaned;
      }
      return out;
    }
    if (typeof URL === "function" && value instanceof URL) return scrubUrl(value);
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      const json: unknown = toJSON.call(value);
      if (json !== value) return clean(json, depth + 1, seen);
    }
    return cleanEntries(value, depth, seen);
  } catch {
    return "[Unserializable]";
  }
}

/** A copy of `context` safe to send as `extra`. The container itself is never judged, only its entries. */
export function sanitizeExtra(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {};
  const seen = new WeakSet<object>([context]);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(context)) {
    if (isSecretKey(key) || REQUEST_KEYS.has(key.toLowerCase())) continue;
    const cleaned = clean(v, 1, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

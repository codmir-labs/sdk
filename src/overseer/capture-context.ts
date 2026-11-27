import type { SeverityLevel } from "./index";

/**
 * What `captureException`'s second argument may set on the event, besides `extra`. A plain object that holds only these
 * keys, each with the shape below, is a capture context; any other object is `extra` as a whole.
 */
export type CaptureContext = {
  /** Merged over the client's tags; values are sent as strings. */
  tags?: Record<string, string | number | boolean>;
  /** Merged into the event's `extra`. */
  extra?: Record<string, unknown>;
  level?: SeverityLevel;
  /** The event's group key; a string is a one-item list. */
  fingerprint?: string | string[];
  /** Merged over the client's user. */
  user?: Record<string, unknown>;
  /** Merged over the environment's contexts; `conversation` and `session` stay the SDK's. */
  contexts?: Record<string, Record<string, unknown>>;
};

const KEYS = new Set(["tags", "extra", "level", "fingerprint", "user", "contexts"]);
const LEVELS = new Set(["fatal", "error", "warning", "info", "debug"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The shape check of each field; a value that fails it makes the whole argument `extra`. */
const SHAPES: Record<string, (v: unknown) => boolean> = {
  tags: (v) => isObject(v) && Object.values(v).every((t) => ["string", "number", "boolean"].includes(typeof t)),
  extra: isObject,
  level: (v) => typeof v === "string" && LEVELS.has(v),
  fingerprint: (v) => (typeof v === "string" && v !== "") || (Array.isArray(v) && v.every((p) => typeof p === "string")),
  user: isObject,
  contexts: (v) => isObject(v) && Object.values(v).every(isObject),
};

/** `context` as a capture context, or `undefined` when it is not one (symbol keys, the integration hint, are not counted). */
export function readCaptureContext(context: unknown): CaptureContext | undefined {
  if (!isObject(context)) return undefined;
  const proto = Object.getPrototypeOf(context);
  if (proto !== Object.prototype && proto !== null) return undefined;
  try {
    const keys = Object.keys(context);
    if (!keys.length) return undefined;
    for (const key of keys) {
      if (!KEYS.has(key) || !SHAPES[key]!(context[key])) return undefined;
    }
    return context as CaptureContext;
  } catch {
    // a getter that throws: the argument is data, not a capture context
    return undefined;
  }
}

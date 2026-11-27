import { frameFilename } from "./stack";
import type { CaptureHint } from "./capture-hint";

/**
 * Any value an app throws, as the three things an event needs: a type, a message and a stack. An `Error` (also one from
 * another realm) and an error-like object keep their own name, message and stack. An event gives up the error or reason it
 * holds. A plain object gives its `message` and `name`, else the names of its keys. A primitive is its string. A value that
 * is not an error gets a stack that starts at the app's caller, or none, never inside the SDK.
 */
export interface ThrownError {
  name: string;
  message: string;
  /** The value's own stack; `undefined` when it has none and {@link syntheticStack} must make one. */
  stack: string | undefined;
  /** The value itself, when it was not an error: the caller cleans it into `extra.thrown`. */
  thrown?: unknown;
}

/** Frames between `new Error()` in {@link syntheticStack} and the public function: itself, the caller that asked for the stack, and the public function. */
const SDK_FRAMES = 3;
/** The public function an app called. */
export type Caller = (...args: never[]) => unknown;

const MAX_KEYS = 10;
const MAX_UNWRAP = 3;

const tagOf = (value: object): string => Object.prototype.toString.call(value);
const isFrameLine = (line: string): boolean => /^\s+at\s/.test(line);

function errorLike(value: object): value is { name?: unknown; message: string; stack?: unknown } {
  const v = value as { name?: unknown; message?: unknown; stack?: unknown };
  return typeof v.message === "string" && (typeof v.name === "string" || typeof v.stack === "string");
}

/** The string for a primitive that never throws: a symbol and a BigInt are written, `null` and `undefined` by name. */
function primitiveText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return typeof value;
  }
}

function frameStack(header: string, frames: Exclude<CaptureHint["frames"], undefined>): string {
  if (frames === "none" || !frames.filename) return header;
  const position = frames.lineno === undefined ? "" : `:${frames.lineno}${frames.colno === undefined ? "" : `:${frames.colno}`}`;
  return `${header}\n    at ${frameFilename(frames.filename)}${position}`;
}

/**
 * A stack for an error made here: its header, then the frames from `top`'s caller on. Call it straight from the function
 * `top` called (the count of frames it drops for engines without `Error.captureStackTrace` assumes that).
 */
export function syntheticStack(name: string, message: string, top: Caller, frames: CaptureHint["frames"]): string | undefined {
  const header = `${name}: ${message}`;
  if (frames) return frameStack(header, frames);
  const target = new Error(message);
  target.name = name;
  if (typeof Error.captureStackTrace === "function") {
    // Omits `top` and everything above it. A `top` that is not on the stack leaves it empty: then count instead.
    Error.captureStackTrace(target, top);
    if (target.stack && target.stack.split("\n").some(isFrameLine)) return target.stack;
  }
  const lines = (new Error(message).stack ?? "").split("\n");
  const first = lines.findIndex(isFrameLine);
  // V8 prints a header before its frames; Firefox and Safari print frames only.
  const start = first < 0 ? 0 : first;
  return [...(first < 0 ? [] : lines.slice(0, start)), ...lines.slice(start + SDK_FRAMES)].join("\n");
}

export function normalizeThrown(value: unknown, depth = 0): ThrownError {
  try {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ?? "" };
    if (value !== null && typeof value === "object") return normalizeObject(value, depth);
  } catch {
    // a getter that throws: the value is written by its string below
  }
  const message = value !== null && typeof value === "object" ? "Object captured" : primitiveText(value);
  return { name: "Error", message, stack: undefined };
}

function normalizeObject(value: object, depth: number): ThrownError {
  const tag = tagOf(value);
  const holder = value as { error?: unknown; reason?: unknown; promise?: unknown };
  if (depth < MAX_UNWRAP) {
    // An `ErrorEvent`, or anything that holds an error.
    if (holder.error instanceof Error || (holder.error && typeof holder.error === "object" && (tagOf(holder.error) === "[object Error]" || errorLike(holder.error)))) {
      return normalizeThrown(holder.error, depth + 1);
    }
    // A `PromiseRejectionEvent`: its reason, which is normalized in turn. A bare `reason` key is the app's own data.
    if ("reason" in value && (tag === "[object PromiseRejectionEvent]" || "promise" in value)) {
      return normalizeThrown(holder.reason, depth + 1);
    }
  }
  // An `Error` of another realm, or an object that reads as one.
  if (tag === "[object Error]" || errorLike(value)) {
    const e = value as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof e.name === "string" && e.name ? e.name : "Error";
    const message = typeof e.message === "string" ? e.message : "";
    if (typeof e.stack === "string") return { name, message, stack: e.stack };
    return { name, message, stack: undefined, thrown: value };
  }
  // What the value is, from its tag: `Object` for a plain object, else `Event`, `Response` and the like.
  const kind = tag.slice(8, -1) || "Object";
  // An event that holds no error and no reason (a failed image or script load): its type says what happened.
  const eventType = (value as { type?: unknown }).type;
  if (kind.endsWith("Event") && typeof eventType === "string") {
    return { name: kind, message: `${kind} captured: ${eventType}`, stack: undefined };
  }
  const o = value as { name?: unknown; message?: unknown };
  const keys = Object.keys(value).slice(0, MAX_KEYS);
  const message = typeof o.message === "string" ? o.message : keys.length ? `${kind} captured with keys: ${keys.join(", ")}` : `${kind} captured with no keys`;
  const name = typeof o.name === "string" && o.name ? o.name : "Error";
  return { name, message, stack: undefined, thrown: value };
}

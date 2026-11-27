/**
 * An internal note an integration attaches to the context it passes to `captureException`: how the error reached the
 * SDK (its mechanism, and whether the app handled it) and, optionally, its level. It rides under a registry symbol, so
 * it works across the copies of this module a bundler makes, and `Object.entries` never sees it: it can not reach `extra`.
 * Not part of the public API; a caller's own `handled` or `mechanism` keys stay plain data.
 */
export const CAPTURE_HINT = Symbol.for("codmir.capture.hint");

export interface CaptureHint {
  mechanism: { type: string; handled: boolean };
  level?: "fatal" | "error" | "warning" | "info" | "debug";
  /**
   * What stack a thrown value that is not an error gets. A global handler knows the SDK made it up: `"none"`, or the one
   * frame the event itself names. Without it the stack starts at the caller of `captureException`. An error keeps its own stack.
   */
  frames?: "none" | { filename: string; lineno?: number; colno?: number };
}

const LEVELS = new Set(["fatal", "error", "warning", "info", "debug"]);

/** `context` with the hint attached; the other keys are kept as they are. */
export function withHint(context: Record<string, unknown> | undefined, hint: CaptureHint): Record<string, unknown> {
  return { ...context, [CAPTURE_HINT]: hint };
}

/** The hint on a context, checked field by field; `undefined` when there is none or it is malformed. */
export function readHint(context: Record<string, unknown> | undefined): CaptureHint | undefined {
  const raw = context ? (context as Record<symbol, unknown>)[CAPTURE_HINT] : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const { mechanism, level, frames } = raw as { mechanism?: { type?: unknown; handled?: unknown }; level?: unknown; frames?: unknown };
  if (!mechanism || typeof mechanism.type !== "string" || typeof mechanism.handled !== "boolean") return undefined;
  return {
    mechanism: { type: mechanism.type, handled: mechanism.handled },
    ...(typeof level === "string" && LEVELS.has(level) ? { level: level as CaptureHint["level"] } : {}),
    ...(framesOf(frames) ? { frames: framesOf(frames) } : {}),
  };
}

function framesOf(raw: unknown): CaptureHint["frames"] {
  if (raw === "none") return "none";
  if (!raw || typeof raw !== "object") return undefined;
  const { filename, lineno, colno } = raw as { filename?: unknown; lineno?: unknown; colno?: unknown };
  if (typeof filename !== "string" || !filename) return "none";
  return {
    filename,
    ...(typeof lineno === "number" && lineno > 0 ? { lineno } : {}),
    ...(typeof colno === "number" && colno > 0 ? { colno } : {}),
  };
}

/** An unhandled crash: `handled: false` under the integration's own mechanism name. */
export function crash(type: string, level?: CaptureHint["level"], frames?: CaptureHint["frames"]): CaptureHint {
  return { mechanism: { type, handled: false }, ...(level ? { level } : {}), ...(frames ? { frames } : {}) };
}

/** The one frame a window `error` event names (where the script failed), `"none"` when it names no file. */
export function eventFrame(event: { filename?: unknown; lineno?: unknown; colno?: unknown }): NonNullable<CaptureHint["frames"]> {
  return typeof event.filename === "string" && event.filename
    ? { filename: event.filename, ...(typeof event.lineno === "number" ? { lineno: event.lineno } : {}), ...(typeof event.colno === "number" ? { colno: event.colno } : {}) }
    : "none";
}
